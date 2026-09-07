/**
 * One canonical origin (AGENTS.md, "The drop model"). An instance may answer
 * on several hostnames, but only one of them is the instance's name on the
 * web: OAuth issuer, resource and discovery say it, `/_skill.md` and
 * `/_connect` print it, and drop URLs are built from it.
 *
 * So a readable GET on an alias is moved there rather than answered twice.
 * Only GET and HEAD: a 301 on a POST is a request a client may replay against
 * the wrong origin, and the control plane's writers are all authenticated
 * calls that already carry the origin they meant.
 */
import type { Bucket } from "./bindings.js";
import { loadInstanceConfig } from "./instance-config.js";

/**
 * The instance's identity on the web — the three fields of
 * `system/config.json` that only `init` writes (`operations/config.ts` refuses
 * them to `config set`). Everything else in that file is policy, which is read
 * live because a `config set` must take effect on the next call.
 */
export type InstanceOrigins = {
  canonicalUrl: string;
  aliasOrigins: string[];
  instanceName: string;
};

/**
 * The origin this URL should be answered on, or `null` when it already is the
 * right one. The ONE place that decides whether a hostname is an alias — the
 * redirect and the viewer's trailing-slash move both ask it, so they cannot
 * drift.
 *
 * A hostname in neither `canonical_url` nor `alias_origins` answers `null`: a
 * Route an operator added ahead of a config write is served, never redirected.
 */
export function canonicalOriginFor(origins: InstanceOrigins, url: URL): string | null {
  return origins.aliasOrigins.includes(url.origin) ? origins.canonicalUrl : null;
}

export function aliasRedirect(request: Request, origins: InstanceOrigins): Response | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const url = new URL(request.url);
  const canonical = canonicalOriginFor(origins, url);
  if (canonical === null) return null;
  return movedTo(`${canonical}${url.pathname}${url.search}`);
}

/**
 * Not `Response.redirect`: its headers are immutable, and the noindex
 * middleware still has to stamp this response.
 *
 * `no-cache` for the reason every viewer response carries it: the answer
 * depends on `system/config.json`, and an operator who attaches a custom
 * domain must not be arguing with a browser cache afterwards.
 */
export function movedTo(location: string): Response {
  return new Response(null, {
    status: 301,
    headers: { location, "cache-control": "no-cache, must-revalidate" },
  });
}

/**
 * The viewer needs the origins on EVERY request, and reading
 * `system/config.json` per request would put a third R2 GET on the hot path,
 * against principle 2. So the origins are memoised per isolate with a short
 * TTL (60 s in production, 0 in the dev build).
 *
 * This does not violate "the viewer never trusts a cache for truth": these
 * three fields are instance identity, not drop truth. Only `init` writes them,
 * and `init` always redeploys — which drops every isolate's memo. A stale
 * origin for at most a TTL changes where a redirect points, never what a drop
 * serves.
 */
export function createOriginsMemo(now: () => number = Date.now) {
  // The PENDING read, not only its result: a cold isolate answering a burst —
  // the shape of a drop that was just shared — must cost one R2 GET, not one
  // per request in flight.
  let cached: { value: Promise<InstanceOrigins>; readAt: number } | null = null;

  return async function origins(
    bucket: Bucket,
    requestUrl: string,
    ttlMs: number,
  ): Promise<InstanceOrigins> {
    const at = now();
    if (cached !== null && ttlMs > 0 && at - cached.readAt < ttlMs) return cached.value;

    const pending = read(bucket, requestUrl);
    const entry = { value: pending, readAt: at };
    cached = entry;
    try {
      return await pending;
    } catch (error) {
      // A read that threw is not an answer, so it is not remembered: the next
      // request tries again rather than inheriting a TTL of the same failure.
      if (cached === entry) cached = null;
      throw error;
    }
  };
}

async function read(bucket: Bucket, requestUrl: string): Promise<InstanceOrigins> {
  const config = await loadInstanceConfig(bucket, requestUrl);
  return {
    canonicalUrl: config.canonicalUrl,
    aliasOrigins: config.aliasOrigins,
    instanceName: config.instanceName,
  };
}

export type OriginsMemo = ReturnType<typeof createOriginsMemo>;
