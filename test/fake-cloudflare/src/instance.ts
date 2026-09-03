/**
 * A dropthis instance on localhost for the CLI's offline tests: the REAL
 * Worker app (`packages/worker/src/index.ts`, dev hooks on) served by
 * `@hono/node-server` over an in-memory bucket. It proves the CLI's wiring —
 * flags to bodies, exit codes, output contract — against the product's own
 * routes, without a network. What R2 does under a write is not proven here;
 * that is `contract-tests/`.
 *
 * `broken: true` serves an instance that answers every API call with HTML,
 * which is what a wrong URL or a captive portal looks like to the CLI.
 */
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { hashKey } from "../../../packages/worker/src/auth/key.js";
import type { Env } from "../../../packages/worker/src/bindings.js";
import { DEV_HOOKS } from "../../../packages/worker/src/dev/enabled-hooks.js";
import { createApp } from "../../../packages/worker/src/index.js";
import { INITIAL_POLICY } from "../../../packages/worker/src/policy/defaults.js";
import { CONFIG_KEY, keyHashKey, keyRecordKey } from "../../../packages/worker/src/storage/keys.js";
import { memoryBucket } from "../../../packages/worker/test/memory-bucket.js";
import type { MemoryBucket } from "../../../packages/worker/test/memory-bucket.js";

export type FakeInstanceOptions = {
  adminKey: string;
  userKey?: string;
  policy?: Partial<Record<keyof typeof INITIAL_POLICY, unknown>>;
  broken?: boolean;
};

export type FakeInstance = {
  url: string;
  bucket: MemoryBucket;
  close(): Promise<void>;
};

export async function startFakeInstance(options: FakeInstanceOptions): Promise<FakeInstance> {
  const bucket = memoryBucket();
  const env: Env = { BUCKET: bucket, OAUTH_KV: {}, HMAC_SECRET: "s".repeat(32), DEV_ROUTES: "1" };

  const seedKey = async (key: string, id: string, label: string, scope: "admin" | "user") => {
    const hash = await hashKey(key);
    bucket.seed(keyHashKey(hash), JSON.stringify({ id }));
    bucket.seed(
      keyRecordKey(id),
      JSON.stringify({ id, label, scope, hash, created: "2026-09-03T00:00:00Z" }),
    );
  };
  await seedKey(options.adminKey, "admin", "admin", "admin");
  if (options.userKey !== undefined) await seedKey(options.userKey, "id-anna", "anna", "user");

  const app = options.broken === true ? brokenApp() : createApp(DEV_HOOKS);

  const server: ServerType = await new Promise((resolve) => {
    const started = serve({ fetch: (request) => app.fetch(request, env), port: 0, hostname: "127.0.0.1" }, () =>
      resolve(started),
    );
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fake instance did not bind");
  const url = `http://127.0.0.1:${address.port}`;

  bucket.seed(
    CONFIG_KEY,
    JSON.stringify({
      ...INITIAL_POLICY,
      ...(options.policy ?? {}),
      canonical_url: url,
      alias_origins: [],
      instance_name: "fake",
    }),
  );

  return {
    url,
    bucket,
    close: () =>
      new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function brokenApp() {
  const app = new Hono();
  app.all("*", (c) => c.html("<html><body>Sign in to the network</body></html>"));
  return app;
}
