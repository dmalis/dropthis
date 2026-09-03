import { afterEach, describe, expect, it } from "vitest";
import { startFakeCloudflare } from "../../../../test/fake-cloudflare/src/server.js";
import { makeClient } from "../../src/init/cloudflare-client.js";
import { applyLifecycleRules } from "../../src/init/lifecycle-rules.js";

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

describe("applyLifecycleRules", () => {
  it("sets uploads/ (1 day), requests/ (7 days) and a bucket-wide abort-multipart rule", async () => {
    const cf = await fake({ buckets: [BUCKET] });
    const client = makeClient({ apiToken: "fake-token", accountId: ACCOUNT, apiBase: cf.apiBase });

    await applyLifecycleRules(client, ACCOUNT, BUCKET);

    const stored = cf.state.lifecycleRules.get(BUCKET) as Array<{
      conditions: { prefix: string };
      deleteObjectsTransition?: { condition: { maxAge: number } };
      abortMultipartUploadsTransition?: { condition: { maxAge: number } };
    }>;

    const uploadsRule = stored.find((r) => r.conditions.prefix === "uploads/");
    expect(uploadsRule?.deleteObjectsTransition?.condition.maxAge).toBe(86_400);

    const requestsRule = stored.find((r) => r.conditions.prefix === "requests/");
    expect(requestsRule?.deleteObjectsTransition?.condition.maxAge).toBe(604_800);

    const abortRule = stored.find((r) => r.abortMultipartUploadsTransition !== undefined);
    expect(abortRule?.conditions.prefix).toBe("");
  });

  it("is idempotent: applying twice yields the same three rules, not six", async () => {
    const cf = await fake({ buckets: [BUCKET] });
    const client = makeClient({ apiToken: "fake-token", accountId: ACCOUNT, apiBase: cf.apiBase });

    await applyLifecycleRules(client, ACCOUNT, BUCKET);
    await applyLifecycleRules(client, ACCOUNT, BUCKET);

    expect(cf.state.lifecycleRules.get(BUCKET)).toHaveLength(3);
  });
});
