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
   * "Now" for expiry. Production has one answer and it is the clock; the dev
   * build may read the request, so a single deployment can answer for any
   * instant the expiry table names.
   */
  now(env: Env, request?: Request): Date;
  /**
   * The raw `DEV-Fault` header: where THIS request should abort, so a test can
   * prove the retry converges. Each operation names its own points and parses
   * the value itself, so one seam covers publish, `update`, `user add` and
   * whatever comes next.
   */
  fault(request: Request, env: Env): string | undefined;
  /**
   * The lifetime of the OAuth access token THIS token request mints, in
   * seconds, or `undefined` for the provider's default (one hour). Only the
   * dev build answers: the refresh flow cannot be tested by waiting an hour.
   */
  accessTokenTtl(request: Request, env: Env): number | undefined;
};

export const PRODUCTION_HOOKS: DevHooks = {
  now: () => new Date(),
  fault: () => undefined,
  accessTokenTtl: () => undefined,
};
