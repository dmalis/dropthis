import { afterEach, describe, expect, it } from "vitest";
import { startFakeCloudflare } from "../../../../test/fake-cloudflare/src/server.js";
import { makeClient } from "../../src/init/cloudflare-client.js";
import { reconcileBucket, reconcileNamespace } from "../../src/init/reconcile.js";

const teardown: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (teardown.length > 0) await teardown.pop()!();
});

async function fake(options: Parameters<typeof startFakeCloudflare>[0] = {}) {
  const started = await startFakeCloudflare(options);
  teardown.push(() => started.close());
  return started;
}

describe("reconcileBucket", () => {
  it("creates the bucket when it does not exist", async () => {
    const cf = await fake();
    const client = makeClient({ apiToken: "fake-token", accountId: "fake-account-id", apiBase: cf.apiBase });

    const result = await reconcileBucket(client, "fake-account-id", "dropthis-x-drops", { dryRun: false });

    expect(result.status).toBe("created");
    expect(cf.state.buckets).toContain("dropthis-x-drops");
  });

  it("reuses an existing bucket without creating a duplicate", async () => {
    const cf = await fake({ buckets: ["dropthis-x-drops"] });
    const client = makeClient({ apiToken: "fake-token", accountId: "fake-account-id", apiBase: cf.apiBase });

    const result = await reconcileBucket(client, "fake-account-id", "dropthis-x-drops", { dryRun: false });

    expect(result.status).toBe("ok");
    expect(cf.state.calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("dry-run never creates", async () => {
    const cf = await fake();
    const client = makeClient({ apiToken: "fake-token", accountId: "fake-account-id", apiBase: cf.apiBase });

    const result = await reconcileBucket(client, "fake-account-id", "dropthis-x-drops", { dryRun: true });

    expect(result.status).toBe("would_create");
    expect(cf.state.buckets).toEqual([]);
  });
});

describe("reconcileNamespace", () => {
  it("creates the KV namespace when it does not exist and returns its id", async () => {
    const cf = await fake();
    const client = makeClient({ apiToken: "fake-token", accountId: "fake-account-id", apiBase: cf.apiBase });

    const result = await reconcileNamespace(client, "fake-account-id", "dropthis-x-oauth", { dryRun: false });

    expect(result.status).toBe("created");
    expect(result.id).toBeDefined();
    expect(cf.state.namespaces.map((n) => n.title)).toContain("dropthis-x-oauth");
  });

  it("reuses an existing namespace found past the first page", async () => {
    const cf = await fake({
      perPage: 2,
      namespaces: [
        { id: "id-a".padEnd(32, "0"), title: "aaa-kv" },
        { id: "id-b".padEnd(32, "0"), title: "bbb-kv" },
        { id: "id-existing".padEnd(32, "0"), title: "dropthis-x-oauth" },
      ],
    });
    const client = makeClient({ apiToken: "fake-token", accountId: "fake-account-id", apiBase: cf.apiBase });

    const result = await reconcileNamespace(client, "fake-account-id", "dropthis-x-oauth", { dryRun: false });

    expect(result.status).toBe("ok");
    expect(result.id).toBe("id-existing".padEnd(32, "0"));
    expect(cf.state.calls.filter((c) => c.method === "POST")).toEqual([]);
  });
});
