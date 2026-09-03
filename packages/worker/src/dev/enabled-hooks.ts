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
   * Expiry cannot be tested by waiting, so the dev build answers `DEV_CLOCK` as
   * the current instant when one is set.
   */
  now(env: Env): Date {
    if (env.DEV_ROUTES === "1" && typeof env.DEV_CLOCK === "string" && env.DEV_CLOCK.length > 0) {
      const at = Date.parse(env.DEV_CLOCK);
      if (!Number.isNaN(at)) return new Date(at);
    }
    return new Date();
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
