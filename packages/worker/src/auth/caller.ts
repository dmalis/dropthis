/**
 * Who is calling. One seam, one function — issue #7 replaces the body with the
 * `keyhash/<sha256(key)>` lookup and the two scopes.
 *
 * Until then the dev instance is private (it lives on the maintainer's own
 * account and is never linked), so every caller is the dev admin. The seam
 * exists now so that `created_by` is written from the caller from the first
 * drop onwards and nothing downstream has to change when real keys arrive.
 */
import type { Env } from "../bindings.js";
import type { CreatedBy } from "../domain/meta.js";

export type Caller = CreatedBy & { scope: "admin" | "user" };

/** The identity every drop published on the dev instance is attributed to. */
export const DEV_ADMIN: Caller = { id: "dev", label: "admin", scope: "admin" };

export function resolveCaller(_request: Request, _env: Env): Caller {
  return DEV_ADMIN;
}

/**
 * What gets written into a drop as `created_by` — the id and the label, never
 * the scope. Attribution is a snapshot of who made it, not a permission record:
 * scopes change, and a drop must not carry a stale one forever.
 */
export function attribution(caller: Caller): CreatedBy {
  return { id: caller.id, label: caller.label };
}
