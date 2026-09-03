import { afterEach, describe, expect, it } from "vitest";
import { startFakeCloudflare } from "../../../../test/fake-cloudflare/src/server.js";
import { makeClient } from "../../src/init/cloudflare-client.js";
import { attachDomain, matchZone } from "../../src/init/domain.js";

const teardown: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (teardown.length > 0) await teardown.pop()!();
});

const ACCOUNT = "fake-account-id";

const ZONES = [
  { id: "z-example", name: "example.com", account: { id: ACCOUNT } },
  { id: "z-sub", name: "sub.example.com", account: { id: ACCOUNT } },
  { id: "z-other", name: "other.com", account: { id: "someone-else" } },
];

async function fake(options: Parameters<typeof startFakeCloudflare>[0] = {}) {
  const started = await startFakeCloudflare({ zones: ZONES, ...options });
  teardown.push(() => started.close());
  return { ...started, client: makeClient({ apiToken: "fake-token", accountId: ACCOUNT, apiBase: started.apiBase }) };
}

describe("matchZone", () => {
  it("picks the longest zone name that is a suffix of the hostname", async () => {
    const cf = await fake();

    const zone = await matchZone(cf.client, ACCOUNT, "drops.sub.example.com");

    expect(zone.ok && zone.zone.name).toBe("sub.example.com");
  });

  it("matches on label boundaries, never on a bare string suffix", async () => {
    const cf = await fake();

    const zone = await matchZone(cf.client, ACCOUNT, "notexample.com");

    expect(zone.ok).toBe(false);
  });

  it("accepts the zone apex itself", async () => {
    const cf = await fake();

    const zone = await matchZone(cf.client, ACCOUNT, "example.com");

    expect(zone.ok && zone.zone.name).toBe("example.com");
  });

  it("refuses a zone that lives in another account", async () => {
    const cf = await fake();

    const zone = await matchZone(cf.client, ACCOUNT, "drops.other.com");

    expect(zone.ok).toBe(false);
    expect(!zone.ok && zone.detail).toMatch(/other\.com/);
  });
});

describe("attachDomain", () => {
  it("attaches the hostname to the Worker and reports the canonical URL", async () => {
    const cf = await fake();

    const result = await attachDomain(cf.client, ACCOUNT, "dropthis-main", "drops.example.com");

    expect(result.ok).toBe(true);
    expect(result.ok && result.canonicalUrl).toBe("https://drops.example.com");
    expect(cf.state.workerDomains).toEqual([
      { id: "domain-1", hostname: "drops.example.com", service: "dropthis-main", zone_id: "z-example" },
    ]);
  });

  it("refuses when a DNS record already sits at that name", async () => {
    const cf = await fake({
      dnsRecords: [{ id: "r1", zoneId: "z-example", name: "drops.example.com", type: "CNAME" }],
    });

    const result = await attachDomain(cf.client, ACCOUNT, "dropthis-main", "drops.example.com");

    expect(result.ok).toBe(false);
    expect(!result.ok && result.detail).toMatch(/CNAME/);
    expect(cf.state.workerDomains).toEqual([]);
  });

  it("is a no-op when this Worker already serves that hostname", async () => {
    const cf = await fake();
    await attachDomain(cf.client, ACCOUNT, "dropthis-main", "drops.example.com");

    const again = await attachDomain(cf.client, ACCOUNT, "dropthis-main", "drops.example.com");

    expect(again.ok).toBe(true);
    expect(cf.state.workerDomains).toHaveLength(1);
  });

  it("refuses a hostname in no zone this account holds", async () => {
    const cf = await fake();

    const result = await attachDomain(cf.client, ACCOUNT, "dropthis-main", "drops.nowhere.test");

    expect(result.ok).toBe(false);
    expect(!result.ok && result.remediation).toMatch(/zone/i);
  });
});
