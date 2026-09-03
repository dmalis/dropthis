import { createHash, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, describe, expect, it } from "vitest";
import { INITIAL_POLICY } from "../packages/worker/src/policy/defaults.js";
import { BASE_URL } from "./base-url.js";
import { addUser, adminKey, api, errorOf } from "./client.js";
import type { Json } from "./client.js";

/**
 * `POST /_api/mcp` against the deployed dev Worker, driven by the MCP SDK's
 * own client — the transport a real agent uses, over a real network, with
 * real R2 behind the tools.
 *
 * The claims are the contract's: the bearer gate and its 401 with the OAuth
 * pointer; the tool list per scope; that a tool call produces the same object
 * REST produces for the same drop; that every refusal is the catalogue's
 * error object in-band; and that `/_skill.md` prints THIS instance's limits.
 */
const clients: Client[] = [];

async function connect(key: string): Promise<Client> {
  const client = new Client({ name: "contract-tests", version: "0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE_URL}/_api/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${key}` } },
  });
  await client.connect(transport as unknown as Parameters<Client["connect"]>[0]);
  clients.push(client);
  return client;
}

afterAll(async () => {
  for (const client of clients) await client.close().catch(() => undefined);
});

const call = (client: Client, name: string, args: Record<string, unknown> = {}) =>
  client.callTool({ name, arguments: args }) as Promise<CallToolResult>;

const textOf = (result: CallToolResult): string =>
  result.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n");

const errorIn = (result: CallToolResult) =>
  (result.structuredContent as { error: { code: string; message: string; remediation: string; retryable: boolean } })
    .error;

const USER_TOOLS = [
  "dropthis_publish",
  "dropthis_update",
  "dropthis_get",
  "dropthis_list",
  "dropthis_delete",
  "dropthis_upload",
  "dropthis_commit",
];

const HELLO = {
  files: [
    { path: "index.html", text: "<h1>via mcp</h1>" },
    { path: "notes.md", text: "# notes" },
  ],
  title: "MCP hello",
  meta: { source: "contract-tests/mcp" },
};

describe("the bearer gate", () => {
  it("answers 401 with the catalogue object and the OAuth resource pointer", async () => {
    const response = await api(
      "/_api/mcp",
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      },
      "",
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer realm="dropthis", resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource/_api/mcp"`,
    );
    expect(await errorOf(response)).toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
  });

  it("refuses a key that resolves to nothing", async () => {
    const response = await api("/_api/mcp", { method: "POST", body: "{}" }, "f".repeat(64));
    expect(response.status).toBe(401);
  });

  it("holds no session stream: GET is 405", async () => {
    const response = await api("/_api/mcp", { headers: { accept: "text/event-stream" } });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });
});

describe("initialize and tools/list", () => {
  it("a user key sees the drop tools and the staged pair, each with its trigger clause", async () => {
    const anna = await addUser(`ct-mcp-${Math.random().toString(36).slice(2, 8)}`);
    const client = await connect(anna.key);
    expect(client.getServerVersion()?.name).toBe("dropthis");
    expect(client.getInstructions()).toContain(`${BASE_URL}/_skill.md`);

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(USER_TOOLS);
    for (const tool of tools) {
      expect(tool.description, tool.name).toMatch(/^Use when the user says: /);
      expect(Object.keys(tool.annotations ?? {}).sort(), tool.name).toEqual([
        "destructiveHint",
        "idempotentHint",
        "openWorldHint",
        "readOnlyHint",
        "title",
      ]);
    }
    expect(tools.find((tool) => tool.name === "dropthis_publish")!.description).toContain("share this");
  });

  it("the admin key sees the whole surface", async () => {
    const client = await connect(adminKey());
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(16);
    expect(tools.map((tool) => tool.name)).toEqual([
      ...USER_TOOLS,
      "dropthis_user_add",
      "dropthis_user_list",
      "dropthis_user_remove",
      "dropthis_config_get",
      "dropthis_config_set",
      "dropthis_usage",
      "dropthis_prune",
      "dropthis_doctor",
      "dropthis_doctor_checks",
    ]);
  });
});

describe("tools/call", () => {
  it("publish → get → update → delete round-trips and equals REST at every step", async () => {
    const client = await connect(adminKey());

    const published = await call(client, "dropthis_publish", HELLO);
    expect(published.isError, textOf(published)).toBeFalsy();
    const drop = published.structuredContent as { url: string; slug: string; files: unknown[] };
    expect(drop.url).toBe(`${BASE_URL}/${drop.slug}/`);
    expect(textOf(published).split("\n")[0]).toBe(`Published: ${drop.url}`);
    expect(JSON.parse(textOf(published).split("\n").slice(1).join("\n"))).toEqual(drop);

    // The URL serves what was published.
    const served = await fetch(drop.url, { cache: "no-store" });
    expect(served.status).toBe(200);
    expect(await served.text()).toBe("<h1>via mcp</h1>");

    // Same object as REST, both without and with content.
    const viaRest = (await (await api(`/_api/v1/drops/${drop.slug}`)).json()) as Json;
    const got = await call(client, "dropthis_get", { target: drop.url });
    expect(got.structuredContent).toEqual(viaRest);

    const viaRestFiles = (await (await api(`/_api/v1/drops/${drop.slug}?files=true`)).json()) as Json;
    const gotFiles = await call(client, "dropthis_get", { target: drop.slug, files: true });
    expect(gotFiles.structuredContent).toEqual(viaRestFiles);
    const files = (gotFiles.structuredContent as { files: Array<{ path: string; content?: string }> }).files;
    expect(files.map((file) => file.content)).toEqual(["<h1>via mcp</h1>", "# notes"]);

    const updated = await call(client, "dropthis_update", {
      target: drop.url,
      title: "MCP renamed",
      files: [{ path: "index.html", text: "<h1>v2</h1>" }],
      meta: { source: null, run: 2 },
    });
    expect(updated.isError, textOf(updated)).toBeFalsy();
    expect(updated.structuredContent).toMatchObject({
      title: "MCP renamed",
      meta: { run: 2 },
      files: [{ path: "index.html" }],
    });
    expect(await (await fetch(drop.url, { cache: "no-store" })).text()).toBe("<h1>v2</h1>");
    expect((await (await api(`/_api/v1/drops/${drop.slug}`)).json()) as Json).toEqual(
      updated.structuredContent,
    );

    // `q` filters WITHIN the page (AGENTS.md, "Responses and errors"), so a
    // small page proves nothing: `expiry.test.ts` and `cron.test.ts` publish
    // with a future `DEV-Clock`, and a drop created in 2032 keeps the top of
    // this newest-first listing for the whole run. One full page, as every
    // other contract file does.
    const listed = await call(client, "dropthis_list", { q: "MCP renamed", limit: 1000 });
    const page = listed.structuredContent as { drops: Array<{ slug: string }> };
    expect(page.drops.map((row) => row.slug)).toContain(drop.slug);

    const deleted = await call(client, "dropthis_delete", { target: drop.slug });
    expect(deleted.isError).toBeFalsy();
    expect(deleted.structuredContent).toBeUndefined();
    expect((await api(`/_api/v1/drops/${drop.slug}`)).status).toBe(404);
    expect((await fetch(drop.url, { cache: "no-store" })).status).toBe(404);
  });

  it("answers a missing drop with the catalogue's NOT_FOUND object, in-band", async () => {
    const client = await connect(adminKey());
    const result = await call(client, "dropthis_update", { target: "zzzzzzzzzz", title: "x" });
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(errorIn(result)).toEqual({
      code: "NOT_FOUND",
      message: expect.any(String),
      remediation: "See /_skill.md for the operation list.",
      retryable: false,
    });
    expect(JSON.parse(textOf(result))).toEqual(result.structuredContent);
  });

  it("answers a URL from another instance with WRONG_INSTANCE", async () => {
    const client = await connect(adminKey());
    const result = await call(client, "dropthis_get", { target: "https://someone-else.example/abcdefghij/" });
    expect(result.isError).toBe(true);
    expect(errorIn(result)).toMatchObject({ code: "WRONG_INSTANCE", retryable: false });
  });

  it("answers bad input with INVALID_INPUT, never a JSON-RPC error", async () => {
    const client = await connect(adminKey());
    const result = await call(client, "dropthis_publish", { ...HELLO, visibility: "public" });
    expect(result.isError).toBe(true);
    expect(errorIn(result)).toMatchObject({ code: "INVALID_INPUT", message: expect.stringContaining("visibility") });
  });

  it("keeps an admin tool invisible AND uncallable for a user key", async () => {
    const anna = await addUser(`ct-mcp-${Math.random().toString(36).slice(2, 8)}`);
    const client = await connect(anna.key);
    expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain("dropthis_user_list");
    const result = await call(client, "dropthis_user_list");
    expect(result.isError).toBe(true);
    expect(errorIn(result)).toMatchObject({ code: "FORBIDDEN_SCOPE" });
  });

  it("runs doctor as a tool, and doctor proves this same endpoint", async () => {
    const client = await connect(adminKey());
    const result = await call(client, "dropthis_doctor");
    expect(result.isError, textOf(result)).toBeFalsy();
    const report = result.structuredContent as { ok: boolean; checks: Array<{ id: string; status: string; evidence: string }> };
    expect(report.ok, JSON.stringify(report.checks)).toBe(true);
    const mcp = report.checks.find((check) => check.id === "mcp_initialize")!;
    expect(mcp.status).toBe("pass");
    expect(mcp.evidence).toContain("tools/list offers 16 tools");
  });
});

/**
 * Issue #19 (decision #93): the staged upload driven entirely through MCP,
 * the way a browser agent whose sandbox can run curl drives it. Only this
 * seam can prove it: the PUT leaves the MCP transport altogether and is
 * authorised by nothing but the HMAC in the URL the session handed back, and
 * R2 — not the Worker — verifies the digest.
 */
describe("the staged upload, over MCP only", () => {
  const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const entry = (path: string, bytes: Buffer) => ({ path, size: bytes.length, sha256: sha(bytes) });

  type Session = {
    upload_id: string;
    drop_id: string;
    slug: string;
    missing: string[];
    put_urls: Record<string, string>;
    expires: string;
  };

  /** Exactly what the tool text tells the agent to do, minus the shell. */
  const curl = (url: string, bytes: Buffer) =>
    fetch(url, { method: "PUT", body: new Uint8Array(bytes), cache: "no-store" });

  it("upload → PUT with no Authorization → commit → the drop serves the bytes", async () => {
    const anna = await addUser(`ct-up-${Math.random().toString(36).slice(2, 8)}`);
    const client = await connect(anna.key);

    // 1 MiB: past nothing here, but far past what any agent could type.
    const photo = randomBytes(1024 * 1024);
    const page = Buffer.from("<h1>staged over mcp</h1>");
    const opened = await call(client, "dropthis_upload", {
      manifest: [entry("index.html", page), entry("photo.jpg", photo)],
    });
    expect(opened.isError, textOf(opened)).toBeFalsy();
    const session = opened.structuredContent as unknown as Session;
    expect(session.missing.sort()).toEqual([sha(page), sha(photo)].sort());
    expect(textOf(opened)).toContain("dropthis_commit");

    // Every URL is absolute on the canonical origin and carries no key.
    for (const url of Object.values(session.put_urls)) {
      expect(url.startsWith(`${BASE_URL}/_api/v1/uploads/${session.upload_id}/blobs/`)).toBe(true);
      expect(url).not.toContain(anna.key);
    }

    // Committing now names the blob that is not there yet.
    const early = await call(client, "dropthis_commit", { id: session.upload_id, title: "too soon" });
    expect(early.isError).toBe(true);
    expect(errorIn(early).code).toBe("INVALID_INPUT");
    expect(errorIn(early).message).toContain(sha(photo));

    for (const [digest, bytes] of [[sha(page), page], [sha(photo), photo]] as const) {
      const put = await curl(session.put_urls[digest]!, bytes);
      expect(put.status, await put.clone().text()).toBe(200);
    }

    const committed = await call(client, "dropthis_commit", {
      id: session.upload_id,
      title: "Staged over MCP",
      meta: { source: "contract-tests/mcp" },
    });
    expect(committed.isError, textOf(committed)).toBeFalsy();
    const drop = committed.structuredContent as unknown as {
      url: string;
      slug: string;
      title: string;
      files: Array<{ path: string; size: number; content_type: string }>;
    };
    expect(drop.slug).toBe(session.slug);
    expect(drop.url).toBe(`${BASE_URL}/${session.slug}/`);
    expect(drop.title).toBe("Staged over MCP");
    expect(textOf(committed).split("\n")[0]).toBe(`Published: ${drop.url}`);
    expect(drop.files).toEqual([
      { path: "index.html", size: page.length, sha256: sha(page), content_type: "text/html" },
      { path: "photo.jpg", size: photo.length, sha256: sha(photo), content_type: "image/jpeg" },
    ]);

    const served = await fetch(`${drop.url}photo.jpg`, { cache: "no-store" });
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.from(await served.arrayBuffer()).equals(photo)).toBe(true);
    expect(await (await fetch(drop.url, { cache: "no-store" })).text()).toBe(page.toString());

    // A repeat commit replays the same Drop, byte for byte.
    const replay = await call(client, "dropthis_commit", {
      id: session.upload_id,
      title: "Staged over MCP",
      meta: { source: "contract-tests/mcp" },
    });
    expect(replay.isError, textOf(replay)).toBeFalsy();
    expect(replay.structuredContent).toEqual(committed.structuredContent);

    // And REST sees exactly the drop MCP made.
    const viaRest = (await (await api(`/_api/v1/drops/${drop.slug}`)).json()) as Json;
    expect(viaRest).toMatchObject({ url: drop.url, title: "Staged over MCP" });

    await call(client, "dropthis_delete", { target: drop.slug });
  });

  it("refuses a tampered signature, and the blob never lands", async () => {
    const client = await connect(adminKey());
    const bytes = Buffer.from("tampered");
    const opened = await call(client, "dropthis_upload", { manifest: [entry("a.txt", bytes)] });
    const session = opened.structuredContent as unknown as Session;
    const url = new URL(session.put_urls[sha(bytes)]!);
    url.searchParams.set("sig", "0".repeat(url.searchParams.get("sig")!.length));

    const put = await curl(url.toString(), bytes);
    expect([401, 403]).toContain(put.status);

    const commit = await call(client, "dropthis_commit", { id: session.upload_id, title: "nope" });
    expect(commit.isError).toBe(true);
    expect(errorIn(commit).code).toBe("INVALID_INPUT");
    expect(errorIn(commit).message).toContain(sha(bytes));
  });

  it("updates an existing drop by its URL, replacing the whole file set", async () => {
    const client = await connect(adminKey());
    const published = await call(client, "dropthis_publish", HELLO);
    const drop = published.structuredContent as { url: string; slug: string };

    const bytes = Buffer.from("<h1>v2 by upload</h1>");
    const opened = await call(client, "dropthis_upload", {
      target: drop.url,
      manifest: [entry("index.html", bytes)],
    });
    expect(opened.isError, textOf(opened)).toBeFalsy();
    const session = opened.structuredContent as unknown as Session;
    expect(session.slug).toBe(drop.slug);

    const put = await curl(session.put_urls[sha(bytes)]!, bytes);
    expect(put.status, await put.clone().text()).toBe(200);

    const committed = await call(client, "dropthis_commit", { id: session.upload_id });
    expect(committed.isError, textOf(committed)).toBeFalsy();
    expect(committed.structuredContent).toMatchObject({
      url: drop.url,
      files: [{ path: "index.html" }],
    });
    expect(await (await fetch(drop.url, { cache: "no-store" })).text()).toBe(bytes.toString());
    // notes.md was in the published set and is gone: a generation flip, not a merge.
    expect((await fetch(`${drop.url}notes.md`, { cache: "no-store" })).status).toBe(404);

    await call(client, "dropthis_delete", { target: drop.slug });
  });

  it("answers a URL from another instance with WRONG_INSTANCE", async () => {
    const client = await connect(adminKey());
    const result = await call(client, "dropthis_upload", {
      target: "https://someone-else.example/abcdefghij/",
      manifest: [entry("a.txt", Buffer.from("x"))],
    });
    expect(result.isError).toBe(true);
    expect(errorIn(result)).toMatchObject({ code: "WRONG_INSTANCE", retryable: false });
  });

  it("returns a generated password once, on the commit that set it", async () => {
    const client = await connect(adminKey());
    const bytes = Buffer.from("<h1>locked</h1>");
    const opened = await call(client, "dropthis_upload", { manifest: [entry("index.html", bytes)] });
    const session = opened.structuredContent as unknown as Session;
    expect((await curl(session.put_urls[sha(bytes)]!, bytes)).status).toBe(200);

    const committed = await call(client, "dropthis_commit", {
      id: session.upload_id,
      title: "Locked, staged",
      password: "generate",
    });
    expect(committed.isError, textOf(committed)).toBeFalsy();
    const drop = committed.structuredContent as unknown as {
      url: string;
      slug: string;
      password: string;
      has_password: boolean;
    };
    expect(drop.has_password).toBe(true);
    expect(drop.password).toMatch(/^[\S]{16}$/);

    // Never again: not from get, not from the viewer.
    const got = await call(client, "dropthis_get", { target: drop.slug });
    expect(got.structuredContent).toMatchObject({ has_password: true });
    expect(got.structuredContent).not.toHaveProperty("password");
    expect((await fetch(drop.url, { cache: "no-store", redirect: "manual" })).status).toBe(401);

    await call(client, "dropthis_delete", { target: drop.slug });
  });
});

describe("GET /_skill.md", () => {
  it("is open, markdown, and prints this instance's live max_request_bytes", async () => {
    const response = await fetch(`${BASE_URL}/_skill.md`, { cache: "no-store" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const text = await response.text();
    expect(text).toContain(`# dropthis at ${BASE_URL}`);
    expect(text).toContain(`${INITIAL_POLICY.max_request_bytes} bytes`);
    expect(text).toContain(`${BASE_URL}/_api/mcp`);
    expect(text).toContain("### `dropthis_publish`");
    expect(text).toContain("never publish again");
    // The three ways to move bytes, this instance's own (issue #19).
    expect(text).toContain("curl -sS -T");
    expect(text).toContain("### `dropthis_upload`");
    expect(text).toContain("### `dropthis_commit`");
    expect(text).not.toMatch(/\{\{|\}\}/);
  });
});
