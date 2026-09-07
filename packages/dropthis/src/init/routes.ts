/**
 * Workers Routes on the zone, and why `init` cares (issue #25).
 *
 * Cloudflare gives a matching **Route** precedence over a **Custom Domain**.
 * A zone that already carries `*.example.com/*` -> some other Worker keeps
 * answering from that Worker after `init` attaches `drops.example.com` as a
 * Custom Domain — the instance is deployed, healthy and completely
 * unreachable on its own hostname. Not a theoretical hazard: it cost the
 * owner a milestone run twice, on `damjan.dropthis.app` and
 * `demo.dropthis.app`.
 *
 * The fix is the one Cloudflare intends: a MORE SPECIFIC route wins, so
 * `<hostname>/*` -> this instance's Worker beats `*.zone/*` -> anything. The
 * shadowing route is never modified and never deleted — it is someone else's,
 * and this module only ever adds one route of its own.
 *
 * Matching is deliberately conservative: only the HOST half of the pattern is
 * compared, so a pattern that could match the hostname on ANY path counts as a
 * shadow. A false positive costs one extra route that changes nothing (a more
 * specific foreign pattern still wins for its own paths); a false negative
 * leaves the operator with a dead domain and no diagnosis.
 */
import type Cloudflare from "cloudflare";

export type RouteStepStatus = "ok" | "created" | "would_create" | "error";
export type RouteResult = { status: RouteStepStatus; detail: string };

/**
 * Does this route pattern's host half cover `hostname`?
 *
 * Cloudflare's grammar is `<host>[/<path>]` with `*` standing for any run of
 * characters. Everything else is literal text, so every other character is
 * escaped before the wildcards become `.*` — a pattern is data from a
 * stranger's zone, never a regular expression.
 */
export function hostPatternMatches(pattern: string, hostname: string): boolean {
  const host = pattern.split("/")[0] ?? "";
  if (host.length === 0) return false;
  // A leading `*.` is written for subdomains, but `*` stands for any run of
  // characters INCLUDING none — so the whole prefix is optional and
  // `*.example.com` covers the apex too. Conservative on purpose: this asks
  // "could this pattern match the hostname?", and a false positive costs one
  // route that changes nothing.
  const optionalPrefix = host.startsWith("*.");
  const body = optionalPrefix ? host.slice(2) : host;
  const source = body
    .split("*")
    .map((literal) => literal.replace(/[.+?^${}()|[\]\\]/g, (char) => `\\${char}`))
    .join(".*");
  return new RegExp(`^${optionalPrefix ? "(?:.*\\.)?" : ""}${source}$`).test(hostname);
}

/**
 * What this zone's routes mean for one hostname. The single answer both
 * `init`'s reconcile and `init --check`'s `route_clear` read, so the two can
 * never disagree about what counts as a shadow.
 *
 * - `exact` — `<hostname>/*` pointing at OUR Worker. The only route that beats
 *   a foreign pattern by specificity, and so the only one that means "already
 *   fixed". Our own broad or path-scoped route matches the hostname too, but
 *   Cloudflare has no rule that makes it win over an equally broad foreign
 *   one, so it must not suppress the fix.
 * - `shadow` — the first foreign pattern that could match the hostname.
 * - `conflict` — a foreign route holding `<hostname>/*` itself. Nothing can be
 *   added over it, and foreign routes are never modified.
 */
export type Route = { pattern: string; script: string };
export type RouteClassification = { exact?: Route; shadow?: Route; conflict?: Route };

export function classifyRoutes(
  routes: Route[],
  hostname: string,
  worker: string,
): RouteClassification {
  const wanted = ourPattern(hostname);
  const matching = routes.filter((route) => hostPatternMatches(route.pattern, hostname));
  const exact = matching.find((route) => route.pattern === wanted && route.script === worker);
  const shadow = matching.find((route) => route.script !== worker);
  const conflict = matching.find((route) => route.pattern === wanted && route.script !== worker);
  return {
    ...(exact === undefined ? {} : { exact }),
    ...(shadow === undefined ? {} : { shadow }),
    ...(conflict === undefined ? {} : { conflict }),
  };
}

/** The route this instance needs, and the phrase every step detail is built from. */
const ourPattern = (hostname: string): string => `${hostname}/*`;
const arrow = (hostname: string, worker: string): string => `${ourPattern(hostname)} → ${worker}`;

/**
 * Add `<hostname>/*` -> `<worker>` when — and only when — a foreign route
 * would otherwise shadow the Custom Domain. Never touches a foreign route.
 *
 * An error here is reported, not thrown: the instance itself is fine, and
 * `init` continues to the health poll so the run's record stays honest about
 * what does and does not answer.
 */
export async function reconcileRoute(
  client: Cloudflare,
  zoneId: string,
  hostname: string,
  worker: string,
  options: { dryRun: boolean },
): Promise<RouteResult> {
  let routes: Route[];
  try {
    routes = await listRoutes(client, zoneId);
  } catch (error) {
    return {
      status: "error",
      detail:
        `The Workers Routes on this zone could not be read (${message(error)}). ` +
        `The token needs Workers Routes:Edit. Until then add the route ${arrow(hostname, worker)} ` +
        `by hand, or ${hostname} may keep answering from another Worker.`,
    };
  }

  const { exact, shadow, conflict } = classifyRoutes(routes, hostname, worker);
  if (exact !== undefined) return { status: "ok", detail: `${arrow(hostname, worker)} is already there` };
  if (shadow === undefined) return { status: "ok", detail: "no shadowing route" };

  // Another Worker already holds the exact pattern, so there is nothing more
  // specific left to add and a foreign route is never modified. Say that,
  // rather than blaming a permission the operator would go and fix for nothing.
  if (conflict !== undefined) {
    return {
      status: "error",
      detail:
        `The Workers Route ${conflict.pattern} already sends ${hostname} to ${conflict.script}, ` +
        `so ${hostname} answers from that Worker. dropthis never edits a route it does not own: ` +
        `repoint or delete ${conflict.pattern} in the Cloudflare dashboard, or use another hostname.`,
    };
  }

  const detail = `${arrow(hostname, worker)} (shadowed by ${shadow.pattern} → ${shadow.script})`;
  if (options.dryRun) return { status: "would_create", detail };

  try {
    await client.workers.routes.create({
      zone_id: zoneId,
      pattern: ourPattern(hostname),
      script: worker,
    });
  } catch (error) {
    return {
      status: "error",
      detail:
        `${hostname} is shadowed by the route ${shadow.pattern} → ${shadow.script}, and adding ` +
        `${arrow(hostname, worker)} was refused (${message(error)}). The token needs ` +
        `Workers Routes:Edit; add that route by hand, or ${hostname} will keep answering ` +
        `from ${shadow.script}.`,
    };
  }
  return { status: "created", detail };
}

/** The zone's routes as `{pattern, script}`; a route with no script shadows too. */
export async function listRoutes(client: Cloudflare, zoneId: string): Promise<Route[]> {
  const routes: Route[] = [];
  for await (const route of client.workers.routes.list({ zone_id: zoneId })) {
    routes.push({ pattern: String(route.pattern), script: String(route.script ?? "") });
  }
  return routes;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
