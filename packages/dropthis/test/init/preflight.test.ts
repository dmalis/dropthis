import { afterEach, describe, expect, it } from "vitest";
import { startFakeCloudflare } from "../../../../test/fake-cloudflare/src/server.js";
import { makeClient } from "../../src/init/cloudflare-client.js";
import { checkPermissions, checkToken, pinAccount, checkR2Subscription } from "../../src/init/preflight.js";

const teardown: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (teardown.length > 0) await teardown.pop()!();
});

async function fake(options: Parameters<typeof startFakeCloudflare>[0] = {}) {
  const started = await startFakeCloudflare(options);
  teardown.push(() => started.close());
  return started;
}

describe("checkToken", () => {
  it("reports active for a valid token", async () => {
    const cf = await fake();
    const client = makeClient({ apiToken: "fake-token", accountId: "fake-account-id", apiBase: cf.apiBase });

    const result = await checkToken(client);

    expect(result).toEqual({ ok: true, status: "active" });
  });

  it("reports the inactive status for a bad token, never throwing raw", async () => {
    const cf = await fake();
    const client = makeClient({ apiToken: "wrong-token", accountId: "fake-account-id", apiBase: cf.apiBase });

    const result = await checkToken(client);

    expect(result.ok).toBe(false);
  });
});

describe("pinAccount", () => {
  it("errors with NO_ACCOUNTS when the token sees zero accounts", async () => {
    const cf = await fake({ accounts: [] });
    const client = makeClient({ apiToken: "fake-token", accountId: "fake-account-id", apiBase: cf.apiBase });

    const result = await pinAccount(client);

    expect(result).toEqual({ ok: false, code: "NO_ACCOUNTS" });
  });

  it("pins the single visible account automatically", async () => {
    const cf = await fake({ accounts: [{ id: "acct-1", name: "Solo Account" }] });
    const client = makeClient({ apiToken: "fake-token", accountId: "fake-account-id", apiBase: cf.apiBase });

    const result = await pinAccount(client);

    expect(result).toEqual({ ok: true, accountId: "acct-1" });
  });

  it("refuses to guess between several accounts without --account-id", async () => {
    const cf = await fake({
      accounts: [
        { id: "acct-1", name: "One" },
        { id: "acct-2", name: "Two" },
      ],
    });
    const client = makeClient({ apiToken: "fake-token", accountId: "fake-account-id", apiBase: cf.apiBase });

    const result = await pinAccount(client);

    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "MULTIPLE_ACCOUNTS") {
      expect(result.accounts.map((a) => a.id)).toEqual(["acct-1", "acct-2"]);
    } else {
      expect.fail("expected MULTIPLE_ACCOUNTS");
    }
  });

  it("pins the given --account-id when it is visible among several", async () => {
    const cf = await fake({
      accounts: [
        { id: "acct-1", name: "One" },
        { id: "acct-2", name: "Two" },
      ],
    });
    const client = makeClient({ apiToken: "fake-token", accountId: "fake-account-id", apiBase: cf.apiBase });

    const result = await pinAccount(client, "acct-2");

    expect(result).toEqual({ ok: true, accountId: "acct-2" });
  });

  it("errors when the given --account-id is not visible to this token", async () => {
    const cf = await fake({ accounts: [{ id: "acct-1", name: "One" }] });
    const client = makeClient({ apiToken: "fake-token", accountId: "fake-account-id", apiBase: cf.apiBase });

    const result = await pinAccount(client, "acct-nope");

    expect(result).toEqual({ ok: false, code: "ACCOUNT_NOT_VISIBLE" });
  });
});

describe("checkR2Subscription", () => {
  it("passes when R2 is enabled", async () => {
    const cf = await fake({ r2SubscriptionEnabled: true });
    const client = makeClient({ apiToken: "fake-token", accountId: "fake-account-id", apiBase: cf.apiBase });

    const result = await checkR2Subscription(client, "fake-account-id");

    expect(result.ok).toBe(true);
  });

  it("names the exact dashboard URL when R2 was never enabled (10042)", async () => {
    const cf = await fake({ r2SubscriptionEnabled: false });
    const client = makeClient({ apiToken: "fake-token", accountId: "fake-account-id", apiBase: cf.apiBase });

    const result = await checkR2Subscription(client, "fake-account-id");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.dashboardUrl).toBe("https://dash.cloudflare.com/fake-account-id/r2");
    }
  });
});

describe("checkPermissions", () => {
  it("passes when the token has every permission it needs", async () => {
    const cf = await fake();
    const client = makeClient({ apiToken: "fake-token", accountId: "fake-account-id", apiBase: cf.apiBase });

    const result = await checkPermissions(client, "fake-account-id");

    expect(result).toEqual({ ok: true, missing: [] });
  });

  it("names the dashboard permission for R2, not the raw error code", async () => {
    const cf = await fake({ missingScopes: ["r2"] });
    const client = makeClient({ apiToken: "fake-token", accountId: "fake-account-id", apiBase: cf.apiBase });

    const result = await checkPermissions(client, "fake-account-id");

    expect(result.ok).toBe(false);
    expect(result.missing).toContainEqual(
      expect.objectContaining({ permission: "Workers R2 Storage:Edit" }),
    );
  });

  it("names the dashboard permission for KV", async () => {
    const cf = await fake({ missingScopes: ["kv"] });
    const client = makeClient({ apiToken: "fake-token", accountId: "fake-account-id", apiBase: cf.apiBase });

    const result = await checkPermissions(client, "fake-account-id");

    expect(result.missing).toContainEqual(
      expect.objectContaining({ permission: "Workers KV Storage:Edit" }),
    );
  });

  it("names the dashboard permission for Workers scripts", async () => {
    const cf = await fake({ missingScopes: ["workers"] });
    const client = makeClient({ apiToken: "fake-token", accountId: "fake-account-id", apiBase: cf.apiBase });

    const result = await checkPermissions(client, "fake-account-id");

    expect(result.missing).toContainEqual(
      expect.objectContaining({ permission: "Workers Scripts:Edit" }),
    );
  });

  it("reports every missing permission at once, not just the first", async () => {
    const cf = await fake({ missingScopes: ["r2", "kv", "workers"] });
    const client = makeClient({ apiToken: "fake-token", accountId: "fake-account-id", apiBase: cf.apiBase });

    const result = await checkPermissions(client, "fake-account-id");

    expect(result.missing).toHaveLength(3);
  });
});
