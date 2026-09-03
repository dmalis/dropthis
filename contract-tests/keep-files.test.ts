import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, describe, expect, it } from "vitest";
import { BASE_URL } from "./base-url.js";
import { adminKey, apiJson, errorOf } from "./client.js";
import type { Json } from "./client.js";

/**
 * Keep-by-hash file entries, against the deployed dev Worker (issue #17).
 *
 * The assertion no unit test can make is the one that matters: a kept blob is
 * not rewritten. `uploaded` on the R2 object is the proof — an object R2 wrote
 * again would carry a newer instant — and it is read through the dev probe,
 * the same way `storage.test.ts` reads the bucket.
 */

const publish = (body: unknown) => apiJson("/_api/v1/drops", "POST", body);

async function publishOk(body: unknown): Promise<Json> {
  const response = await publish(body);
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as Json;
}

async function updateOk(slug: string, body: unknown): Promise<Json> {
  const response = await apiJson(`/_api/v1/drops/${slug}`, "PATCH", body);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Json;
}

type FileRow = { path: string; sha256: string; size: number; content_type: string };
const filesOf = (drop: Json) => drop.files as FileRow[];

const head = async (key: string): Promise<{ found: boolean; uploaded: string | null }> => {
  const response = await apiJson("/_dev/r2/head", "POST", { key });
  return (await response.json()) as { found: boolean; uploaded: string | null };
};

/**
 * The drop's id, read from its slug pointer — the blob keys are
 * `drops/<id>/blobs/<sha256>`, and two drops on this instance can hold the same
 * digest, so the id is what makes "this drop's blob" a single key.
 */
const dropIdOf = async (slug: string): Promise<string> => {
  const response = await apiJson("/_dev/r2/get", "POST", { key: `slugs/${slug}` });
  const read = (await response.json()) as { found: boolean; body: string };
  expect(read.found).toBe(true);
  return read.body;
};

const blobKeyOf = async (slug: string, sha256: string): Promise<string> =>
  `drops/${await dropIdOf(slug)}/blobs/${sha256}`;

/** A tiny PNG, inlined as base64: the "binary an agent must not re-send" case. */
const LOGO_B64 = "iVBORw0KGgoAAAANSUhEUg==";

describe("keep-by-hash on update", () => {
  it("keeps the blob untouched, flips the generation and serves the same bytes", async () => {
    const drop = await publishOk({
      title: "keep-by-hash",
      files: [
        { path: "index.html", text: "<h1>v1</h1><img src=logo.png>" },
        { path: "logo.png", base64: LOGO_B64 },
      ],
      expires: "1d",
    });
    const slug = drop.slug as string;

    const logo = filesOf(drop).find((f) => f.path === "logo.png")!;
    const blobKey = await blobKeyOf(slug, logo.sha256);
    const before = await head(blobKey);
    expect(before.found, `the logo blob must exist at ${blobKey}`).toBe(true);

    const served = await fetch(`${BASE_URL}/${slug}/logo.png`, { cache: "no-store" });
    const bytesBefore = new Uint8Array(await served.arrayBuffer());

    const updated = await updateOk(slug, {
      files: [
        { path: "index.html", text: "<h1>v2</h1><img src=logo.png>" },
        { path: "logo.png", sha256: logo.sha256 },
      ],
    });

    // A new generation, and the kept row is byte-for-byte the old one.
    expect(updated.slug).toBe(slug);
    const keptRow = filesOf(updated).find((f) => f.path === "logo.png")!;
    expect(keptRow).toEqual(logo);
    expect(filesOf(updated).find((f) => f.path === "index.html")!.sha256).not.toBe(
      filesOf(drop).find((f) => f.path === "index.html")!.sha256,
    );

    // The proof: R2 never wrote that key again. The control is the file that DID
    // change — its blob was written by this same update, so `uploaded` is newer.
    // Without it, an `uploaded` R2 never moves would pass this test vacuously.
    const after = await head(blobKey);
    expect(after.found).toBe(true);
    expect(before.uploaded).toBeTruthy();
    expect(after.uploaded).toBe(before.uploaded);

    const changed = await head(
      await blobKeyOf(slug, filesOf(updated).find((f) => f.path === "index.html")!.sha256),
    );
    expect(changed.found).toBe(true);
    expect(Date.parse(changed.uploaded!)).toBeGreaterThan(Date.parse(before.uploaded!));

    // And the visitor still gets the same bytes, plus the new page.
    const again = await fetch(`${BASE_URL}/${slug}/logo.png`, { cache: "no-store" });
    expect(new Uint8Array(await again.arrayBuffer())).toEqual(bytesBefore);
    const page = await fetch(`${BASE_URL}/${slug}/`, { cache: "no-store" });
    expect(await page.text()).toContain("<h1>v2</h1>");
  });

  it("keeps a held blob under a new path, and drops the old one", async () => {
    const drop = await publishOk({
      title: "keep-rename",
      files: [{ path: "logo.png", base64: LOGO_B64 }],
      expires: "1d",
    });
    const slug = drop.slug as string;
    const logo = filesOf(drop)[0]!;

    const updated = await updateOk(slug, {
      files: [{ path: "assets/mark.png", sha256: logo.sha256 }],
    });
    expect(filesOf(updated)).toEqual([
      { path: "assets/mark.png", sha256: logo.sha256, size: logo.size, content_type: "image/png" },
    ]);

    const moved = await fetch(`${BASE_URL}/${slug}/assets/mark.png`, { cache: "no-store" });
    expect(moved.status).toBe(200);
    const gone = await fetch(`${BASE_URL}/${slug}/logo.png`, { cache: "no-store" });
    expect(gone.status).toBe(404);
  });

  it("refuses a hash this drop does not hold, naming the path and the hash", async () => {
    const drop = await publishOk({
      title: "keep-unknown",
      files: [{ path: "index.html", text: "<h1>hi</h1>" }],
      expires: "1d",
    });
    const unknown = "9".repeat(64);
    const failed = await errorOf(
      await apiJson(`/_api/v1/drops/${drop.slug as string}`, "PATCH", {
        files: [{ path: "logo.png", sha256: unknown }],
      }),
    );
    expect(failed).toMatchObject({ status: 400, code: "INVALID_INPUT" });
    const message = (failed.body.error as { message: string }).message;
    expect(message).toContain("logo.png");
    expect(message).toContain(unknown);
  });

  it("refuses a blob another drop holds: blobs are per drop", async () => {
    const other = await publishOk({
      title: "keep-other-drop",
      files: [{ path: "shared.txt", text: `shared ${Date.now()}` }],
      expires: "1d",
    });
    const mine = await publishOk({
      title: "keep-mine",
      files: [{ path: "index.html", text: "<h1>mine</h1>" }],
      expires: "1d",
    });
    const failed = await errorOf(
      await apiJson(`/_api/v1/drops/${mine.slug as string}`, "PATCH", {
        files: [{ path: "shared.txt", sha256: filesOf(other)[0]!.sha256 }],
      }),
    );
    expect(failed).toMatchObject({ status: 400, code: "INVALID_INPUT" });
  });

  it("refuses the kind on publish: a new drop holds nothing", async () => {
    const failed = await errorOf(
      await publish({ files: [{ path: "logo.png", sha256: "a".repeat(64) }] }),
    );
    expect(failed).toMatchObject({ status: 400, code: "INVALID_INPUT" });
    expect((failed.body.error as { message: string }).message).toContain("logo.png");
  });

  it("refuses an entry that carries both a keep and content", async () => {
    const drop = await publishOk({
      title: "keep-strict-union",
      files: [{ path: "index.html", text: "<h1>hi</h1>" }],
      expires: "1d",
    });
    const failed = await errorOf(
      await apiJson(`/_api/v1/drops/${drop.slug as string}`, "PATCH", {
        files: [{ path: "a.txt", sha256: "a".repeat(64), text: "x" }],
      }),
    );
    expect(failed).toMatchObject({ status: 400, code: "INVALID_INPUT" });
  });
});

describe("keep-by-hash on the staged upload path", () => {
  const encoder = new TextEncoder();
  const sha256Of = async (bytes: Uint8Array): Promise<string> => {
    const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  };

  it("takes a size-less manifest entry as a keep and never asks for it", async () => {
    const asset = encoder.encode(`staged asset ${Date.now()}-${Math.random()}`);
    const v1 = encoder.encode("<p>staged v1</p>");
    const [assetHash, v1Hash] = [await sha256Of(asset), await sha256Of(v1)];

    const opened = await apiJson("/_api/v1/uploads", "POST", {
      manifest: [
        { path: "index.html", size: v1.length, sha256: v1Hash },
        { path: "data.bin", size: asset.length, sha256: assetHash },
      ],
    });
    expect(opened.status, await opened.clone().text()).toBe(201);
    const session = (await opened.json()) as { upload_id: string; put_urls: Record<string, string> };
    for (const [digest, url] of Object.entries(session.put_urls)) {
      const body = digest === assetHash ? asset : v1;
      const put = await fetch(url, {
        method: "PUT",
        body: body.slice().buffer as ArrayBuffer,
        headers: { "content-length": String(body.length) },
      });
      expect(put.status, await put.clone().text()).toBe(200);
    }
    const first = await apiJson(`/_api/v1/uploads/${session.upload_id}/commit`, "POST", {
      title: "staged keep",
      expires: "1d",
    });
    expect(first.status, await first.clone().text()).toBe(201);
    const drop = (await first.json()) as Json;
    const slug = drop.slug as string;

    const blobKey = await blobKeyOf(slug, assetHash);
    const before = await head(blobKey);
    expect(before.found).toBe(true);

    // The second session names the asset with no size: keep it.
    const v2 = encoder.encode("<p>staged v2</p>");
    const v2Hash = await sha256Of(v2);
    const reopened = await apiJson("/_api/v1/uploads", "POST", {
      target: slug,
      manifest: [
        { path: "index.html", size: v2.length, sha256: v2Hash },
        { path: "data.bin", sha256: assetHash },
      ],
    });
    expect(reopened.status, await reopened.clone().text()).toBe(201);
    const second = (await reopened.json()) as {
      upload_id: string;
      missing: string[];
      put_urls: Record<string, string>;
    };
    expect(second.missing).toEqual([v2Hash]);

    const put = await fetch(second.put_urls[v2Hash]!, {
      method: "PUT",
      body: v2.slice().buffer as ArrayBuffer,
      headers: { "content-length": String(v2.length) },
    });
    expect(put.status, await put.clone().text()).toBe(200);

    const committed = await apiJson(`/_api/v1/uploads/${second.upload_id}/commit`, "POST", {});
    expect(committed.status, await committed.clone().text()).toBe(200);
    const updated = (await committed.json()) as Json;
    expect(filesOf(updated)).toEqual([
      { path: "index.html", sha256: v2Hash, size: v2.length, content_type: "text/html" },
      {
        path: "data.bin",
        sha256: assetHash,
        size: asset.length,
        content_type: "application/octet-stream",
      },
    ]);

    const after = await head(blobKey);
    expect(after.uploaded).toBe(before.uploaded);

    const served = await fetch(`${BASE_URL}/${slug}/data.bin`, { cache: "no-store" });
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(asset);
  });

  it("refuses a size-less entry with no target", async () => {
    const failed = await errorOf(
      await apiJson("/_api/v1/uploads", "POST", {
        manifest: [{ path: "logo.png", sha256: "b".repeat(64) }],
      }),
    );
    expect(failed).toMatchObject({ status: 400, code: "INVALID_INPUT" });
    expect((failed.body.error as { message: string }).message).toContain("logo.png");
  });
});

describe("the keep kind is documented where an agent reads it", () => {
  const clients: Client[] = [];
  afterAll(async () => {
    for (const client of clients) await client.close().catch(() => undefined);
  });

  it("/_skill.md tells the agent to send unchanged files as {path, sha256}", async () => {
    const response = await fetch(`${BASE_URL}/_skill.md`, { cache: "no-store" });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("{path, sha256}");
    expect(text).toContain("`dropthis_publish` refuses the kind");
  });

  it("the update tool's files description names the keep kind", async () => {
    const client = new Client({ name: "contract-tests", version: "0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE_URL}/_api/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${adminKey()}` } },
    });
    await client.connect(transport as unknown as Parameters<Client["connect"]>[0]);
    clients.push(client);

    const listed = await client.listTools();
    const update = listed.tools.find((tool) => tool.name === "dropthis_update")!;
    expect(JSON.stringify(update.inputSchema)).toContain("{path, sha256}");
  });
});
