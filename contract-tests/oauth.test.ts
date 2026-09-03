import { createHash, randomBytes } from "node:crypto";
import Cloudflare from "cloudflare";
import { describe, expect, it } from "vitest";
import { BASE_URL, DEV_INSTANCE, requireEnv } from "./base-url.js";
import { addUser, adminKey, api, apiJson } from "./client.js";

/**
 * The OAuth half of "one key, two presentations", replayed against the
 * deployed dev instance over plain HTTP — the spike's scripted flow (#72),
 * now in the corpus for good. A browser client that cannot send headers
 * connects through one paste-key page; what it gets is an alias for a key,
 * never a second identity; and revoking the key ends the session on the next
 * request. The Client ID Metadata Document case uses a drop published on this
 * very instance as the client's metadata URL: a real public https document
 * with no extra infrastructure.
 */
const REDIRECT = "http://localhost:8976/callback";
const MCP = `${BASE_URL}/_api/mcp`;
const USER_TOOLS = [
  "dropthis_publish",
  "dropthis_update",
  "dropthis_get",
  "dropthis_list",
  "dropthis_delete",
  "dropthis_upload",
  "dropthis_commit",
];

const label = (name: string) => `ct-oauth-${name}-${Math.random().toString(36).slice(2, 8)}`;

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();

function post(path: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
  return fetch(`${BASE_URL}${path}`, {
    method: "POST",
    redirect: "manual",
    cache: "no-store",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: form(fields),
  });
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function register(): Promise<string> {
  const response = await fetch(`${BASE_URL}/_oauth/register`, {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "dropthis contract test",
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
    resource: MCP,
    ...extra,
  }).toString();
}

type Tokens = { access_token: string; refresh_token: string; expires_in: number; token_type: string };

/** The whole dance as a headless browser client; returns the token set. */
async function connect(key: string, options: { clientId?: string; ttlHeader?: string } = {}) {
  const clientId = options.clientId ?? (await register());
  const { verifier, challenge } = pkce();
  const query = authorizeQuery(clientId, challenge);

  const page = await fetch(`${BASE_URL}/_oauth/authorize?${query}`, { cache: "no-store" });
  expect(page.status, await page.clone().text()).toBe(200);

  const submitted = await post(`/_oauth/authorize?${query}`, { key });
  expect(submitted.status, await submitted.clone().text()).toBe(302);
  const location = new URL(submitted.headers.get("location")!);
  expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
  expect(location.searchParams.get("state")).toBe("st4te");
  expect(location.searchParams.get("iss")).toBe(BASE_URL);
  const code = location.searchParams.get("code")!;
  expect(code).toBeTruthy();

  const exchanged = await post(
    "/_oauth/token",
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
      resource: MCP,
    },
    options.ttlHeader === undefined ? {} : { "DEV-Access-TTL": options.ttlHeader },
  );
  expect(exchanged.status, await exchanged.clone().text()).toBe(200);
  const tokens = (await exchanged.json()) as Tokens;
  expect(tokens.refresh_token).toBeTruthy();
  return { clientId, code, ...tokens };
}

async function refresh(clientId: string, refreshToken: string) {
  return post("/_oauth/token", {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });
}

/** One JSON-RPC call over Streamable HTTP; SSE or JSON answers both parsed. */
async function rpc(auth: string | undefined, method: string, params: unknown = {}, id = 1) {
  const response = await fetch(MCP, {
    method: "POST",
    cache: "no-store",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(auth === undefined ? {} : { authorization: auth }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await response.text();
  let body: unknown = null;
  if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const data = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter((line) => line.length > 0);
    body = data.length > 0 ? JSON.parse(data[data.length - 1]!) : null;
  } else if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, headers: response.headers, body, text };
}

const INITIALIZE = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "dropthis contract test", version: "0" },
};

async function toolNames(auth: string): Promise<string[]> {
  const init = await rpc(auth, "initialize", INITIALIZE);
  expect(init.status, init.text).toBe(200);
  const listed = await rpc(auth, "tools/list", {}, 2);
  expect(listed.status, listed.text).toBe(200);
  const tools = (listed.body as { result: { tools: Array<{ name: string }> } }).result.tools;
  return tools.map((tool) => tool.name).sort();
}

const UNAUTHENTICATED_BODY = {
  error: { code: "UNAUTHENTICATED", message: expect.any(String), remediation: expect.any(String), retryable: false },
};

/** The instance's `OAUTH_KV`, through the account API, for what-is-stored assertions. */
async function oauthKv() {
  const accountId = requireEnv("CLOUDFLARE_ACCOUNT_ID");
  const client = new Cloudflare({ apiToken: requireEnv("CLOUDFLARE_API_TOKEN") });
  let namespaceId: string | undefined;
  for await (const namespace of client.kv.namespaces.list({ account_id: accountId })) {
    if (namespace.title === `dropthis-${DEV_INSTANCE}-oauth`) namespaceId = namespace.id;
  }
  if (namespaceId === undefined) throw new Error(`no KV namespace dropthis-${DEV_INSTANCE}-oauth`);
  const id = namespaceId;
  return {
    async keys(prefix: string) {
      const found: Array<{ name: string; expiration?: number }> = [];
      for await (const key of client.kv.namespaces.keys.list(id, { account_id: accountId, prefix })) {
        found.push({ name: key.name, ...(key.expiration === undefined ? {} : { expiration: key.expiration }) });
      }
      return found;
    },
    async value(name: string) {
      // A grant key carries `:`; the REST path wants it encoded exactly once.
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${id}/values/${encodeURIComponent(name)}`,
        { headers: { authorization: `Bearer ${requireEnv("CLOUDFLARE_API_TOKEN")}` } },
      );
      expect(response.status, await response.clone().text()).toBe(200);
      return response.text();
    },
  };
}

describe("discovery", () => {
  it("answers a bare /_api/mcp with 401, the discovery pointer and the frozen error object", async () => {
    const response = await rpc(undefined, "initialize", INITIALIZE);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      `resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource/_api/mcp"`,
    );
    expect(response.body).toEqual(UNAUTHENTICATED_BODY);
  });

  it("serves both metadata documents on the canonical origin, CIMD and DCR advertised", async () => {
    const resource = await fetch(`${BASE_URL}/.well-known/oauth-protected-resource/_api/mcp`, { cache: "no-store" });
    expect(resource.status).toBe(200);
    expect(await resource.json()).toMatchObject({ resource: MCP, authorization_servers: [BASE_URL] });

    const server = await fetch(`${BASE_URL}/.well-known/oauth-authorization-server`, { cache: "no-store" });
    expect(server.status).toBe(200);
    expect(await server.json()).toMatchObject({
      issuer: BASE_URL,
      authorization_endpoint: `${BASE_URL}/_oauth/authorize`,
      token_endpoint: `${BASE_URL}/_oauth/token`,
      registration_endpoint: `${BASE_URL}/_oauth/register`,
      client_id_metadata_document_supported: true,
      code_challenge_methods_supported: ["S256"],
    });
  });
});

describe("the paste-key page", () => {
  it("is one form with one password input", async () => {
    const { challenge } = pkce();
    const response = await fetch(`${BASE_URL}/_oauth/authorize?${authorizeQuery(await register(), challenge)}`, { cache: "no-store" });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html.match(/<form\b/g)).toHaveLength(1);
    expect(html.match(/<input\b/g)).toHaveLength(1);
    expect(html).toMatch(/<input[^>]*type="password"[^>]*name="key"/);
    expect(html).not.toMatch(/\b(src|href)="https?:/);
  });

  it("re-renders on a wrong key with no code, and the token endpoint has nothing to exchange", async () => {
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const query = authorizeQuery(clientId, challenge);
    const response = await post(`/_oauth/authorize?${query}`, { key: "f".repeat(64) });
    expect(response.status).toBe(401);
    expect(response.headers.get("location")).toBeNull();
    const html = await response.text();
    expect(html.match(/<form\b/g)).toHaveLength(1);
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("code=");

    const forged = await post("/_oauth/token", {
      grant_type: "authorization_code",
      code: "forged:code:value",
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
    });
    expect(forged.status).toBe(400);
    expect(await forged.json()).toMatchObject({ error: "invalid_grant" });
  });
});

describe("the dance", () => {
  it("gives a user key exactly the user-scope tools, and the admin key more", async () => {
    const anna = await addUser(label("anna"));
    const user = await connect(anna.key);
    expect(await toolNames(`Bearer ${user.access_token}`)).toEqual([...USER_TOOLS].sort());

    const admin = await connect(adminKey());
    const adminTools = await toolNames(`Bearer ${admin.access_token}`);
    expect(adminTools).toEqual(expect.arrayContaining(USER_TOOLS));
    expect(adminTools.length).toBeGreaterThan(USER_TOOLS.length);
  });

  it("stores the grant with no expiration and never the key; the token reveals nothing", async () => {
    const anna = await addUser(label("anna"));
    const tokens = await connect(anna.key);
    expect(tokens.access_token).not.toContain(anna.key);
    expect(tokens.refresh_token).not.toContain(anna.key);

    const kv = await oauthKv();
    const grants = await kv.keys(`grant:${anna.id}:`);
    expect(grants.length).toBeGreaterThan(0);
    for (const grant of grants) {
      expect(grant, `grant ${grant.name} must not expire`).not.toHaveProperty("expiration");
      const stored = await kv.value(grant.name);
      expect(stored).not.toContain(anna.key);
      expect(stored).toContain(anna.id);
    }
  });

  it("keeps the bearer header in charge: a raw key works without any OAuth, a bad value is refused", async () => {
    const tools = await toolNames(`Bearer ${adminKey()}`);
    expect(tools).toEqual(expect.arrayContaining(USER_TOOLS));

    const refused = await rpc("Bearer not-a-key-and-not-a-token", "initialize", INITIALIZE);
    expect(refused.status).toBe(401);
    expect(refused.body).toEqual(UNAUTHENTICATED_BODY);
  });

  it("refreshes silently after the access token has expired, no one at the keyboard", async () => {
    const anna = await addUser(label("anna"));
    const tokens = await connect(anna.key, { ttlHeader: "60" });
    expect(tokens.expires_in).toBe(60);
    expect((await rpc(`Bearer ${tokens.access_token}`, "initialize", INITIALIZE)).status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 62_000));
    const expired = await rpc(`Bearer ${tokens.access_token}`, "initialize", INITIALIZE);
    expect(expired.status).toBe(401);

    const refreshed = await refresh(tokens.clientId, tokens.refresh_token);
    expect(refreshed.status, await refreshed.clone().text()).toBe(200);
    const next = (await refreshed.json()) as Tokens;
    expect(next.access_token).not.toBe(tokens.access_token);
    const call = await rpc(`Bearer ${next.access_token}`, "tools/call", {
      name: "dropthis_list",
      arguments: { limit: 1 },
    });
    expect(call.status, call.text).toBe(200);
    expect(call.body).toMatchObject({ result: expect.anything() });
  }, 110_000);

  it("ends every session behind a key on the very next request after user remove", async () => {
    const who = label("leaver");
    const leaver = await addUser(who);
    const tokens = await connect(leaver.key);
    const before = await rpc(`Bearer ${tokens.access_token}`, "tools/call", {
      name: "dropthis_list",
      arguments: { limit: 1 },
    });
    expect(before.status, before.text).toBe(200);

    const removed = await api(`/_api/v1/users/${encodeURIComponent(who)}`, { method: "DELETE" });
    expect(removed.status, await removed.clone().text()).toBe(204);

    const after = await rpc(`Bearer ${tokens.access_token}`, "tools/call", {
      name: "dropthis_list",
      arguments: { limit: 1 },
    });
    expect(after.status).toBe(401);
    expect(after.body).toEqual(UNAUTHENTICATED_BODY);

    const refreshed = await refresh(tokens.clientId, tokens.refresh_token);
    expect(refreshed.status).toBe(401);
    expect(await refreshed.json()).toMatchObject({ error: "invalid_grant" });
  });
});

describe("Client ID Metadata Documents", () => {
  /** A metadata document served by this instance itself: publish, then fill in its own URL. */
  async function publishMetadata(redirectUris: string[]): Promise<string> {
    const placeholder = await apiJson("/_api/v1/drops", "POST", {
      title: "ct-oauth client metadata",
      files: [{ path: "metadata.json", text: "{}" }],
    });
    expect(placeholder.status, await placeholder.clone().text()).toBe(201);
    const { slug } = (await placeholder.json()) as { slug: string };
    const clientId = `${BASE_URL}/${slug}/metadata.json`;
    const document = {
      client_id: clientId,
      client_name: "dropthis contract test (CIMD)",
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    };
    const filled = await apiJson(`/_api/v1/drops/${slug}`, "PATCH", {
      files: [{ path: "metadata.json", text: JSON.stringify(document) }],
    });
    expect(filled.status, await filled.clone().text()).toBe(200);
    return clientId;
  }

  it("completes the dance for a client_id that is a metadata URL", async () => {
    const clientId = await publishMetadata([REDIRECT]);
    const anna = await addUser(label("anna"));
    const tokens = await connect(anna.key, { clientId });
    expect(await toolNames(`Bearer ${tokens.access_token}`)).toEqual([...USER_TOOLS].sort());
  });

  it("refuses a redirect the document does not list, locally", async () => {
    const clientId = await publishMetadata(["http://localhost:8976/somewhere-else"]);
    const { challenge } = pkce();
    const response = await fetch(`${BASE_URL}/_oauth/authorize?${authorizeQuery(clientId, challenge)}`, {
      cache: "no-store",
      redirect: "manual",
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });

  it("refuses a private client_id URL without fetching it", async () => {
    const { challenge } = pkce();
    const query = authorizeQuery("https://10.0.0.1/metadata.json", challenge);
    const started = Date.now();
    const response = await fetch(`${BASE_URL}/_oauth/authorize?${query}`, { cache: "no-store", redirect: "manual" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_INPUT" } });
    // The provider's own fetch would wait out a 10 s timeout; the guard answers at once.
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
