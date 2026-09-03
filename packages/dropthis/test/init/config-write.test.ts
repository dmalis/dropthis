import { afterEach, describe, expect, it } from "vitest";
import { startFakeCloudflare } from "../../../../test/fake-cloudflare/src/server.js";
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
  it("writes the frozen Free-safe defaults plus this instance's identity", async () => {
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
      expiry: { default: "30d", max: "365d", allow_never: true },
      password: { default: null, required: false },
      noindex: { default: true, forced: false },
      max_file_bytes: 104_857_600,
      max_request_bytes: 2_097_152,
      auto_index: "list",
      pbkdf2_iterations: 5000,
      cron_ops_budget: 40,
    });
  });
});
