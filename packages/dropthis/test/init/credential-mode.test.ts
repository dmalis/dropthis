import { describe, expect, it, vi } from "vitest";
import { resolveCloudflareCredential, TOKEN_PERMISSIONS, TOKEN_URL } from "../../src/init/credential-mode.js";

const login = (token: string, accounts: Array<{ id: string; name: string }>) =>
  vi.fn().mockResolvedValue({ ok: true, token, accounts });

describe("resolveCloudflareCredential", () => {
  it("uses the environment token and never logs in, even when a terminal is there", async () => {
    const browserLogin = login("logged-in", [{ id: "a", name: "A" }]);

    const result = await resolveCloudflareCredential({
      env: { CLOUDFLARE_API_TOKEN: "env-token", CLOUDFLARE_ACCOUNT_ID: "acct-env" },
      interactive: true,
      browserLogin,
    });

    expect(result.ok && result.token).toBe("env-token");
    expect(result.ok && result.accountId).toBe("acct-env");
    expect(result.ok && result.source).toBe("env");
    expect(browserLogin).not.toHaveBeenCalled();
  });

  it("exits 4 with the token URL and the four permissions when nothing is set and nobody is there", async () => {
    const browserLogin = login("logged-in", [{ id: "a", name: "A" }]);

    const result = await resolveCloudflareCredential({ env: {}, interactive: false, browserLogin });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(4);
    expect(result.remediation).toContain(TOKEN_URL);
    for (const permission of TOKEN_PERMISSIONS) expect(result.remediation).toContain(permission);
    expect(browserLogin).not.toHaveBeenCalled();
  });

  it("signs a human in through the browser when exactly one account is visible", async () => {
    const browserLogin = login("logged-in", [{ id: "only", name: "Only" }]);

    const result = await resolveCloudflareCredential({ env: {}, interactive: true, browserLogin });

    expect(result.ok && result.token).toBe("logged-in");
    expect(result.ok && result.accountId).toBe("only");
    expect(result.ok && result.source).toBe("browser-login");
  });

  it("refuses to guess after a login that sees several accounts, and lists them", async () => {
    const browserLogin = login("logged-in", [
      { id: "a1", name: "One" },
      { id: "a2", name: "Two" },
    ]);

    const result = await resolveCloudflareCredential({ env: {}, interactive: true, browserLogin });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("a1");
    expect(result.message).toContain("a2");
    expect(result.remediation).toContain("--account-id");
  });

  it("takes --account-id as the answer to several accounts after a login", async () => {
    const browserLogin = login("logged-in", [
      { id: "a1", name: "One" },
      { id: "a2", name: "Two" },
    ]);

    const result = await resolveCloudflareCredential({
      env: {},
      interactive: true,
      accountId: "a2",
      browserLogin,
    });

    expect(result.ok && result.accountId).toBe("a2");
  });

  it("reports a failed login as a failure, not as a missing token", async () => {
    const browserLogin = vi.fn().mockResolvedValue({ ok: false, detail: "the browser never came back" });

    const result = await resolveCloudflareCredential({ env: {}, interactive: true, browserLogin });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toContain("the browser never came back");
  });

  it("is an error, not a silent half-credential, when only the account id is set", async () => {
    const browserLogin = login("logged-in", [{ id: "a", name: "A" }]);

    const result = await resolveCloudflareCredential({
      env: { CLOUDFLARE_ACCOUNT_ID: "acct-env" },
      interactive: false,
      browserLogin,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toContain("CLOUDFLARE_API_TOKEN");
  });
});
