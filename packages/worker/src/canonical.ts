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
import type { InstanceConfig } from "./instance-config.js";

export function aliasRedirect(request: Request, config: InstanceConfig): Response | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const url = new URL(request.url);
  if (!config.aliasOrigins.includes(url.origin)) return null;
  // Not `Response.redirect`: its headers are immutable, and the noindex
  // middleware still has to stamp this response.
  return new Response(null, {
    status: 301,
    headers: { location: `${config.canonicalUrl}${url.pathname}${url.search}` },
  });
}
