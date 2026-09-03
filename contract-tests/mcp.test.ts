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

const USER_TOOLS = ["dropthis_publish", "dropthis_update", "dropthis_get", "dropthis_list", "dropthis_delete"];

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
  it("a user key sees exactly the five drop tools, each with its trigger clause", async () => {
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
    expect(tools).toHaveLength(14);
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
    expect(mcp.evidence).toContain("tools/list offers 14 tools");
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
    expect(text).not.toMatch(/\{\{|\}\}/);
  });
});
