import { afterAll, describe, expect, it } from "vitest";
import { BASE_URL } from "./base-url.js";
import { api, apiJson } from "./client.js";

/**
 * One canonical origin, in the VIEWER (issue #26, decision #103). The
 * `/_connect` half of the same rule is in `connect.test.ts`; this file is the
 * half the issue was filed about — a drop was answered on two origins.
 *
 * The dev instance has one hostname, so the test makes a second one the way
 * `connect.test.ts` does: it tells the instance that THIS origin is an alias
 * of another, asserts, and puts the config back — every later file in the run
 * reads that key. The dev build memoises the origins for 0 ms, so the swap is
 * visible on the very next request.
 */
const CONFIG_KEY = "system/config.json";
const CANONICAL = "https://canonical.example";

const open = (path: string, init: RequestInit = {}) =>
  fetch(`${BASE_URL}${path}`, { cache: "no-store", redirect: "manual", ...init });

const readConfig = async () => {
  const response = await apiJson("/_dev/r2/get", "POST", { key: CONFIG_KEY });
  return (await response.json()) as { found: boolean; body: string; etag: string };
};

const writeConfig = async (etag: string, body: string) => {
  const response = await apiJson("/_dev/r2/cas", "POST", { key: CONFIG_KEY, etag, body });
  expect(response.status, await response.clone().text()).toBe(200);
};

let slug = "";

afterAll(async () => {
  if (slug !== "") await api(`/_api/v1/drops/${slug}`, { method: "DELETE" });
});

describe("a viewer request on an alias origin", () => {
  it("is moved to the canonical origin, and the drop serves again once it is not an alias", async () => {
    const created = await apiJson("/_api/v1/drops", "POST", {
      files: [
        { path: "index.html", text: "<h1>canonical</h1>" },
        { path: "notes.md", text: "# notes" },
      ],
      title: "alias origin",
    });
    expect(created.status, await created.clone().text()).toBe(201);
    slug = ((await created.json()) as { slug: string }).slug;

    // Before the swap this origin IS the canonical one: the drop serves.
    expect((await open(`/${slug}/`)).status).toBe(200);

    const before = await readConfig();
    expect(before.found).toBe(true);
    const stored = JSON.parse(before.body) as Record<string, unknown>;
    await writeConfig(
      before.etag,
      JSON.stringify({ ...stored, canonical_url: CANONICAL, alias_origins: [BASE_URL] }),
    );

    try {
      const root = await open(`/${slug}/`);
      expect(root.status).toBe(301);
      expect(root.headers.get("location")).toBe(`${CANONICAL}/${slug}/`);
      expect(root.headers.get("cache-control")).toContain("no-cache");

      // Path and query survive the move: a download link still downloads.
      const file = await open(`/${slug}/notes.md?download=1`);
      expect(file.status).toBe(301);
      expect(file.headers.get("location")).toBe(`${CANONICAL}/${slug}/notes.md?download=1`);

      // `/<slug>` is one hop, not two: the trailing slash is added by the move.
      const bare = await open(`/${slug}`);
      expect(bare.status).toBe(301);
      expect(bare.headers.get("location")).toBe(`${CANONICAL}/${slug}/`);

      // The control plane is addressed by whatever origin the client was given.
      expect((await open("/_api/v1/health")).status).toBe(200);
      const mcp = await api("/_api/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "contract-tests", version: "0" },
          },
        }),
      });
      expect(mcp.status, await mcp.clone().text()).toBe(200);
    } finally {
      const current = await readConfig();
      await writeConfig(current.etag, before.body);
    }

    expect(JSON.parse((await readConfig()).body)).toEqual(stored);
    // The whole point of restoring: the drop is reachable again, at once.
    const served = await open(`/${slug}/`);
    expect(served.status).toBe(200);
    expect(await served.text()).toContain("canonical");
  });
});
