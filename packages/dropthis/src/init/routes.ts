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
  const source = host
    .split("*")
    .map((literal) => literal.replace(/[.+?^${}()|[\]\\]/g, (char) => `\\${char}`))
    .join(".*");
  return new RegExp(`^${source}$`).test(hostname);
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
  let routes: Array<{ pattern: string; script: string }>;
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

  const matching = routes.filter((route) => hostPatternMatches(route.pattern, hostname));
  const ours = matching.find((route) => route.script === worker);
  if (ours !== undefined) return { status: "ok", detail: `${arrow(hostname, worker)} is already there` };

  const shadow = matching[0];
  if (shadow === undefined) return { status: "ok", detail: "no shadowing route" };

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
export async function listRoutes(
  client: Cloudflare,
  zoneId: string,
): Promise<Array<{ pattern: string; script: string }>> {
  const routes: Array<{ pattern: string; script: string }> = [];
  for await (const route of client.workers.routes.list({ zone_id: zoneId })) {
    routes.push({ pattern: String(route.pattern), script: String(route.script ?? "") });
  }
  return routes;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
