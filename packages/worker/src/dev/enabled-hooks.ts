/**
 * The dev instance's hooks. Imported by `src/dev-entry.ts` only — the
 * production entry point never reaches this module, so the strings below cannot
 * appear in a production bundle.
 *
 * Both hooks refuse to do anything unless the deployed instance also sets
 * `DEV_ROUTES=1`, which is the same runtime gate the `/_dev` probes use.
 */
import type { Env } from "../bindings.js";
import type { DevHooks } from "./hooks.js";

export const DEV_HOOKS: DevHooks = {
  /**
   * Expiry cannot be tested by waiting, so the dev build answers a caller's
   * instant as "now". A `DEV-Clock` header wins, because one contract run moves
   * the clock many times and a redeploy per move is not a test; `DEV_CLOCK`
   * stays as the deployment-wide fallback for the scheduled handler, which has
   * no request to carry a header.
   */
  now(env: Env, request?: Request): Date {
    if (env.DEV_ROUTES !== "1") return new Date();
    const header = request?.headers.get("DEV-Clock");
    return parseInstant(header) ?? parseInstant(env.DEV_CLOCK) ?? new Date();
  },

  /**
   * A per-request fault point (`DEV-Fault: <step>`) rather than a
   * deployment-wide variable: one deployment then covers every step of every
   * write order, and a test can interleave a fault with a clean retry in the
   * same run. The operation decides which step names it understands.
   */
  fault(request: Request, env: Env) {
    if (env.DEV_ROUTES !== "1") return undefined;
    return request.headers.get("DEV-Fault") ?? undefined;
  },
};

/** An RFC 3339 instant, or `null` for anything a clock cannot be set from. */
function parseInstant(value: string | null | undefined): Date | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : new Date(at);
}
