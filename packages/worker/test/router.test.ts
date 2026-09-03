import { beforeEach, describe, expect, it } from "vitest";
import { hashKey } from "../src/auth/key.js";
import { createApp } from "../src/index.js";
import type { Env } from "../src/bindings.js";
import { CONFIG_KEY, keyHashKey, keyRecordKey } from "../src/storage/keys.js";
import { INITIAL_POLICY } from "../src/policy/defaults.js";
import { memoryBucket } from "./memory-bucket.js";
import type { MemoryBucket } from "./memory-bucket.js";

/**
 * The generated router: every route but `health` needs a key, and the scope
 * gate runs before the handler.
 *
 * These are route-level tests over the real Hono app with an in-memory bucket.
 * They pin OUR wiring — which route is open, which scope each needs, what the
 * refusal looks like. What R2 does under a conditional write is proven only in
 * `contract-tests/`, against remote R2.
 */
const ADMIN_KEY = "a".repeat(64);
const USER_KEY = "b".repeat(64);

let bucket: MemoryBucket;
let env: Env;

async function seedKey(key: string, id: string, label: string, scope: "admin" | "user") {
  const hash = await hashKey(key);
  bucket.seed(keyHashKey(hash), JSON.stringify({ id }));
  bucket.seed(
    keyRecordKey(id),
    JSON.stringify({ id, label, scope, hash, created: "2026-09-03T00:00:00Z" }),
  );
}

beforeEach(async () => {
  bucket = memoryBucket();
  bucket.seed(
    CONFIG_KEY,
    JSON.stringify({ ...INITIAL_POLICY, canonical_url: "https://drops.test", alias_origins: [] }),
  );
  await seedKey(ADMIN_KEY, "id-admin", "admin", "admin");
  await seedKey(USER_KEY, "id-anna", "anna", "user");
  env = { BUCKET: bucket, OAUTH_KV: {}, HMAC_SECRET: "s".repeat(32) };
});

const app = () => createApp();

const call = (path: string, init: RequestInit = {}) =>
  app().fetch(new Request(`https://drops.test${path}`, init), env);

const withKey = (key: string, init: RequestInit = {}) => ({
  ...init,
  headers: { authorization: `Bearer ${key}`, ...(init.headers ?? {}) },
});

async function errorOf(response: Response): Promise<{ status: number; code: string }> {
  const body = (await response.json()) as { error: { code: string } };
  return { status: response.status, code: body.error.code };
}

describe("health", () => {
  it("stays open and says nothing else", async () => {
    const response = await call("/_api/v1/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});

describe("authentication", () => {
  const authenticated: Array<[string, string, RequestInit]> = [
    ["POST", "/_api/v1/drops", { method: "POST", body: "{}" }],
    ["GET", "/_api/v1/drops/abcdefghij", {}],
    ["GET", "/_api/v1/users", {}],
    ["GET", "/_api/v1/config", {}],
  ];

  it.each(authenticated)("%s %s refuses a missing key", async (_method, path, init) => {
    expect(await errorOf(await call(path, init))).toEqual({
      status: 401,
      code: "UNAUTHENTICATED",
    });
  });

  it.each(authenticated)("%s %s refuses a garbage key", async (_method, path, init) => {
    const response = await call(path, withKey("not-a-key", init));
    expect(await errorOf(response)).toEqual({ status: 401, code: "UNAUTHENTICATED" });
  });

  it("refuses a revoked key: deleting the keyhash pointer ends access", async () => {
    await bucket.delete(keyHashKey(await hashKey(USER_KEY)));
    const response = await call("/_api/v1/drops/abcdefghij", withKey(USER_KEY));
    expect(await errorOf(response)).toEqual({ status: 401, code: "UNAUTHENTICATED" });
  });

  it("sends the catalogue's remediation with the refusal", async () => {
    const body = (await (await call("/_api/v1/users")).json()) as {
      error: { remediation: string; retryable: boolean };
    };
    expect(body.error.remediation).toContain("Authorization: Bearer");
    expect(body.error.retryable).toBe(false);
  });
});

describe("scope", () => {
  it("refuses a user key on an admin route", async () => {
    const response = await call("/_api/v1/users", withKey(USER_KEY));
    expect(await errorOf(response)).toEqual({ status: 403, code: "FORBIDDEN_SCOPE" });
  });

  it("lets an admin key reach an admin route", async () => {
    const response = await call("/_api/v1/users", withKey(ADMIN_KEY));
    expect(response.status).toBe(200);
  });

  it("lets a user key reach a drop route", async () => {
    // No such drop, but the request got past the gate: 404, not 403.
    const response = await call("/_api/v1/drops/abcdefghij", withKey(USER_KEY));
    expect(await errorOf(response)).toEqual({ status: 404, code: "NOT_FOUND" });
  });
});

describe("attribution", () => {
  it("writes the calling key's id and label into created_by", async () => {
    const response = await call(
      "/_api/v1/drops",
      withKey(USER_KEY, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ files: [{ path: "a.txt", text: "hello" }] }),
      }),
    );
    expect(response.status, await response.clone().text()).toBe(201);
    const drop = (await response.json()) as { created_by: unknown };
    expect(drop.created_by).toEqual({ id: "id-anna", label: "anna" });
  });
});
