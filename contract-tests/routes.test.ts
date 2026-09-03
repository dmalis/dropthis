import { describe, expect, it } from "vitest";
import { BASE_URL } from "./base-url.js";
import { api } from "./client.js";

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
  const paths = ["/_api", "/_apiXYZ", "/_api/", "/_api/v1/nope", "/_oauth/nope", "/.well-known/nope", "/_connect", "/_skill.md"];

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
