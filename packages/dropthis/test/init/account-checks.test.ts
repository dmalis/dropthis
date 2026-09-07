import { afterEach, describe, expect, it } from "vitest";
import { startFakeCloudflare } from "../../../../test/fake-cloudflare/src/server.js";
import { runAccountChecks } from "../../src/init/account-checks.js";
import { applyLifecycleRules } from "../../src/init/lifecycle-rules.js";
import { makeClient } from "../../src/init/cloudflare-client.js";
import { putObjectJson } from "../../src/init/r2-objects.js";

const teardown: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (teardown.length > 0) await teardown.pop()!();
});

const ACCOUNT = "fake-account-id";
const ZONES = [{ id: "z-example", name: "example.com", account: { id: ACCOUNT } }];

async function fake(options: Parameters<typeof startFakeCloudflare>[0] = {}) {
  const started = await startFakeCloudflare({ buckets: ["dropthis-main-drops"], zones: ZONES, ...options });
  teardown.push(() => started.close());
  return { ...started, client: makeClient({ apiToken: "fake-token", accountId: ACCOUNT, apiBase: started.apiBase }) };
}

const row = (result: Awaited<ReturnType<typeof runAccountChecks>>, id: string) =>
  result.checks.find((check) => check.id === id);

describe("runAccountChecks", () => {
  it("passes when the rules are set and the deployed Worker binds the reconciled KV", async () => {
    const cf = await fake();
    await applyLifecycleRules(cf.client, ACCOUNT, "dropthis-main-drops");
    cf.state.namespaces.push({ id: "kv-1", title: "dropthis-main-oauth" });
    cf.state.scripts.set("dropthis-main", {
      name: "dropthis-main",
      secrets: ["HMAC_SECRET"],
      bindings: [{ type: "kv_namespace", name: "OAUTH_KV", namespace_id: "kv-1" }],
    });

    const result = await runAccountChecks(cf.client, ACCOUNT, { name: "main" });

    expect(result.ok).toBe(true);
    expect(row(result, "lifecycle_rules")?.status).toBe("pass");
    expect(row(result, "kv_bound")?.status).toBe("pass");
    // No domain was asked for and none is attached: nothing was proved.
    expect(row(result, "domain_attached")?.status).toBe("skip");
  });

  it("fails when the lifecycle rules were never applied", async () => {
    const cf = await fake();
    cf.state.namespaces.push({ id: "kv-1", title: "dropthis-main-oauth" });
    cf.state.scripts.set("dropthis-main", {
      name: "dropthis-main",
      secrets: [],
      bindings: [{ type: "kv_namespace", name: "OAUTH_KV", namespace_id: "kv-1" }],
    });

    const result = await runAccountChecks(cf.client, ACCOUNT, { name: "main" });

    expect(result.ok).toBe(false);
    expect(row(result, "lifecycle_rules")?.status).toBe("fail");
    expect(row(result, "lifecycle_rules")?.remediation).toMatch(/init/);
  });

  it("fails when the deployed Worker binds a DIFFERENT KV namespace than the reconciled one", async () => {
    const cf = await fake();
    await applyLifecycleRules(cf.client, ACCOUNT, "dropthis-main-drops");
    cf.state.namespaces.push({ id: "kv-1", title: "dropthis-main-oauth" });
    cf.state.scripts.set("dropthis-main", {
      name: "dropthis-main",
      secrets: [],
      bindings: [{ type: "kv_namespace", name: "OAUTH_KV", namespace_id: "kv-stale" }],
    });

    const result = await runAccountChecks(cf.client, ACCOUNT, { name: "main" });

    expect(row(result, "kv_bound")?.status).toBe("fail");
    expect(row(result, "kv_bound")?.evidence).toMatch(/kv-stale/);
  });

  it("fails when the Worker was never deployed", async () => {
    const cf = await fake();

    const result = await runAccountChecks(cf.client, ACCOUNT, { name: "main" });

    expect(row(result, "kv_bound")?.status).toBe("fail");
    expect(row(result, "kv_bound")?.evidence).toMatch(/dropthis-main/);
  });

  it("checks the domain when one was asked for", async () => {
    const cf = await fake();
    cf.state.workerDomains.push({
      id: "d1",
      hostname: "drops.example.com",
      service: "dropthis-main",
      zone_id: "z-example",
    });

    const result = await runAccountChecks(cf.client, ACCOUNT, { name: "main", domain: "drops.example.com" });

    expect(row(result, "domain_attached")?.status).toBe("pass");
  });

  it("checks the domain the instance already stores when --domain was not given", async () => {
    const cf = await fake();
    await putObjectJson(cf.client, ACCOUNT, "dropthis-main-drops", "system/config.json", {
      instance_name: "main",
      canonical_url: "https://drops.example.com",
      alias_origins: [],
    });

    const result = await runAccountChecks(cf.client, ACCOUNT, { name: "main" });

    expect(row(result, "domain_attached")?.status).toBe("fail");
    expect(row(result, "domain_attached")?.evidence).toContain("drops.example.com");
  });

  it("skips the domain when the instance lives on its workers.dev hostname", async () => {
    const cf = await fake();
    await putObjectJson(cf.client, ACCOUNT, "dropthis-main-drops", "system/config.json", {
      instance_name: "main",
      canonical_url: "https://dropthis-main.fake-subdomain.workers.dev",
      alias_origins: [],
    });

    const result = await runAccountChecks(cf.client, ACCOUNT, { name: "main" });

    expect(row(result, "domain_attached")?.status).toBe("skip");
  });

  /**
   * Issue #25: the Custom Domain can be attached and correct while a Workers
   * Route on the same zone takes precedence and answers from another Worker.
   * `--check` never mutates, so it names the exact route to add.
   */
  it("route_clear fails when a foreign route shadows the domain, naming the route to add", async () => {
    const cf = await fake({
      zoneRoutes: [{ id: "r1", zoneId: "z-example", pattern: "*.example.com/*", script: "notice" }],
    });
    cf.state.workerDomains.push({
      id: "d1",
      hostname: "drops.example.com",
      service: "dropthis-main",
      zone_id: "z-example",
    });

    const result = await runAccountChecks(cf.client, ACCOUNT, { name: "main", domain: "drops.example.com" });

    expect(result.ok).toBe(false);
    expect(row(result, "domain_attached")?.status).toBe("pass");
    expect(row(result, "route_clear")?.status).toBe("fail");
    expect(row(result, "route_clear")?.evidence).toContain("*.example.com/*");
    expect(row(result, "route_clear")?.evidence).toContain("notice");
    expect(row(result, "route_clear")?.remediation).toContain("drops.example.com/*");
    expect(row(result, "route_clear")?.remediation).toContain("dropthis-main");
    // A read-only check adds nothing.
    expect(cf.state.zoneRoutes).toHaveLength(1);
  });

  it("route_clear passes when no route on the zone matches the hostname", async () => {
    const cf = await fake({
      zoneRoutes: [{ id: "r1", zoneId: "z-example", pattern: "blog.example.com/*", script: "notice" }],
    });

    const result = await runAccountChecks(cf.client, ACCOUNT, { name: "main", domain: "drops.example.com" });

    expect(row(result, "route_clear")?.status).toBe("pass");
  });

  it("route_clear passes when the exact route already sends the hostname to this Worker", async () => {
    const cf = await fake({
      zoneRoutes: [
        { id: "r1", zoneId: "z-example", pattern: "*.example.com/*", script: "notice" },
        { id: "r2", zoneId: "z-example", pattern: "drops.example.com/*", script: "dropthis-main" },
      ],
    });

    const result = await runAccountChecks(cf.client, ACCOUNT, { name: "main", domain: "drops.example.com" });

    expect(row(result, "route_clear")?.status).toBe("pass");
    expect(row(result, "route_clear")?.evidence).toContain("drops.example.com/*");
  });

  /**
   * Only `<hostname>/*` beats a foreign pattern by specificity. `route_clear`
   * reads the same classifier `init` reconciles with, so the two can never
   * disagree about whether the hostname is actually reachable.
   */
  it("route_clear fails when OUR matching route is only a broad one beside a foreign match", async () => {
    const cf = await fake({
      zoneRoutes: [
        { id: "r1", zoneId: "z-example", pattern: "*.example.com/*", script: "notice" },
        { id: "r2", zoneId: "z-example", pattern: "*.example.com/*", script: "dropthis-main" },
      ],
    });

    const result = await runAccountChecks(cf.client, ACCOUNT, { name: "main", domain: "drops.example.com" });

    expect(row(result, "route_clear")?.status).toBe("fail");
    expect(row(result, "route_clear")?.remediation).toContain("drops.example.com/*");
  });

  it("route_clear passes when only OUR own broad route matches — nothing shadows it", async () => {
    const cf = await fake({
      zoneRoutes: [{ id: "r1", zoneId: "z-example", pattern: "*.example.com/*", script: "dropthis-main" }],
    });

    const result = await runAccountChecks(cf.client, ACCOUNT, { name: "main", domain: "drops.example.com" });

    expect(row(result, "route_clear")?.status).toBe("pass");
  });

  it("route_clear says so when another Worker holds the exact route", async () => {
    const cf = await fake({
      zoneRoutes: [{ id: "r1", zoneId: "z-example", pattern: "drops.example.com/*", script: "notice" }],
    });

    const result = await runAccountChecks(cf.client, ACCOUNT, { name: "main", domain: "drops.example.com" });

    const route = row(result, "route_clear");
    expect(route?.status).toBe("fail");
    expect(route?.evidence).toContain("notice");
    // Adding our own route cannot fix it, so the remediation must not say so.
    expect(route?.remediation).toContain("drops.example.com/*");
    expect(route?.remediation).toMatch(/repoint|delete|another hostname/);
  });

  it("route_clear skips when there is no custom domain to shadow", async () => {
    const cf = await fake();

    const result = await runAccountChecks(cf.client, ACCOUNT, { name: "main" });

    expect(row(result, "route_clear")?.status).toBe("skip");
  });

  it("route_clear fails, naming the permission, when the zone's routes cannot be read", async () => {
    const cf = await fake({ missingScopes: ["workers-routes"] });

    const result = await runAccountChecks(cf.client, ACCOUNT, { name: "main", domain: "drops.example.com" });

    expect(row(result, "route_clear")?.status).toBe("fail");
    expect(row(result, "route_clear")?.remediation).toContain("Workers Routes");
  });

  it("fails when the asked-for domain routes to another Worker", async () => {
    const cf = await fake();
    cf.state.workerDomains.push({
      id: "d1",
      hostname: "drops.example.com",
      service: "someone-elses-worker",
      zone_id: "z-example",
    });

    const result = await runAccountChecks(cf.client, ACCOUNT, { name: "main", domain: "drops.example.com" });

    expect(row(result, "domain_attached")?.status).toBe("fail");
    expect(row(result, "domain_attached")?.evidence).toMatch(/someone-elses-worker/);
  });
});
