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

export type DevHooks = {
  /**
   * "Now" for expiry. Production has one answer and it is the clock.
   *
   * The dev build takes it from the REQUEST, not from a deployment variable: a
   * contract run has to publish, expire, revive and then walk the cron forward
   * a day at a time, and a Worker variable cannot change without a redeploy.
   * `request` is absent for the scheduled handler, which has no request.
   */
  now(env: Env, request?: Request): Date;
  /**
   * The raw `DEV-Fault` header: where THIS request should abort, so a test can
   * prove the retry converges. Each operation names its own points and parses
   * the value itself, so one seam covers publish, `user add` and whatever
   * comes next.
   */
  fault(request: Request, env: Env): string | undefined;
};

export const PRODUCTION_HOOKS: DevHooks = {
  now: () => new Date(),
  fault: () => undefined,
};
