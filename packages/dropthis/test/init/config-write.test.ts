import { afterEach, describe, expect, it } from "vitest";
import { startFakeCloudflare } from "../../../../test/fake-cloudflare/src/server.js";
import { INITIAL_POLICY } from "../../../worker/src/policy/defaults.js";
import { makeClient } from "../../src/init/cloudflare-client.js";
import { writeInstanceConfig } from "../../src/init/config-write.js";
import { getObjectJson } from "../../src/init/r2-objects.js";

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
});
