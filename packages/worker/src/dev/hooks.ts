/**
 * The seam through which the dev build — and only the dev build — can bend two
 * things the product otherwise fixes: what time it is, and whether a write
 * aborts halfway.
 *
 * It is a parameter, not an environment check, so `src/index.ts` never names a
 * dev variable and the production bundle cannot contain one. `test/
 * build-guard.test.ts` pins exactly that.
 */
import type { Env } from "../bindings.js";
import type { FaultPoint } from "../operations/publish.js";

export type DevHooks = {
  /**
   * "Now" for expiry. Production has one answer and it is the clock; the dev
   * build may read the request, so a single deployment can answer for any
   * instant the expiry table names.
   */
  now(env: Env, request?: Request): Date;
  /** Where a publish should abort, to prove a retry converges. */
  faultPoint(request: Request, env: Env): FaultPoint | undefined;
};

export const PRODUCTION_HOOKS: DevHooks = {
  now: () => new Date(),
  faultPoint: () => undefined,
};
