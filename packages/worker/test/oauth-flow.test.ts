import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashKey } from "../src/auth/key.js";
import { DEV_HOOKS } from "../src/dev/enabled-hooks.js";
import { PRODUCTION_HOOKS } from "../src/dev/hooks.js";
import { createApp } from "../src/index.js";
import { ACCESS_TOKEN_TTL_SECONDS } from "../src/oauth/provider.js";
import { RESERVED_PREFIXES } from "../src/reserved.js";
import { CONFIG_KEY, keyHashKey, keyRecordKey } from "../src/storage/keys.js";
import { memoryBucket } from "./memory-bucket.js";
import type { MemoryBucket } from "./memory-bucket.js";
import { memoryKv } from "./memory-kv.js";
import type { MemoryKv } from "./memory-kv.js";

/**
 * The OAuth half of "one key, two presentations" (AGENTS.md, "Auth"), driven
 * end to end in memory: the provider runs under Node against a fake KV, the
 * real MCP surface answers behind it, and every assertion is about
 * the CONTRACT — one paste-key form, a token that is an alias for a key, a
 * connection that never expires on its own, and a revocation that lands on
 * the very next request. The same dance replays against the deployed dev
 * instance in `contract-tests/oauth.test.ts`; this file is the fast loop.
 */
/**
 * The provider advertises and performs CIMD only when the Worker runs with
 * `global_fetch_strictly_public`; it reads that from the `Cloudflare` global.
 * Under Node the global is ours to set — and a test below pins that the
 * repo's `wrangler.jsonc` really carries the flag.
 */
(globalThis as { Cloudflare?: unknown }).Cloudflare = {
  compatibilityFlags: { global_fetch_strictly_public: true },
};

const CANONICAL = "https://drops.example.test";
const ALIAS = "https://dropthis-main.someone.workers.dev";
const REDIRECT = "http://localhost:8976/callback";
const USER_KEY = "a".repeat(64);
const ADMIN_KEY = "b".repeat(64);

type Env = {
  BUCKET: MemoryBucket;
  OAUTH_KV: MemoryKv;
  HMAC_SECRET: string;
  DEV_ROUTES?: string;
};

let bucket: MemoryBucket;
let kv: MemoryKv;
let env: Env;
let app: ReturnType<typeof createApp>;
const realFetch = globalThis.fetch;

async function seedKey(key: string, id: string, label: string, scope: "admin" | "user") {
  const hash = await hashKey(key);
  bucket.seed(keyHashKey(hash), JSON.stringify({ id }));
  bucket.seed(
    keyRecordKey(id),
    JSON.stringify({ id, label, scope, hash, created: "2026-09-03T00:00:00Z" }),
  );
}

beforeEach(async () => {
  bucket = memoryBucket();
  kv = memoryKv();
  env = { BUCKET: bucket, OAUTH_KV: kv, HMAC_SECRET: "s".repeat(32) };
  bucket.seed(
    CONFIG_KEY,
    JSON.stringify({ canonical_url: CANONICAL, alias_origins: [ALIAS], instance_name: "main" }),
  );
  await seedKey(USER_KEY, "id-anna", "anna", "user");
  await seedKey(ADMIN_KEY, "admin", "admin", "admin");
  app = createApp(PRODUCTION_HOOKS);
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const ctx = () => ({ waitUntil() {}, passThroughOnException() {}, props: undefined as unknown });

function call(path: string, init: RequestInit = {}, origin = CANONICAL): Promise<Response> {
  return Promise.resolve(app.fetch(new Request(`${origin}${path}`, init), env, ctx() as never));
}

const form = (fields: Record<string, string>) =>
  new URLSearchParams(fields).toString();

const post = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
  call(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: form(fields),
  });

async function pkce() {
  const verifier = "v".repeat(43);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = Buffer.from(digest).toString("base64url");
  return { verifier, challenge };
}

async function register(): Promise<string> {
  const response = await call("/_oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "unit test client",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as { client_id: string }).client_id;
}

function authorizeQuery(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  return new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    state: "st4te",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${CANONICAL}/_api/mcp`,
    ...extra,
  }).toString();
}

/** The whole dance, as a browser client would run it; returns the token set. */
async function connect(key: string, clientId?: string) {
  const id = clientId ?? (await register());
  const { verifier, challenge } = await pkce();
  const query = authorizeQuery(id, challenge);
  const page = await call(`/_oauth/authorize?${query}`);
  expect(page.status, await page.clone().text()).toBe(200);
  const submitted = await post(`/_oauth/authorize?${query}`, { key });
  expect(submitted.status, await submitted.clone().text()).toBe(302);
  const location = new URL(submitted.headers.get("location")!);
  const code = location.searchParams.get("code")!;
  const exchanged = await post("/_oauth/token", {
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: id,
    code_verifier: verifier,
    resource: `${CANONICAL}/_api/mcp`,
  });
  expect(exchanged.status, await exchanged.clone().text()).toBe(200);
  const tokens = (await exchanged.json()) as {
    access_token: string;
    refresh_token?: string;
    token_type: string;
    expires_in: number;
  };
  return { clientId: id, code, location, ...tokens };
}

const mcp = (auth?: string, method = "tools/list", params: unknown = {}) =>
  call("/_api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(auth === undefined ? {} : { authorization: auth }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

/** The tool names a caller sees — the MCP surface's own answer to "who are you". */
async function toolNames(auth: string): Promise<string[]> {
  const response = await mcp(auth);
  expect(response.status, await response.clone().text()).toBe(200);
  const body = (await response.json()) as { result: { tools: Array<{ name: string }> } };
  return body.result.tools.map((tool) => tool.name).sort();
}

/** Who the surface attributes a publish to — the caller's identity, proven by a write. */
async function publishedBy(auth: string): Promise<{ id: string; label: string }> {
  const response = await mcp(auth, "tools/call", {
    name: "dropthis_publish",
    arguments: { title: "who am I", files: [{ path: "a.txt", text: "hi" }] },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const body = (await response.json()) as {
    result: { structuredContent: { created_by: { id: string; label: string } } };
  };
  return body.result.structuredContent.created_by;
}

const USER_TOOLS = [
  "dropthis_commit",
  "dropthis_delete",
  "dropthis_get",
  "dropthis_list",
  "dropthis_publish",
  "dropthis_update",
  "dropthis_upload",
];

const UNAUTHENTICATED_BODY = {
  error: {
    code: "UNAUTHENTICATED",
    message: expect.any(String),
    remediation: expect.any(String),
    retryable: false,
  },
};

describe("discovery, on the canonical origin", () => {
  it("serves authorization-server metadata with the /_oauth endpoints", async () => {
    const response = await call("/.well-known/oauth-authorization-server");
    expect(response.status).toBe(200);
    const metadata = (await response.json()) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      issuer: CANONICAL,
      authorization_endpoint: `${CANONICAL}/_oauth/authorize`,
      token_endpoint: `${CANONICAL}/_oauth/token`,
      registration_endpoint: `${CANONICAL}/_oauth/register`,
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
    });
    expect(metadata.grant_types_supported).toEqual(
      expect.arrayContaining(["authorization_code", "refresh_token"]),
    );
  });

  it("deploys with the compatibility flag CIMD needs", async () => {
    const template = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
    expect(template).toContain('"global_fetch_strictly_public"');
  });

  it("serves protected-resource metadata naming /_api/mcp", async () => {
    const response = await call("/.well-known/oauth-protected-resource/_api/mcp");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      resource: `${CANONICAL}/_api/mcp`,
      authorization_servers: [CANONICAL],
      bearer_methods_supported: ["header"],
    });
  });

  it("answers a bare /_api/mcp with 401, the discovery pointer and the frozen error object", async () => {
    const response = await mcp();
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      `resource_metadata="${CANONICAL}/.well-known/oauth-protected-resource/_api/mcp"`,
    );
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual(UNAUTHENTICATED_BODY);
  });

  it.each(["/_oauth/authorize?x=1", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/_api/mcp"])(
    "redirects GET %s on an alias origin to the canonical one",
    async (path) => {
      const response = await call(path, { redirect: "manual" }, ALIAS);
      expect(response.status).toBe(301);
      expect(response.headers.get("location")).toBe(`${CANONICAL}${path}`);
    },
  );

  it("reserves /_oauth and /.well-known so a slug can never shadow them", () => {
    expect(RESERVED_PREFIXES).toContain("/_oauth");
    expect(RESERVED_PREFIXES).toContain("/.well-known");
  });

  it("answers an unknown /_oauth path with the frozen 404 object", async () => {
    const response = await call("/_oauth/nope");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  });
});

describe("the authorize page", () => {
  it("is one form with one password input and no external resources", async () => {
    const { challenge } = await pkce();
    const query = authorizeQuery(await register(), challenge);
    const response = await call(`/_oauth/authorize?${query}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html.match(/<form\b/g)).toHaveLength(1);
    expect(html.match(/<input\b/g)).toHaveLength(1);
    expect(html).toMatch(/<input[^>]*type="password"[^>]*name="key"/);
    expect(html).not.toMatch(/\b(src|href)="https?:/);
    expect(html).not.toContain("code=");
    // The form posts back to the SAME validated request; nothing is trusted from a hidden field.
    expect(html).toContain(`action="/_oauth/authorize?${query.replace(/&/g, "&amp;")}"`);
  });

  it("refuses a request with no client_id locally, never by redirect", async () => {
    const response = await call("/_oauth/authorize");
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_INPUT" } });
  });

  it("refuses an unregistered redirect_uri locally", async () => {
    const { challenge } = await pkce();
    const query = authorizeQuery(await register(), challenge, { redirect_uri: "http://localhost:1/x" });
    const response = await call(`/_oauth/authorize?${query}`);
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });

  it("re-renders the form with an error line on a wrong key, and issues nothing", async () => {
    const { challenge } = await pkce();
    const query = authorizeQuery(await register(), challenge);
    const response = await post(`/_oauth/authorize?${query}`, { key: "f".repeat(64) });
    expect(response.status).toBe(401);
    expect(response.headers.get("location")).toBeNull();
    const html = await response.text();
    expect(html.match(/<form\b/g)).toHaveLength(1);
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("code=");
    expect(kv.keys().filter((key) => key.startsWith("grant:"))).toEqual([]);
  });

  it("issues a code to the registered redirect on the right key, with state and iss", async () => {
    const { challenge } = await pkce();
    const query = authorizeQuery(await register(), challenge);
    const response = await post(`/_oauth/authorize?${query}`, { key: USER_KEY });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
    expect(location.searchParams.get("code")).toBeTruthy();
    expect(location.searchParams.get("state")).toBe("st4te");
    expect(location.searchParams.get("iss")).toBe(CANONICAL);
  });
});

describe("tokens", () => {
  it("refuses a forged code and a wrong PKCE verifier", async () => {
    const { clientId, code } = await connect(USER_KEY);
    for (const [c, verifier] of [
      ["forged:code:value", "v".repeat(43)],
      [code, "w".repeat(43)],
    ] as const) {
      const response = await post("/_oauth/token", {
        grant_type: "authorization_code",
        code: c,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: verifier,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_grant" });
    }
  });

  it("always issues a refresh token, and stores the grant with NO expiration", async () => {
    const tokens = await connect(USER_KEY);
    expect(tokens.token_type.toLowerCase()).toBe("bearer");
    expect(tokens.refresh_token).toBeTruthy();
    // The grant is first stored while its code is unexchanged (a short TTL
    // is right there: an unexchanged code must not live forever), then
    // rewritten at the exchange. It is the LAST write that must not expire.
    const grantPuts = kv.puts.filter((put) => put.key.startsWith("grant:"));
    expect(grantPuts.length).toBeGreaterThan(1);
    const final = grantPuts[grantPuts.length - 1]!;
    expect(final.options ?? {}).not.toHaveProperty("expiration");
    expect(final.options ?? {}).not.toHaveProperty("expirationTtl");
    // The access token itself lives a year (decision #90d, amended; issue #20).
    expect(tokens.expires_in).toBe(ACCESS_TOKEN_TTL_SECONDS);
  });

  it("never lets the key into a token or into KV; the grant names the key id", async () => {
    const tokens = await connect(USER_KEY);
    expect(tokens.access_token).not.toContain(USER_KEY);
    expect(tokens.refresh_token).not.toContain(USER_KEY);
    for (const value of kv.values()) expect(value).not.toContain(USER_KEY);
    expect(kv.keys().some((key) => key.startsWith("grant:id-anna:"))).toBe(true);
  });

  it("resolves a token to the key's caller on /_api/mcp, scope from the record", async () => {
    const user = await connect(USER_KEY);
    expect(await toolNames(`Bearer ${user.access_token}`)).toEqual(USER_TOOLS);
    expect(await publishedBy(`Bearer ${user.access_token}`)).toEqual({ id: "id-anna", label: "anna" });

    const admin = await connect(ADMIN_KEY);
    const adminTools = await toolNames(`Bearer ${admin.access_token}`);
    expect(adminTools).toEqual(expect.arrayContaining(USER_TOOLS));
    expect(adminTools.length).toBeGreaterThan(USER_TOOLS.length);
    expect(await publishedBy(`Bearer ${admin.access_token}`)).toEqual({ id: "admin", label: "admin" });
  });

  it("refreshes silently into a working token", async () => {
    const tokens = await connect(USER_KEY);
    const refreshed = await post("/_oauth/token", {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token!,
      client_id: tokens.clientId,
    });
    expect(refreshed.status, await refreshed.clone().text()).toBe(200);
    const next = (await refreshed.json()) as { access_token: string; refresh_token: string };
    expect(next.access_token).not.toBe(tokens.access_token);
    expect(next.refresh_token).toBeTruthy();
    const response = await mcp(`Bearer ${next.access_token}`);
    expect(response.status).toBe(200);
  });

  it("refuses the token on the very next request once the key is removed, and its refresh", async () => {
    const tokens = await connect(USER_KEY);
    expect((await mcp(`Bearer ${tokens.access_token}`)).status).toBe(200);

    // The first write of `user remove`: the pointer goes, the record follows.
    await bucket.delete(keyHashKey(await hashKey(USER_KEY)));

    const refused = await mcp(`Bearer ${tokens.access_token}`);
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual(UNAUTHENTICATED_BODY);

    const refreshed = await post("/_oauth/token", {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token!,
      client_id: tokens.clientId,
    });
    expect(refreshed.status).toBe(401);
    expect(await refreshed.json()).toMatchObject({ error: "invalid_grant" });
  });
});

describe("the bearer header on /_api/mcp", () => {
  it("wins when it holds a raw key, without touching KV", async () => {
    const before = kv.puts.length;
    expect(await publishedBy(`Bearer ${ADMIN_KEY}`)).toEqual({ id: "admin", label: "admin" });
    expect(kv.puts.length).toBe(before);
  });

  it("is refused as UNAUTHENTICATED when it is neither a key nor a token", async () => {
    const response = await mcp("Bearer not-a-key-and-not-a-token");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(UNAUTHENTICATED_BODY);
  });
});

describe("Client ID Metadata Documents", () => {
  const CLIENT_ID = "https://client.example/oauth/metadata.json";

  function serveMetadata(document: Record<string, unknown>): string[] {
    const fetched: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      fetched.push(url);
      if (url !== CLIENT_ID) return new Response("not here", { status: 404 });
      return new Response(JSON.stringify(document), {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }) as typeof fetch;
    return fetched;
  }

  const metadata = (redirects: string[]) => ({
    client_id: CLIENT_ID,
    client_name: "Some connector",
    redirect_uris: redirects,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });

  it("completes the dance for a client_id that is a metadata URL", async () => {
    const fetched = serveMetadata(metadata([REDIRECT]));
    const tokens = await connect(USER_KEY, CLIENT_ID);
    expect(fetched).toContain(CLIENT_ID);
    expect(await publishedBy(`Bearer ${tokens.access_token}`)).toEqual({ id: "id-anna", label: "anna" });
  });

  /**
   * claude.ai is a CIMD client, and issue #20 could not tell whether it even
   * tried to refresh. The refresh grant is pinned here for that kind of
   * client too: the metadata document is fetched again at refresh time, so
   * a client that never registered still gets a new access token.
   */
  it("exchanges a refresh token for a client_id that is a metadata URL", async () => {
    serveMetadata(metadata([REDIRECT]));
    const tokens = await connect(USER_KEY, CLIENT_ID);
    const refreshed = await post("/_oauth/token", {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token!,
      client_id: CLIENT_ID,
    });
    expect(refreshed.status, await refreshed.clone().text()).toBe(200);
    const next = (await refreshed.json()) as { access_token: string; expires_in: number };
    expect(next.access_token).not.toBe(tokens.access_token);
    expect(next.expires_in).toBe(ACCESS_TOKEN_TTL_SECONDS);
    expect(await toolNames(`Bearer ${next.access_token}`)).toEqual(USER_TOOLS);
  });

  it("refuses a redirect the document does not list, locally", async () => {
    serveMetadata(metadata(["http://localhost:8976/other"]));
    const { challenge } = await pkce();
    const response = await call(`/_oauth/authorize?${authorizeQuery(CLIENT_ID, challenge)}`);
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });

  it("refuses a private client_id URL before any fetch", async () => {
    const fetched = serveMetadata(metadata([REDIRECT]));
    const { challenge } = await pkce();
    const query = authorizeQuery("https://10.0.0.1/metadata.json", challenge);
    const response = await call(`/_oauth/authorize?${query}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_INPUT" } });
    expect(fetched).toEqual([]);
  });
});

describe("the access-token TTL", () => {
  it("is a year by default, and the token's KV write carries that expiration", async () => {
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(365 * 24 * 60 * 60);
    const tokens = await connect(USER_KEY);
    expect(tokens.expires_in).toBe(ACCESS_TOKEN_TTL_SECONDS);

    const written = kv.puts.filter((put) => put.key.startsWith("token:"));
    expect(written.length).toBeGreaterThan(0);
    for (const put of written) {
      expect(put.options?.expirationTtl, `token ${put.key}`).toBe(ACCESS_TOKEN_TTL_SECONDS);
    }
  });

  it("honours DEV-Access-TTL only with DEV_ROUTES=1; production ignores it", async () => {
    const withHeader = (application: ReturnType<typeof createApp>, environment: Env) => async () => {
      const clientId = await (async () => {
        app = application;
        env = environment;
        return register();
      })();
      const { verifier, challenge } = await pkce();
      const query = authorizeQuery(clientId, challenge);
      const submitted = await post(`/_oauth/authorize?${query}`, { key: USER_KEY });
      const code = new URL(submitted.headers.get("location")!).searchParams.get("code")!;
      const exchanged = await post(
        "/_oauth/token",
        {
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT,
          client_id: clientId,
          code_verifier: verifier,
        },
        { "DEV-Access-TTL": "60" },
      );
      return ((await exchanged.json()) as { expires_in: number }).expires_in;
    };

    const base = env;
    expect(await withHeader(createApp(DEV_HOOKS), { ...base, DEV_ROUTES: "1" })()).toBe(60);
    expect(await withHeader(createApp(DEV_HOOKS), { ...base })()).toBe(ACCESS_TOKEN_TTL_SECONDS);
    expect(await withHeader(createApp(PRODUCTION_HOOKS), { ...base, DEV_ROUTES: "1" })()).toBe(
      ACCESS_TOKEN_TTL_SECONDS,
    );
  });
});
