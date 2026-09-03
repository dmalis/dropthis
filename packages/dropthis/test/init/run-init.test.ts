import { afterEach, describe, expect, it, vi } from "vitest";
import { startFakeCloudflare } from "../../../../test/fake-cloudflare/src/server.js";
import { getObjectJson, putObjectJson } from "../../src/init/r2-objects.js";
import { runInit } from "../../src/init/run-init.js";
import { expectInstanceProved, FAST_POLL, onlySlowMachine, stubDeploy } from "./helpers.js";

const teardown: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (teardown.length > 0) await teardown.pop()!();
});

async function fake(options: Parameters<typeof startFakeCloudflare>[0] = {}) {
  const started = await startFakeCloudflare(options);
  teardown.push(() => started.close());
  return started;
}

const CREDS = (cf: Awaited<ReturnType<typeof fake>>) => ({
  apiToken: "fake-token",
  accountId: "fake-account-id",
  apiBase: cf.apiBase,
});

describe("runInit — happy path", () => {
  it("provisions a fresh `main` instance end to end and deploys once", async () => {
    const cf = await fake();
    const { deploy, calls } = stubDeploy(cf, teardown);

    const result = await runInit({ creds: CREDS(cf), dryRun: false, deploy, poll: FAST_POLL });

    expectInstanceProved(result);
    expect(result.name).toBe("main");
    expect(result.bucket).toBe("dropthis-main-drops");
    expect(result.kvNamespace).toBe("dropthis-main-oauth");
    expect(result.adminKeyStatus).toBe("created");
    expect(result.adminKey).toMatch(/^[0-9a-f]{64}$/);
    expect(result.canonicalUrl).toBe("https://dropthis-main.fake-subdomain.workers.dev");
    expect(cf.state.buckets).toContain("dropthis-main-drops");
    expect(cf.state.namespaces.map((n) => n.title)).toContain("dropthis-main-oauth");
    expect(calls).toHaveLength(1);
    const { config, secrets } = calls[0]!;
    expect(config.name).toBe("dropthis-main");
    expect(config.r2_buckets).toEqual([{ binding: "BUCKET", bucket_name: "dropthis-main-drops" }]);
    expect(secrets?.HMAC_SECRET).toMatch(/^[0-9a-f]{64}$/);

    const client = (await import("../../src/init/cloudflare-client.js")).makeClient(CREDS(cf));
    const config2 = await getObjectJson<Record<string, unknown>>(
      client,
      "fake-account-id",
      "dropthis-main-drops",
      "system/config.json",
    );
    expect(config2?.instance_name).toBe("main");
    const rules = cf.state.lifecycleRules.get("dropthis-main-drops");
    expect(rules).toHaveLength(3);
  });

  it("uses the given instance name to derive every resource", async () => {
    const cf = await fake();
    const { deploy } = stubDeploy(cf, teardown);

    const result = await runInit({ creds: CREDS(cf), name: "byrokko", dryRun: false, deploy, poll: FAST_POLL });

    expect(result.name).toBe("byrokko");
    expect(result.bucket).toBe("dropthis-byrokko-drops");
    expect(result.kvNamespace).toBe("dropthis-byrokko-oauth");
  });
});

describe("runInit — rerun", () => {
  it("reconciles without re-minting the admin key and without duplicate resources", async () => {
    const cf = await fake();
    const { deploy } = stubDeploy(cf, teardown);
    const first = await runInit({ creds: CREDS(cf), dryRun: false, deploy, poll: FAST_POLL });

    const second = await runInit({ creds: CREDS(cf), dryRun: false, deploy, poll: FAST_POLL });

    expect(second.ok, JSON.stringify(second.steps)).toBe(true);
    expect(second.adminKeyStatus).toBe("existing");
    expect(second.adminKey).toBeUndefined();
    expect(cf.state.buckets.filter((b) => b === "dropthis-main-drops")).toHaveLength(1);
    expect(cf.state.namespaces.filter((n) => n.title === "dropthis-main-oauth")).toHaveLength(1);
    expect(first.adminKey).not.toBeUndefined();
  });

  it("repairs a KV namespace deleted out from under a live instance", async () => {
    const cf = await fake();
    const { deploy } = stubDeploy(cf, teardown);
    const first = await runInit({ creds: CREDS(cf), dryRun: false, deploy, poll: FAST_POLL });
    const deletedId = cf.state.namespaces.find((n) => n.title === "dropthis-main-oauth")!.id;
    cf.state.namespaces = cf.state.namespaces.filter((n) => n.id !== deletedId);

    const second = await runInit({ creds: CREDS(cf), dryRun: false, deploy, poll: FAST_POLL });

    expect(second.ok || onlySlowMachine(second)).toBe(true);
    expect(second.adminKeyStatus).toBe("existing");
    const recreated = cf.state.namespaces.find((n) => n.title === "dropthis-main-oauth");
    expect(recreated).toBeDefined();
    expect(cf.state.namespaces).toHaveLength(1);
    expect(first.adminKey).not.toBeUndefined();
  });
});

describe("runInit — dry-run", () => {
  it("never creates anything and never deploys", async () => {
    const cf = await fake();
    const deploy = vi.fn().mockResolvedValue(undefined);

    const result = await runInit({ creds: CREDS(cf), dryRun: true, deploy });

    expect(result.ok, JSON.stringify(result.steps)).toBe(true);
    expect(cf.state.buckets).toEqual([]);
    expect(cf.state.namespaces).toEqual([]);
    expect(deploy).not.toHaveBeenCalled();
    expect(result.adminKeyStatus).toBeUndefined();
  });
});

describe("runInit — account preflight failure", () => {
  it("refuses to guess between several accounts and never deploys", async () => {
    const cf = await fake({
      accounts: [
        { id: "acct-1", name: "One" },
        { id: "acct-2", name: "Two" },
      ],
    });
    const deploy = vi.fn().mockResolvedValue(undefined);

    const result = await runInit({ creds: CREDS(cf), dryRun: false, deploy });

    expect(result.ok).toBe(false);
    expect(result.steps.some((s) => s.id === "account" && s.status === "error")).toBe(true);
    expect(deploy).not.toHaveBeenCalled();
  });
});

describe("runInit — NAME_TAKEN", () => {
  it("refuses when the derived bucket exists but was never set up by dropthis", async () => {
    const cf = await fake({ buckets: ["dropthis-main-drops"] });
    const deploy = vi.fn().mockResolvedValue(undefined);

    const result = await runInit({ creds: CREDS(cf), dryRun: false, deploy });

    expect(result.ok).toBe(false);
    expect(result.steps.some((s) => s.id === "bucket" && s.status === "error")).toBe(true);
    expect(deploy).not.toHaveBeenCalled();
  });

  it("does NOT refuse a real rerun: the bucket already carries a dropthis config", async () => {
    const cf = await fake({ buckets: ["dropthis-main-drops"] });
    const client = (await import("../../src/init/cloudflare-client.js")).makeClient(CREDS(cf));
    await putObjectJson(client, "fake-account-id", "dropthis-main-drops", "system/config.json", {
      instance_name: "main",
    });
    const { deploy, calls } = stubDeploy(cf, teardown);

    const result = await runInit({ creds: CREDS(cf), dryRun: false, deploy, poll: FAST_POLL });

    expect(result.ok || onlySlowMachine(result)).toBe(true);
    expect(calls).toHaveLength(1);
  });
});
