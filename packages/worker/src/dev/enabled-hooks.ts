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
   * Expiry cannot be tested by waiting, so the dev build answers a given
   * instant as "now".
   *
   * A per-request `DEV-Clock` header wins over the deployment-wide `DEV_CLOCK`,
   * for the reason the fault point is per-request too: one deployment then
   * covers every row of the expiry table, and a test can put a live drop and an
   * expired one in the same run without redeploying between them.
   */
  now(env: Env, request?: Request): Date {
    if (env.DEV_ROUTES !== "1") return new Date();

    const header = request?.headers.get("DEV-Clock");
    const at = Date.parse(header ?? env.DEV_CLOCK ?? "");
    return Number.isNaN(at) ? new Date() : new Date(at);
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

  /**
   * `DEV-Access-TTL: <seconds>` on a token request shortens that access token
   * (KV's floor is 60 s), so a test can watch it expire and prove the refresh
   * flow works with no one at the keyboard.
   */
  accessTokenTtl(request: Request, env: Env) {
    if (env.DEV_ROUTES !== "1") return undefined;
    const seconds = Number(request.headers.get("DEV-Access-TTL") ?? "");
    return Number.isInteger(seconds) && seconds >= 60 ? seconds : undefined;
  },
};
