import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { beforeEach, describe, expect, it } from "vitest";
import { hashKey } from "../src/auth/key.js";
import type { Env } from "../src/bindings.js";
import { createApp } from "../src/index.js";
import { INITIAL_POLICY } from "../src/policy/defaults.js";
import { CONFIG_KEY, keyHashKey, keyRecordKey } from "../src/storage/keys.js";
import { memoryBucket } from "./memory-bucket.js";
import type { MemoryBucket } from "./memory-bucket.js";

/**
 * `POST /_api/mcp` over the real Hono app with an in-memory bucket, driven by
 * the MCP SDK's own client through a fetch that never leaves the process.
 *
 * What is pinned here is OUR wiring: the bearer gate and its 401, the tool
 * list per scope, that a tool call runs the same operation REST runs and
 * hands back the same object, and that every refusal is the catalogue's
 * error object in-band — never a second error shape. The same calls replay
 * against the deployed dev Worker in `contract-tests/mcp.test.ts`.
 */
const ADMIN_KEY = "a".repeat(64);
const USER_KEY = "b".repeat(64);
const ORIGIN = "https://drops.test";

let bucket: MemoryBucket;
let env: Env;

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
  bucket.seed(
    CONFIG_KEY,
    JSON.stringify({
      ...INITIAL_POLICY,
      canonical_url: ORIGIN,
      alias_origins: ["https://alias.test"],
      instance_name: "unit",
    }),
  );
  await seedKey(ADMIN_KEY, "id-admin", "admin", "admin");
  await seedKey(USER_KEY, "id-anna", "anna", "user");
  env = { BUCKET: bucket, OAUTH_KV: {} as never, HMAC_SECRET: "s".repeat(32) };
});

const app = createApp();
const inProcess = (url: string | URL, init?: RequestInit): Promise<Response> =>
  Promise.resolve(app.fetch(new Request(url, init), env));

const rest = (path: string, init: RequestInit = {}, key = ADMIN_KEY) =>
  inProcess(`${ORIGIN}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${key}`, ...(init.headers ?? {}) },
  });

async function connect(key: string): Promise<Client> {
  const client = new Client({ name: "unit-test", version: "0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/_api/mcp`), {
    fetch: inProcess,
    requestInit: { headers: { authorization: `Bearer ${key}` } },
  });
  // The SDK's own option types are loose about `undefined`; this repo compiles strict.
  await client.connect(transport as unknown as Parameters<Client["connect"]>[0]);
  return client;
}

const call = (client: Client, name: string, args: Record<string, unknown> = {}) =>
  client.callTool({ name, arguments: args }) as Promise<CallToolResult>;

const textOf = (result: CallToolResult): string =>
  result.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n");

const HELLO = { files: [{ path: "index.html", text: "<h1>hello</h1>" }], title: "Hello" };

describe("the bearer gate on /_api/mcp", () => {
  it("answers 401 with the catalogue object and a WWW-Authenticate pointer", async () => {
    const response = await inProcess(`${ORIGIN}/_api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer realm="dropthis", resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/_api/mcp"`,
    );
    expect(await response.json()).toEqual({
      error: {
        code: "UNAUTHENTICATED",
        message: expect.any(String),
        remediation: "Send the instance key as `Authorization: Bearer <key>`.",
        retryable: false,
      },
    });
  });

  it("refuses a key that resolves to nothing the same way", async () => {
    const response = await rest("/_api/mcp", { method: "POST", body: "{}" }, "f".repeat(64));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("resource_metadata=");
  });

  it("holds no session stream: GET and DELETE are 405", async () => {
    for (const method of ["GET", "DELETE"]) {
      const response = await rest("/_api/mcp", {
        method,
        headers: { accept: "text/event-stream" },
      });
      expect(response.status, method).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    }
  });

  it("refuses a body over max_request_bytes before it reaches the transport", async () => {
    bucket.seed(
      CONFIG_KEY,
      JSON.stringify({ ...INITIAL_POLICY, max_request_bytes: 1024, canonical_url: ORIGIN }),
    );
    const response = await rest("/_api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "x", params: { pad: "x".repeat(2048) } }),
    });
    expect(response.status).toBe(413);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "PAYLOAD_TOO_LARGE",
    );
  });
});

describe("initialize and tools/list", () => {
  it("names the server and carries the cross-tool instructions", async () => {
    const client = await connect(USER_KEY);
    expect(client.getServerVersion()?.name).toBe("dropthis");
    expect(client.getInstructions()).toContain(`${ORIGIN}/_skill.md`);
    expect(client.getInstructions()).toContain("The URL is the identity");
  });

  it("shows a user key the five drop tools and the staged-upload pair", async () => {
    const client = await connect(USER_KEY);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "dropthis_publish",
      "dropthis_update",
      "dropthis_get",
      "dropthis_list",
      "dropthis_delete",
      "dropthis_upload",
      "dropthis_commit",
    ]);
    for (const tool of tools) {
      expect(tool.description, tool.name).toMatch(/^Use when the user says: /);
      expect(tool.annotations, tool.name).toEqual({
        title: expect.any(String),
        readOnlyHint: expect.any(Boolean),
        destructiveHint: expect.any(Boolean),
        idempotentHint: expect.any(Boolean),
        openWorldHint: expect.any(Boolean),
      });
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("shows the admin key the whole surface", async () => {
    const client = await connect(ADMIN_KEY);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(16);
    expect(tools.map((tool) => tool.name)).toContain("dropthis_user_add");
  });
});

describe("tools/call runs the registry operation", () => {
  it("publish → get → update → delete round-trips and matches REST", async () => {
    const client = await connect(USER_KEY);

    const published = await call(client, "dropthis_publish", HELLO);
    expect(published.isError, textOf(published)).toBeFalsy();
    const drop = published.structuredContent as {
      url: string;
      slug: string;
      title: string;
      files: unknown[];
    };
    expect(drop.url).toBe(`${ORIGIN}/${drop.slug}/`);
    expect(textOf(published).split("\n")[0]).toBe(`Published: ${drop.url}`);
    // The text channel carries the same object, for clients that hide structuredContent.
    expect(JSON.parse(textOf(published).split("\n").slice(1).join("\n"))).toEqual(drop);

    // The same Drop REST hands back, from the same bucket.
    const viaRest = (await (await rest(`/_api/v1/drops/${drop.slug}`)).json()) as Record<string, unknown>;
    const got = await call(client, "dropthis_get", { target: drop.url });
    expect(got.structuredContent).toEqual(viaRest);
    expect(Object.keys(got.structuredContent as object)).toEqual(Object.keys(viaRest));

    const updated = await call(client, "dropthis_update", { target: drop.slug, title: "Renamed" });
    expect(updated.isError, textOf(updated)).toBeFalsy();
    expect((updated.structuredContent as { title: string }).title).toBe("Renamed");
    expect(textOf(updated)).toContain(`Updated: ${drop.url}`);
    expect(((await (await rest(`/_api/v1/drops/${drop.slug}`)).json()) as { title: string }).title).toBe(
      "Renamed",
    );

    const byAlias = await call(client, "dropthis_get", { target: `https://alias.test/${drop.slug}/` });
    expect(byAlias.isError).toBeFalsy();

    const listed = await call(client, "dropthis_list", { limit: 10 });
    const page = listed.structuredContent as { drops: Array<{ slug: string }>; has_more: boolean };
    expect(page.drops.map((row) => row.slug)).toEqual([drop.slug]);
    expect(page.has_more).toBe(false);

    const deleted = await call(client, "dropthis_delete", { target: drop.url });
    expect(deleted.isError).toBeFalsy();
    expect(textOf(deleted)).toBe(`Deleted: ${drop.url}`);
    expect(deleted.structuredContent).toBeUndefined();
    expect((await rest(`/_api/v1/drops/${drop.slug}`)).status).toBe(404);
  });

  it("mirrors file content into structuredContent on get files: true", async () => {
    const client = await connect(USER_KEY);
    const { slug } = (await call(client, "dropthis_publish", HELLO)).structuredContent as { slug: string };
    const got = await call(client, "dropthis_get", { target: slug, files: true });
    const files = (got.structuredContent as { files: Array<{ path: string; content?: string }> }).files;
    expect(files[0]).toMatchObject({ path: "index.html", content: "<h1>hello</h1>" });
  });

  it("answers a missing drop with the catalogue's NOT_FOUND object, in-band", async () => {
    const client = await connect(USER_KEY);
    const result = await call(client, "dropthis_update", { target: "zzzzzzzzzz", title: "x" });
    expect(result.isError).toBe(true);
    const expected = {
      error: {
        code: "NOT_FOUND",
        message: expect.any(String),
        remediation: "See /_skill.md for the operation list.",
        retryable: false,
      },
    };
    expect(result.structuredContent).toEqual(expected);
    expect(result.content).toHaveLength(1);
    expect(JSON.parse(textOf(result))).toEqual(expected);
  });

  it("answers a URL from another instance with WRONG_INSTANCE", async () => {
    const client = await connect(USER_KEY);
    const result = await call(client, "dropthis_get", { target: "https://someone-else.example/abcdefghij/" });
    expect(result.isError).toBe(true);
    expect((result.structuredContent as { error: { code: string; message: string } }).error).toMatchObject({
      code: "WRONG_INSTANCE",
      message: expect.stringContaining(ORIGIN),
    });
  });

  it("answers bad input with INVALID_INPUT, never a JSON-RPC error", async () => {
    const client = await connect(USER_KEY);
    const unknownField = await call(client, "dropthis_publish", { ...HELLO, visibility: "public" });
    expect(unknownField.isError).toBe(true);
    expect((unknownField.structuredContent as { error: { code: string; message: string } }).error).toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining("visibility"),
    });

    const wrongType = await call(client, "dropthis_get", { target: 42 });
    expect((wrongType.structuredContent as { error: { code: string } }).error.code).toBe("INVALID_INPUT");

    const noTool = await call(client, "dropthis_resolve", { url: "x" });
    expect((noTool.structuredContent as { error: { code: string; message: string } }).error).toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining("dropthis_resolve"),
    });
  });

  it("keeps an admin tool invisible AND uncallable for a user key", async () => {
    const client = await connect(USER_KEY);
    const result = await call(client, "dropthis_user_list");
    expect(result.isError).toBe(true);
    expect((result.structuredContent as { error: { code: string } }).error.code).toBe("FORBIDDEN_SCOPE");
  });

  it("runs the admin operations for the admin key", async () => {
    const client = await connect(ADMIN_KEY);
    const users = await call(client, "dropthis_user_list");
    expect((users.structuredContent as { users: Array<{ label: string }> }).users.map((u) => u.label)).toEqual(
      ["admin", "anna"],
    );
    const config = await call(client, "dropthis_config_get");
    expect(config.isError).toBeFalsy();
    expect(textOf(config)).toContain("max_request_bytes");
  });
});

/**
 * Issue #19: `upload.create` names the drop with its OWN body field `target`,
 * not a path parameter, so the MCP layer resolves it in place — the one thing
 * `takesTarget` does not cover. What is pinned here is the translation; the
 * three-step handshake itself is proven against real R2 in
 * `contract-tests/mcp.test.ts`.
 */
describe("dropthis_upload resolves target the way every other drop tool does", () => {
  const manifest = [{ path: "big.bin", size: 3, sha256: "a".repeat(64) }];

  const open = (client: Client, target?: string) =>
    call(client, "dropthis_upload", target === undefined ? { manifest } : { target, manifest });

  it("takes the canonical URL, an alias URL and a bare slug for the same drop", async () => {
    const client = await connect(USER_KEY);
    const published = await call(client, "dropthis_publish", HELLO);
    const { slug } = published.structuredContent as { slug: string };

    for (const target of [`${ORIGIN}/${slug}/`, `https://alias.test/${slug}/`, slug]) {
      const session = await open(client, target);
      expect(session.isError, `${target}: ${textOf(session)}`).toBeFalsy();
      expect(session.structuredContent).toMatchObject({ slug });
    }
  });

  it("answers another instance's URL with WRONG_INSTANCE, before any storage", async () => {
    const client = await connect(USER_KEY);
    const before = bucket.keys().length;
    const session = await open(client, "https://someone-else.example/abcdefghij/");
    expect(session.isError).toBe(true);
    expect((session.structuredContent as { error: { code: string } }).error.code).toBe(
      "WRONG_INSTANCE",
    );
    expect(bucket.keys().length).toBe(before);
  });

  it("opens a new drop when target is omitted, and signs put_urls on the canonical origin", async () => {
    const client = await connect(USER_KEY);
    const session = await open(client);
    expect(session.isError, textOf(session)).toBeFalsy();
    const value = session.structuredContent as {
      upload_id: string;
      slug: string;
      missing: string[];
      put_urls: Record<string, string>;
    };
    expect(value.missing).toEqual(["a".repeat(64)]);
    const url = value.put_urls["a".repeat(64)]!;
    expect(url.startsWith(`${ORIGIN}/_api/v1/uploads/${value.upload_id}/blobs/`)).toBe(true);
    // The signature is the PUT's only credential; the key is never in the URL.
    expect(url).toContain("sig=");
    expect(url).not.toContain(USER_KEY);
    // No next hint on success (#51; issue #24, standards finding 1): the line
    // says what happened, and the tool text owns the three-step dance.
    expect(textOf(session)).not.toContain("dropthis_commit");
  });
});
