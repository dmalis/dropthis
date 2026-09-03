/**
 * `runInit` with everything after the deploy wired on: the secret rule, the
 * domain, the health poll, the instance's own `doctor`, and `instances.json`.
 *
 * The deploy is a stub that does what a real one leaves behind — it registers
 * the script with the fake account API and serves the bucket it just wrote
 * through the REAL Worker app, so `health` and `doctor` are answered by the
 * product and not by a mock.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startFakeInstance } from "../../../../test/fake-cloudflare/src/instance.js";
import { startFakeCloudflare } from "../../../../test/fake-cloudflare/src/server.js";
import { readInstancesFile } from "../../src/cli/run.js";
import type { RenderedWranglerConfig } from "../../src/init/plan-render.js";
import { runInit } from "../../src/init/run-init.js";
import type { InitStep } from "../../src/init/run-init.js";
import { bucketObjects, FAST_POLL, stubDeploy } from "./helpers.js";
import type { DeployCall } from "./helpers.js";

const teardown: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (teardown.length > 0) await teardown.pop()!();
});

const ACCOUNT = "fake-account-id";
const ZONES = [{ id: "z-example", name: "example.com", account: { id: ACCOUNT } }];

async function fake(options: Parameters<typeof startFakeCloudflare>[0] = {}) {
  const started = await startFakeCloudflare({ zones: ZONES, ...options });
  teardown.push(() => started.close());
  return started;
}

const CREDS = (cf: Awaited<ReturnType<typeof fake>>) => ({
  apiToken: "fake-token",
  accountId: ACCOUNT,
  apiBase: cf.apiBase,
});

async function home(): Promise<Record<string, string>> {
  const dir = await mkdtemp(join(tmpdir(), "dropthis-init-"));
  return { HOME: dir, XDG_CONFIG_HOME: join(dir, ".config") };
}

const step = (steps: InitStep[], id: string): InitStep | undefined => steps.find((s) => s.id === id);

describe("runInit — the deploy and everything after it", () => {
  it("ships the secret once, polls health, runs doctor and saves the instance", async () => {
    const cf = await fake();
    const { deploy, calls } = stubDeploy(cf, teardown);
    const env = await home();
    const seen: InitStep[] = [];

    const result = await runInit({
      creds: CREDS(cf),
      dryRun: false,
      deploy,
      env,
      onStep: (s) => seen.push(s),
      poll: FAST_POLL,
    });

    expect(result.ok).toBe(true);
    expect(calls[0]!.secrets?.HMAC_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(step(result.steps, "deploy")?.detail).toMatch(/shipped/);
    expect(step(result.steps, "health")?.status).toBe("ok");
    expect(step(result.steps, "doctor")?.status).toBe("ok");
    expect(result.doctor?.ok).toBe(true);
    expect(result.doctor?.checks.map((c) => c.id)).toContain("mcp_initialize");

    const file = await readInstancesFile(env);
    expect(file?.default).toBe("main");
    expect(file?.instances.main?.key).toBe(result.adminKey);
    expect(file?.instances.main?.url).toBe("https://dropthis-main.fake-subdomain.workers.dev");
    expect(step(result.steps, "instances_file")?.status).toBe("ok");

    // Every step the run pushed reached the live stream, in order.
    expect(seen.map((s) => s.id)).toEqual(result.steps.map((s) => s.id));
    expect(seen.map((s) => s.id)).toEqual([
      "token",
      "account",
      "r2_subscription",
      "permissions",
      "bucket",
      "kv_namespace",
      "admin_key",
      "lifecycle_rules",
      "config",
      "render",
      "deploy",
      "health",
      "doctor",
      "instances_file",
    ]);
  });

  it("never re-ships HMAC_SECRET on a rerun", async () => {
    const cf = await fake();
    const { deploy, calls } = stubDeploy(cf, teardown);
    const env = await home();
    const first = await runInit({ creds: CREDS(cf), dryRun: false, deploy, env, poll: FAST_POLL });

    const second = await runInit({
      creds: CREDS(cf),
      dryRun: false,
      deploy,
      env,
      existingKey: first.adminKey!,
      poll: FAST_POLL,
    });

    expect(second.adminKeyStatus).toBe("existing");
    expect(second.adminKey).toBeUndefined();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.secrets).toBeUndefined();
    expect(step(second.steps, "deploy")?.detail).toMatch(/reuse/);
    // The stored key still opens the instance, so doctor still ran.
    expect(step(second.steps, "doctor")?.status).toBe("ok");
  });

  it("skips doctor rather than guessing when a rerun has no key in hand", async () => {
    const cf = await fake();
    const { deploy } = stubDeploy(cf, teardown);
    const env = await home();
    await runInit({ creds: CREDS(cf), dryRun: false, deploy, env, poll: FAST_POLL });

    const second = await runInit({
      creds: CREDS(cf),
      dryRun: false,
      deploy,
      env: await home(),
      poll: FAST_POLL,
    });

    expect(second.ok).toBe(true);
    expect(step(second.steps, "doctor")?.status).toBe("skip");
    expect(step(second.steps, "doctor")?.detail).toMatch(/key/i);
    expect(step(second.steps, "instances_file")?.status).toBe("skip");
  });

  it("a failed check makes the run not ok", async () => {
    const cf = await fake();
    const calls: DeployCall[] = [];
    const deploy = async (config: RenderedWranglerConfig, secrets: Record<string, string> | undefined) => {
      calls.push({ config, secrets });
      // A deploy that landed a Worker with an empty bucket: no config, so
      // policy_readable and canonical_origin fail.
      const instance = await startFakeInstance({ adminKey: "z".repeat(64) });
      instance.bucket.delete("system/config.json");
      teardown.push(() => instance.close());
      return { url: instance.url };
    };

    const result = await runInit({
      creds: CREDS(cf),
      dryRun: false,
      deploy,
      existingKey: "z".repeat(64),
      poll: FAST_POLL,
    });

    expect(step(result.steps, "doctor")?.status).toBe("error");
    expect(result.ok).toBe(false);
    expect(result.doctor?.checks.some((c) => c.status === "fail")).toBe(true);
  });
});

describe("runInit — --domain", () => {
  it("attaches the domain, makes it canonical and keeps workers.dev as an alias", async () => {
    const cf = await fake();
    const { deploy } = stubDeploy(cf, teardown);

    const result = await runInit({
      creds: CREDS(cf),
      dryRun: false,
      deploy,
      domain: "drops.example.com",
      poll: FAST_POLL,
    });

    expect(result.ok).toBe(true);
    expect(result.canonicalUrl).toBe("https://drops.example.com");
    expect(result.aliasOrigins).toEqual(["https://dropthis-main.fake-subdomain.workers.dev"]);
    expect(step(result.steps, "domain")?.status).toBe("created");
    expect(cf.state.workerDomains.map((d) => d.hostname)).toEqual(["drops.example.com"]);
  });

  it("refuses a hostname in a zone this account does not hold, before any deploy", async () => {
    const cf = await fake();
    const { deploy, calls } = stubDeploy(cf, teardown);

    const result = await runInit({
      creds: CREDS(cf),
      dryRun: false,
      deploy,
      domain: "drops.nowhere.test",
      poll: FAST_POLL,
    });

    expect(result.ok).toBe(false);
    expect(step(result.steps, "domain")?.status).toBe("error");
    expect(calls).toHaveLength(0);
    expect(cf.state.buckets).toEqual([]);
  });

  it("refuses when a DNS record already sits at the hostname, before any deploy", async () => {
    const cf = await fake({
      dnsRecords: [{ id: "r1", zoneId: "z-example", name: "drops.example.com", type: "A" }],
    });
    const { deploy, calls } = stubDeploy(cf, teardown);

    const result = await runInit({
      creds: CREDS(cf),
      dryRun: false,
      deploy,
      domain: "drops.example.com",
      poll: FAST_POLL,
    });

    expect(result.ok).toBe(false);
    expect(step(result.steps, "domain")?.detail).toMatch(/A record/);
    expect(calls).toHaveLength(0);
  });
});

describe("runInit — --rotate-admin-key", () => {
  it("returns a new key once, stores it, and the old one stops working", async () => {
    const cf = await fake();
    const { deploy } = stubDeploy(cf, teardown);
    const env = await home();
    const first = await runInit({ creds: CREDS(cf), dryRun: false, deploy, env, poll: FAST_POLL });

    const rotated = await runInit({
      creds: CREDS(cf),
      dryRun: false,
      deploy,
      env,
      rotateAdminKey: true,
      poll: FAST_POLL,
    });

    expect(rotated.ok).toBe(true);
    expect(rotated.adminKeyStatus).toBe("rotated");
    expect(rotated.adminKey).toMatch(/^[0-9a-f]{64}$/);
    expect(rotated.adminKey).not.toBe(first.adminKey);
    const file = await readInstancesFile(env);
    expect(file?.instances.main?.key).toBe(rotated.adminKey);

    const instance = await startFakeInstance({ objects: bucketObjects(cf, "dropthis-main-drops") });
    teardown.push(() => instance.close());
    const call = (key: string) =>
      fetch(`${instance.url}/_api/v1/config`, { headers: { authorization: `Bearer ${key}` } });
    expect((await call(first.adminKey!)).status).toBe(401);
    expect((await call(rotated.adminKey!)).status).toBe(200);
  });
});

describe("runInit — guided preflight (decision #67)", () => {
  it("opens the R2 page, waits, and resumes once the operator enables it", async () => {
    const cf = await fake({ r2SubscriptionEnabled: false });
    const { deploy } = stubDeploy(cf, teardown);
    const walls: Array<{ id: string; url: string }> = [];

    const result = await runInit({
      creds: CREDS(cf),
      dryRun: false,
      deploy,
      poll: FAST_POLL,
      onWall: async (wall) => {
        walls.push(wall);
        // What a human does at the page the installer opened.
        cf.state.r2SubscriptionEnabled = true;
        return "retry";
      },
    });

    expect(walls).toEqual([{ id: "r2_subscription", url: `https://dash.cloudflare.com/${ACCOUNT}/r2` }]);
    expect(result.ok).toBe(true);
    expect(step(result.steps, "r2_subscription")?.status).toBe("ok");
  });

  it("stops with the same URL when nobody is there to clear the wall", async () => {
    const cf = await fake({ r2SubscriptionEnabled: false });
    const { deploy, calls } = stubDeploy(cf, teardown);

    const result = await runInit({ creds: CREDS(cf), dryRun: false, deploy, poll: FAST_POLL });

    expect(result.ok).toBe(false);
    expect(step(result.steps, "r2_subscription")?.status).toBe("error");
    expect(step(result.steps, "r2_subscription")?.detail).toContain("/r2");
    expect(calls).toHaveLength(0);
  });

  it("gives up rather than looping forever when the wall never clears", async () => {
    const cf = await fake({ r2SubscriptionEnabled: false });
    const { deploy } = stubDeploy(cf, teardown);
    let asked = 0;

    const result = await runInit({
      creds: CREDS(cf),
      dryRun: false,
      deploy,
      poll: FAST_POLL,
      onWall: async () => {
        asked += 1;
        return asked < 10 ? "retry" : "stop";
      },
    });

    expect(result.ok).toBe(false);
    expect(asked).toBeLessThanOrEqual(10);
  });
});
