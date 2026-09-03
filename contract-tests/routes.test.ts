import { describe, expect, it } from "vitest";
import { BASE_URL } from "./base-url.js";
import { api, apiJson } from "./client.js";

/** Authenticated: an unknown route must 404, not 401. */
const get = (path: string, init?: RequestInit) => api(path, init ?? {});

const NOT_FOUND_BODY = {
  error: {
    code: "NOT_FOUND",
    message: "No such route.",
    remediation: "See /_skill.md for the operation list.",
    retryable: false,
  },
};

describe("health", () => {
  it("answers 200 with exactly {ok:true}, unauthenticated", async () => {
    const response = await get("/_api/v1/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("carries the noindex header", async () => {
    const response = await get("/_api/v1/health");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });
});

describe("unknown control-plane routes", () => {
  // `/_skill.md` is a real route since issue #8 (see mcp.test.ts); `/_oauth` and
  // `/_connect` are still reserved-but-unbuilt.
  const paths = ["/_api", "/_apiXYZ", "/_api/", "/_api/v1/nope", "/_oauth/authorize", "/_connect"];

  it.each(paths)("GET %s → 404 with the frozen error object", async (path) => {
    const response = await get(path);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual(NOT_FOUND_BODY);
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it.each(["/_api", "/_apiXYZ", "/_api/v1/nope"])(
    "POST %s → 404 with the frozen error object",
    async (path) => {
      const response = await get(path, { method: "POST", body: "{}" });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual(NOT_FOUND_BODY);
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    },
  );
});

describe("unknown viewer paths", () => {
  it("answers an HTML 404 page", async () => {
    const response = await get("/definitely-not-a-slug/");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("text/html");
    const body = await response.text();
    expect(body).toContain("<title>Not found</title>");
    expect(body).toContain("Not found");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });
});

/**
 * The viewer owns `/<slug>/…` and must own nothing else. Its route pattern is
 * `/:slug/*`, which matches every two-segment path in the instance — so a
 * first segment that cannot be a slug has to fall THROUGH the viewer, not be
 * answered by it. When it did not, the viewer silently swallowed every route
 * mounted after it: the whole `/_dev` probe surface answered 404 HTML.
 */
describe("a path the viewer does not own", () => {
  it("reaches a route mounted after the viewer, on GET", async () => {
    const response = await api("/_dev/bench/pbkdf2?iterations=1000&rounds=1");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
  });

  it("reaches a route mounted after the viewer, on POST", async () => {
    const response = await apiJson("/_dev/r2/list", "POST", { prefix: "system/" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { keys: string[] };
    expect(body.keys).toContain("system/config.json");
  });
});
