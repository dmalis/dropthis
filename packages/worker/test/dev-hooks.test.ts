import { describe, expect, it } from "vitest";
import type { Env } from "../src/bindings.js";
import { DEV_HOOKS } from "../src/dev/enabled-hooks.js";
import { PRODUCTION_HOOKS } from "../src/dev/hooks.js";

const env = (extra: Partial<Env> = {}): Env =>
  ({ BUCKET: {}, OAUTH_KV: {}, ...extra }) as unknown as Env;

const withClock = (value: string) => new Request("https://x/", { headers: { "DEV-Clock": value } });

/**
 * The clock has to move MANY times inside one contract run — publish, expire,
 * revive, expire again, then a cron day at a time — and a Worker variable
 * cannot change without a redeploy. So the dev build reads the instant from a
 * per-request header, exactly as it reads a fault point, and keeps `DEV_CLOCK`
 * as the deployment-wide fallback.
 */
describe("the dev clock", () => {
  it("answers the DEV-Clock header of this request", () => {
    const now = DEV_HOOKS.now(env({ DEV_ROUTES: "1" }), withClock("2030-01-02T03:04:05Z"));
    expect(now.toISOString()).toBe("2030-01-02T03:04:05.000Z");
  });

  it("prefers the header over the deployment-wide DEV_CLOCK", () => {
    const now = DEV_HOOKS.now(
      env({ DEV_ROUTES: "1", DEV_CLOCK: "2020-01-01T00:00:00Z" }),
      withClock("2030-01-02T03:04:05Z"),
    );
    expect(now.toISOString()).toBe("2030-01-02T03:04:05.000Z");
  });

  it("falls back to DEV_CLOCK when the request carries no header", () => {
    const now = DEV_HOOKS.now(env({ DEV_ROUTES: "1", DEV_CLOCK: "2020-01-01T00:00:00Z" }));
    expect(now.toISOString()).toBe("2020-01-01T00:00:00.000Z");
  });

  it("ignores both unless the instance is a dev deployment", () => {
    const before = Date.now();
    const now = DEV_HOOKS.now(
      env({ DEV_CLOCK: "2020-01-01T00:00:00Z" }),
      withClock("2030-01-02T03:04:05Z"),
    );
    expect(now.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("ignores a header that is not a timestamp", () => {
    const before = Date.now();
    const now = DEV_HOOKS.now(env({ DEV_ROUTES: "1" }), withClock("not-a-time"));
    expect(now.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("is the real clock in production, whatever the request says", () => {
    const before = Date.now();
    const now = PRODUCTION_HOOKS.now(
      env({ DEV_ROUTES: "1", DEV_CLOCK: "2020-01-01T00:00:00Z" }),
      withClock("2030-01-02T03:04:05Z"),
    );
    expect(now.getTime()).toBeGreaterThanOrEqual(before);
  });
});
