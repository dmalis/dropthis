/**
 * The Worker app over a memory bucket, wired the way every route-level unit
 * test wires it: one instance config, one admin key, one user key.
 *
 * It exists so a test about ONE behaviour — a lost CAS, a missing marker, a
 * header — is that behaviour and not forty lines of seeding. What it proves is
 * OUR logic; R2's own behaviour is proven in `contract-tests/` only.
 */
import { hashKey } from "../src/auth/key.js";
import type { Env } from "../src/bindings.js";
import { DEV_HOOKS } from "../src/dev/enabled-hooks.js";
import { createApp } from "../src/index.js";
import type { ResolvedPolicy } from "../src/instance-config.js";
import { INITIAL_POLICY } from "../src/policy/defaults.js";
import { CONFIG_KEY, keyHashKey, keyRecordKey } from "../src/storage/keys.js";
import { memoryBucket } from "./memory-bucket.js";
import type { MemoryBucket } from "./memory-bucket.js";

export const ADMIN_KEY = "a".repeat(64);
export const USER_KEY = "b".repeat(64);
export const ORIGIN = "https://drops.test";

export type Harness = {
  bucket: MemoryBucket;
  env: Env;
  call(path: string, init?: RequestInit, key?: string | null): Promise<Response>;
  json(
    path: string,
    method: string,
    body: unknown,
    options?: { key?: string; headers?: Record<string, string> },
  ): Promise<Response>;
  body<T>(response: Response): Promise<T>;
};

export async function harness(policy: Partial<ResolvedPolicy> = {}): Promise<Harness> {
  const bucket = memoryBucket();
  bucket.seed(
    CONFIG_KEY,
    JSON.stringify({ ...INITIAL_POLICY, ...policy, canonical_url: ORIGIN, alias_origins: [] }),
  );
  await seedKey(bucket, ADMIN_KEY, "id-admin", "admin", "admin");
  await seedKey(bucket, USER_KEY, "id-anna", "anna", "user");
  const env: Env = {
    BUCKET: bucket,
    OAUTH_KV: {} as never,
    HMAC_SECRET: "s".repeat(32),
    DEV_ROUTES: "1",
  };

  const call: Harness["call"] = async (path, init = {}, key = ADMIN_KEY) =>
    createApp(DEV_HOOKS).fetch(
      new Request(`${ORIGIN}${path}`, {
        ...init,
        headers: {
          ...(key === null ? {} : { authorization: `Bearer ${key}` }),
          ...(init.headers ?? {}),
        },
      }),
      env,
    );

  return {
    bucket,
    env,
    call,
    json: (path, method, body, options = {}) =>
      call(
        path,
        {
          method,
          headers: { "content-type": "application/json", ...(options.headers ?? {}) },
          body: JSON.stringify(body),
        },
        options.key,
      ),
    body: async <T,>(response: Response) => (await response.json()) as T,
  };
}

async function seedKey(
  bucket: MemoryBucket,
  key: string,
  id: string,
  label: string,
  scope: "admin" | "user",
) {
  const hash = await hashKey(key);
  bucket.seed(keyHashKey(hash), JSON.stringify({ id }));
  bucket.seed(
    keyRecordKey(id),
    JSON.stringify({ id, label, scope, hash, created: "2026-09-03T00:00:00Z" }),
  );
}
