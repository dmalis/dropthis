import { afterEach, describe, expect, it } from "vitest";
import { startFakeCloudflare } from "../../../../test/fake-cloudflare/src/server.js";
import { makeClient } from "../../src/init/cloudflare-client.js";
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

describe("r2 object json round-trip", () => {
  it("returns undefined for a key that was never written", async () => {
    const cf = await fake({ buckets: ["dropthis-x-drops"] });
    const client = makeClient({ apiToken: "fake-token", accountId: "fake-account-id", apiBase: cf.apiBase });

    const result = await getObjectJson(client, "fake-account-id", "dropthis-x-drops", "users/admin");

    expect(result).toBeUndefined();
  });

  it("writes a JSON object then reads back the same value", async () => {
    const cf = await fake({ buckets: ["dropthis-x-drops"] });
    const client = makeClient({ apiToken: "fake-token", accountId: "fake-account-id", apiBase: cf.apiBase });

    await putObjectJson(client, "fake-account-id", "dropthis-x-drops", "keys/admin.json", {
      id: "admin",
      label: "admin",
    });
    const result = await getObjectJson<{ id: string; label: string }>(
      client,
      "fake-account-id",
      "dropthis-x-drops",
      "keys/admin.json",
    );

    expect(result).toEqual({ id: "admin", label: "admin" });
  });
});
