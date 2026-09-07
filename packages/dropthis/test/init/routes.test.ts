/**
 * Issue #25: a Workers Route on the zone takes precedence over a Custom
 * Domain, so an instance can be deployed, attached and completely unreachable
 * on its own hostname. `init` finds the shadow and adds the one route that
 * wins over it; it never touches the foreign route.
 */
import { afterEach, describe, expect, it } from "vitest";
import { startFakeCloudflare } from "../../../../test/fake-cloudflare/src/server.js";
import { makeClient } from "../../src/init/cloudflare-client.js";
import { hostPatternMatches, reconcileRoute } from "../../src/init/routes.js";

const teardown: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (teardown.length > 0) await teardown.pop()!();
});

const ACCOUNT = "fake-account-id";
const ZONE = "z-example";

async function fake(options: Parameters<typeof startFakeCloudflare>[0] = {}) {
  const started = await startFakeCloudflare(options);
  teardown.push(() => started.close());
  return {
    ...started,
    client: makeClient({ apiToken: "fake-token", accountId: ACCOUNT, apiBase: started.apiBase }),
  };
}

describe("hostPatternMatches", () => {
  it("matches the host half of a route pattern, wildcards as any run of characters", () => {
    expect(hostPatternMatches("example.com/*", "example.com")).toBe(true);
    expect(hostPatternMatches("*.example.com/*", "drops.example.com")).toBe(true);
    // `*` is zero or more characters, but the literal dot after it is not:
    // `*.example.com` covers subdomains, `*example.com` covers the apex too.
    expect(hostPatternMatches("*.example.com/*", "example.com")).toBe(false);
    expect(hostPatternMatches("*example.com/*", "example.com")).toBe(true);
    expect(hostPatternMatches("example.com/blog*", "example.com")).toBe(true);
    expect(hostPatternMatches("example.com", "example.com")).toBe(true);
  });

  it("does not match a different host", () => {
    expect(hostPatternMatches("example.com/*", "drops.example.com")).toBe(false);
    expect(hostPatternMatches("*.example.net/*", "drops.example.com")).toBe(false);
    expect(hostPatternMatches("notexample.com/*", "example.com")).toBe(false);
  });

  it("treats a pattern with regex metacharacters as literal text", () => {
    expect(hostPatternMatches("a.example.com/*", "axexample.com")).toBe(false);
  });
});

describe("reconcileRoute", () => {
  it("adds <hostname>/* when a foreign route shadows the hostname", async () => {
    const cf = await fake({
      zoneRoutes: [
        { id: "r1", zoneId: ZONE, pattern: "*.example.com/*", script: "someone-elses-worker" },
      ],
    });

    const result = await reconcileRoute(cf.client, ZONE, "drops.example.com", "dropthis-main", {
      dryRun: false,
    });

    expect(result.status).toBe("created");
    expect(result.detail).toBe(
      "drops.example.com/* → dropthis-main (shadowed by *.example.com/* → someone-elses-worker)",
    );
    expect(
      cf.state.zoneRoutes.map((route) => `${route.pattern} -> ${route.script}`),
    ).toEqual(["*.example.com/* -> someone-elses-worker", "drops.example.com/* -> dropthis-main"]);
  });

  it("does nothing when no route shadows the hostname", async () => {
    const cf = await fake({
      zoneRoutes: [{ id: "r1", zoneId: ZONE, pattern: "blog.example.com/*", script: "other" }],
    });

    const result = await reconcileRoute(cf.client, ZONE, "drops.example.com", "dropthis-main", {
      dryRun: false,
    });

    expect(result.status).toBe("ok");
    expect(result.detail).toBe("no shadowing route");
    expect(cf.state.zoneRoutes).toHaveLength(1);
  });

  it("does nothing when a route already sends the hostname to this Worker", async () => {
    const cf = await fake({
      zoneRoutes: [
        { id: "r1", zoneId: ZONE, pattern: "*.example.com/*", script: "someone-elses-worker" },
        { id: "r2", zoneId: ZONE, pattern: "drops.example.com/*", script: "dropthis-main" },
      ],
    });

    const result = await reconcileRoute(cf.client, ZONE, "drops.example.com", "dropthis-main", {
      dryRun: false,
    });

    expect(result.status).toBe("ok");
    expect(result.detail).toBe("drops.example.com/* → dropthis-main is already there");
    expect(cf.state.zoneRoutes).toHaveLength(2);
  });

  it("--dry-run reports the same detail and creates nothing", async () => {
    const cf = await fake({
      zoneRoutes: [
        { id: "r1", zoneId: ZONE, pattern: "*.example.com/*", script: "someone-elses-worker" },
      ],
    });

    const result = await reconcileRoute(cf.client, ZONE, "drops.example.com", "dropthis-main", {
      dryRun: true,
    });

    expect(result.status).toBe("would_create");
    expect(result.detail).toBe(
      "drops.example.com/* → dropthis-main (shadowed by *.example.com/* → someone-elses-worker)",
    );
    expect(cf.state.zoneRoutes).toHaveLength(1);
  });

  it("names the missing permission and the route to add by hand when the write is refused", async () => {
    const cf = await fake({
      routeWriteForbidden: true,
      zoneRoutes: [
        { id: "r1", zoneId: ZONE, pattern: "*.example.com/*", script: "someone-elses-worker" },
      ],
    });

    const result = await reconcileRoute(cf.client, ZONE, "drops.example.com", "dropthis-main", {
      dryRun: false,
    });

    expect(result.status).toBe("error");
    expect(result.detail).toContain("Workers Routes:Edit");
    expect(result.detail).toContain("drops.example.com/* → dropthis-main");
    expect(cf.state.zoneRoutes).toHaveLength(1);
  });

  it("never modifies or deletes the shadowing route", async () => {
    const cf = await fake({
      zoneRoutes: [
        { id: "r1", zoneId: ZONE, pattern: "example.com/*", script: "notice" },
        { id: "r2", zoneId: ZONE, pattern: "*.example.com/*", script: "notice" },
      ],
    });

    await reconcileRoute(cf.client, ZONE, "drops.example.com", "dropthis-main", { dryRun: false });

    const untouched = cf.state.zoneRoutes.filter((route) => route.script === "notice");
    expect(untouched.map((route) => route.pattern)).toEqual(["example.com/*", "*.example.com/*"]);
    const calls = cf.state.calls.filter((call) => call.method === "DELETE" || call.method === "PUT");
    expect(calls.filter((call) => call.path.includes("/workers/routes"))).toEqual([]);
  });
});
