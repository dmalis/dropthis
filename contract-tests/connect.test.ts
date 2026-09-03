import { describe, expect, it } from "vitest";
import { BASE_URL } from "./base-url.js";
import { apiJson } from "./client.js";

/**
 * `/_connect` against the deployed instance (issue #21). The point of the page
 * is that the `user add` message can be forwarded as it stands, so the test
 * that matters is the one a colleague performs: take the URL out of the
 * message and open it.
 */
const CONFIG_KEY = "system/config.json";

const open = (path: string, init: RequestInit = {}) =>
  fetch(`${BASE_URL}${path}`, { cache: "no-store", redirect: "manual", ...init });

describe("GET /_connect", () => {
  it("is an open HTML page naming this instance's connector URL", async () => {
    const response = await open("/_connect");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(response.headers.get("cache-control")).toContain("no-cache");

    const html = await response.text();
    expect(html).toContain(`${BASE_URL}/_api/mcp`);
    expect(html).toContain(`${BASE_URL}/_skill.md`);
    for (const client of ["Claude Code", "Cursor", "Codex", "claude.ai"]) {
      expect(html).toContain(client);
    }
    // The page is a link that gets forwarded: it must never hold a key.
    expect(html).not.toMatch(/[0-9a-f]{64}/);
  });

  it("answers HEAD", async () => {
    const response = await open("/_connect", { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
  });
});

describe("the user add onboarding message", () => {
  it("links to a page that is actually there", async () => {
    const created = await apiJson("/_api/v1/users", "POST", {
      label: `connect-${Date.now().toString(36)}`,
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const result = (await created.json()) as {
      connect: { connect_page: string };
      message: string;
    };

    expect(result.message).toContain(result.connect.connect_page);
    const page = await fetch(result.connect.connect_page, { cache: "no-store" });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
  });
});

/**
 * One canonical origin: a readable GET on an alias is moved there, the way the
 * OAuth documents are. The dev instance has no second hostname, so the test
 * makes its own by telling the instance that THIS origin is an alias of
 * another one — and puts the config back, because every later test in the run
 * reads it.
 */
describe("an alias origin", () => {
  it("is redirected to the canonical origin, permanently", async () => {
    const read = async () => {
      const response = await apiJson("/_dev/r2/get", "POST", { key: CONFIG_KEY });
      return (await response.json()) as { found: boolean; body: string; etag: string };
    };
    const before = await read();
    expect(before.found).toBe(true);
    const stored = JSON.parse(before.body) as Record<string, unknown>;

    const swapped = await apiJson("/_dev/r2/cas", "POST", {
      key: CONFIG_KEY,
      etag: before.etag,
      body: JSON.stringify({
        ...stored,
        canonical_url: "https://canonical.example",
        alias_origins: [BASE_URL],
      }),
    });
    expect(swapped.status, await swapped.clone().text()).toBe(200);

    try {
      const response = await open("/_connect?x=1");
      expect(response.status).toBe(301);
      expect(response.headers.get("location")).toBe("https://canonical.example/_connect?x=1");
    } finally {
      const current = await read();
      const restored = await apiJson("/_dev/r2/cas", "POST", {
        key: CONFIG_KEY,
        etag: current.etag,
        body: before.body,
      });
      expect(restored.status, await restored.clone().text()).toBe(200);
    }

    expect(JSON.parse((await read()).body)).toEqual(stored);
  });
});
