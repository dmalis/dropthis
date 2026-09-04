import { afterEach, describe, expect, it } from "vitest";
import { startFakeCloudflare } from "../../../../test/fake-cloudflare/src/server.js";
import { INITIAL_POLICY } from "../../../worker/src/policy/defaults.js";
import { makeClient } from "../../src/init/cloudflare-client.js";
import { claimBucketForInstance, writeInstanceConfig } from "../../src/init/config-write.js";
import { getObjectJson, putObjectJson } from "../../src/init/r2-objects.js";

const teardown: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (teardown.length > 0) await teardown.pop()!();
});

async function fake(options: Parameters<typeof startFakeCloudflare>[0] = {}) {
  const started = await startFakeCloudflare(options);
  teardown.push(() => started.close());
  return started;
}

const ACCOUNT = "fake-account-id";
const BUCKET = "dropthis-x-drops";

describe("writeInstanceConfig", () => {
  it("writes the instance's identity plus the worker's own initial policy, field for field", async () => {
    const cf = await fake({ buckets: [BUCKET] });
    const client = makeClient({ apiToken: "fake-token", accountId: ACCOUNT, apiBase: cf.apiBase });

    await writeInstanceConfig(client, ACCOUNT, BUCKET, {
      instanceName: "main",
      canonicalUrl: "https://dropthis-main.fake-subdomain.workers.dev",
      aliasOrigins: [],
    });

    const config = await getObjectJson<Record<string, unknown>>(client, ACCOUNT, BUCKET, "system/config.json");

    expect(config).toEqual({
      instance_name: "main",
      canonical_url: "https://dropthis-main.fake-subdomain.workers.dev",
      alias_origins: [],
      ...INITIAL_POLICY,
    });

    // The measured values, named here so a silent drift of either source is a
    // failing test and not a quietly weaker instance (decision #73).
    expect(config?.pbkdf2_iterations).toBe(25_000);
    expect(config?.max_request_bytes).toBe(4 * 1024 * 1024);
  });

  it("keeps the policy an operator set and only rewrites the identity", async () => {
    const cf = await fake({ buckets: [BUCKET] });
    const client = makeClient({ apiToken: "fake-token", accountId: ACCOUNT, apiBase: cf.apiBase });
    await writeInstanceConfig(client, ACCOUNT, BUCKET, {
      instanceName: "main",
      canonicalUrl: "https://old.example",
      aliasOrigins: [],
    });
    // What `config set` does after the install: policy is prospective, and an
    // init rerun is not an operator changing their mind.
    await putObjectJson(client, ACCOUNT, BUCKET, "system/config.json", {
      ...((await getObjectJson<Record<string, unknown>>(client, ACCOUNT, BUCKET, "system/config.json")) ?? {}),
      expiry: { default: "7d", max: "30d", allow_never: false },
      pbkdf2_iterations: 40_000,
    });

    await writeInstanceConfig(client, ACCOUNT, BUCKET, {
      instanceName: "main",
      canonicalUrl: "https://drops.example.com",
      aliasOrigins: ["https://dropthis-main.fake-subdomain.workers.dev"],
    });

    const config = await getObjectJson<Record<string, unknown>>(client, ACCOUNT, BUCKET, "system/config.json");
    expect(config?.expiry).toEqual({ default: "7d", max: "30d", allow_never: false });
    expect(config?.pbkdf2_iterations).toBe(40_000);
    expect(config?.canonical_url).toBe("https://drops.example.com");
    expect(config?.alias_origins).toEqual(["https://dropthis-main.fake-subdomain.workers.dev"]);
  });

  it("fills in a policy field a stored config is missing, without touching the rest", async () => {
    const cf = await fake({ buckets: [BUCKET] });
    const client = makeClient({ apiToken: "fake-token", accountId: ACCOUNT, apiBase: cf.apiBase });
    await putObjectJson(client, ACCOUNT, BUCKET, "system/config.json", {
      instance_name: "main",
      pbkdf2_iterations: 40_000,
    });

    await writeInstanceConfig(client, ACCOUNT, BUCKET, {
      instanceName: "main",
      canonicalUrl: "https://drops.example.com",
      aliasOrigins: [],
    });

    const config = await getObjectJson<Record<string, unknown>>(client, ACCOUNT, BUCKET, "system/config.json");
    expect(config?.pbkdf2_iterations).toBe(40_000);
    expect(config?.max_request_bytes).toBe(INITIAL_POLICY.max_request_bytes);
    expect(config?.expiry).toEqual(INITIAL_POLICY.expiry);
  });
});

describe("claimBucketForInstance", () => {
  it("marks a freshly created bucket as this instance's before anything else is written", async () => {
    const cf = await fake({ buckets: [BUCKET] });
    const client = makeClient({ apiToken: "fake-token", accountId: ACCOUNT, apiBase: cf.apiBase });

    await claimBucketForInstance(client, ACCOUNT, BUCKET, "main");

    const config = await getObjectJson<Record<string, unknown>>(client, ACCOUNT, BUCKET, "system/config.json");
    expect(config?.instance_name).toBe("main");
    expect(config?.pbkdf2_iterations).toBe(INITIAL_POLICY.pbkdf2_iterations);
    // The identity it does not know yet is absent, never a wrong guess.
    expect(config?.canonical_url).toBeUndefined();
  });

  it("never overwrites a config that is already there", async () => {
    const cf = await fake({ buckets: [BUCKET] });
    const client = makeClient({ apiToken: "fake-token", accountId: ACCOUNT, apiBase: cf.apiBase });
    await putObjectJson(client, ACCOUNT, BUCKET, "system/config.json", {
      instance_name: "main",
      canonical_url: "https://drops.example.com",
      pbkdf2_iterations: 40_000,
    });

    await claimBucketForInstance(client, ACCOUNT, BUCKET, "main");

    const config = await getObjectJson<Record<string, unknown>>(client, ACCOUNT, BUCKET, "system/config.json");
    expect(config?.canonical_url).toBe("https://drops.example.com");
    expect(config?.pbkdf2_iterations).toBe(40_000);
  });
});
