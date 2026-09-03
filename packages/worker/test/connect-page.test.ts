import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/bindings.js";
import { renderConnectPage } from "../src/connect-page.js";
import { createApp } from "../src/index.js";
import { INITIAL_POLICY } from "../src/policy/defaults.js";
import { connectFor, keyEnvVar } from "../src/registry/connect.js";
import { CONFIG_KEY } from "../src/storage/keys.js";
import { memoryBucket } from "./memory-bucket.js";
import type { MemoryBucket } from "./memory-bucket.js";

/**
 * `/_connect` is the URL the `user add` onboarding message sends a colleague
 * to (issue #21). It is the SAME payload the agent gets — `connectFor()` — so
 * the page and the structured object can never say different things, and like
 * the object it holds no key: a page is a link that gets forwarded.
 */
const ORIGIN = "https://drops.test";
const ALIAS = "https://alias.test";

const CONNECT = connectFor({
  canonicalUrl: ORIGIN,
  instanceName: "acme",
});

describe("renderConnectPage", () => {
  const html = renderConnectPage(CONNECT);

  it("prints the three URLs an agent or a person needs", () => {
    expect(html).toContain(`${ORIGIN}/_api/mcp`);
    expect(html).toContain(`${ORIGIN}/_api/v1`);
    expect(html).toContain(`${ORIGIN}/_skill.md`);
  });

  it("has a section for each of the four clients", () => {
    for (const name of ["Claude Code", "Cursor", "Codex", "claude.ai"]) {
      expect(html).toContain(name);
    }
  });

  it("gives Claude Code the header helper, so the key is in no config file", () => {
    expect(html).toContain("headersHelper");
    expect(html).toContain("dropthis auth-header --instance acme");
  });

  it("gives Cursor and Codex the env var name and the export line", () => {
    expect(html).toContain(keyEnvVar("acme"));
    expect(html).toContain(`export ${keyEnvVar("acme")}=`);
  });

  it("tells a claude.ai user to paste the key, and warns about Team plans", () => {
    expect(html.toLowerCase()).toContain("paste");
    expect(html).toContain("Owner");
    expect(html).toMatch(/Team|Enterprise/);
  });

  it("holds no key and needs no script", () => {
    expect(html).not.toMatch(/[0-9a-f]{64}/);
    expect(html).not.toContain("<script");
  });
});

describe("GET /_connect", () => {
  let bucket: MemoryBucket;
  let env: Env;

  beforeEach(() => {
    bucket = memoryBucket();
    bucket.seed(
      CONFIG_KEY,
      JSON.stringify({
        ...INITIAL_POLICY,
        canonical_url: ORIGIN,
        alias_origins: [ALIAS],
        instance_name: "acme",
      }),
    );
    env = { BUCKET: bucket, OAUTH_KV: {} as never, HMAC_SECRET: "s".repeat(32) };
  });

  const get = (url: string, method = "GET") =>
    createApp().fetch(new Request(url, { method }), env);

  it("is open HTML, noindex, and never cached as truth", async () => {
    const response = await get(`${ORIGIN}/_connect`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(response.headers.get("cache-control")).toContain("no-cache");
  });

  it("is built from this instance's own canonical URL and name", async () => {
    const html = await (await get(`${ORIGIN}/_connect`)).text();
    expect(html).toContain(`${ORIGIN}/_api/mcp`);
    expect(html).toContain(keyEnvVar("acme"));
    expect(html).not.toMatch(/[0-9a-f]{64}/);
  });

  it("answers HEAD", async () => {
    const response = await get(`${ORIGIN}/_connect`, "HEAD");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
  });

  it("redirects an alias origin to the canonical one", async () => {
    const response = await get(`${ALIAS}/_connect`);
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/_connect`);
  });

  it("owns exactly one path: anything under it is the control plane's 404", async () => {
    const response = await get(`${ORIGIN}/_connect/anything`);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
  });
});
