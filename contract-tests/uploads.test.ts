import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BASE_URL } from "./base-url.js";
import { addUser, api, apiJson, errorOf } from "./client.js";
import type { Json } from "./client.js";

/**
 * The staged-upload path against the deployed dev Worker and REAL R2
 * (AGENTS.md, "One call uploads a drop"; docs/spec-v1.md, "Staged upload
 * path"). What only this seam can prove: R2 refuses a blob whose bytes do not
 * hash to the key and leaves the key absent; every session key is written
 * once; a retry after an abort at each step converges on one drop.
 */
type File = { path: string; bytes: Buffer; sha256: string };

const file = (path: string, bytes: Buffer): File => ({
  path,
  bytes,
  sha256: createHash("sha256").update(bytes).digest("hex"),
});

const manifestOf = (files: File[]) => files.map((f) => ({ path: f.path, size: f.bytes.length, sha256: f.sha256 }));

type Session = {
  upload_id: string;
  drop_id: string;
  slug: string;
  missing: string[];
  put_urls: Record<string, string>;
  expires: string;
};

async function open(files: File[], extra: Json = {}, init: RequestInit = {}): Promise<Session> {
  const response = await api("/_api/v1/uploads", {
    ...init,
    method: "POST",
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    body: JSON.stringify({ manifest: manifestOf(files), ...extra }),
  });
  expect([200, 201], await response.clone().text()).toContain(response.status);
  return (await response.json()) as Session;
}

/** The signed URL is the only credential: no bearer on a PUT. */
const put = (url: string, bytes: Buffer, init: RequestInit = {}) =>
  fetch(url, { ...init, method: "PUT", body: bytes, cache: "no-store" });

async function putAll(session: Session, files: File[]): Promise<void> {
  for (const f of files) {
    const url = session.put_urls[f.sha256];
    if (url === undefined) continue;
    const response = await put(url, f.bytes);
    expect(response.status, await response.clone().text()).toBe(200);
  }
}

const commit = (id: string, body: Json, init: RequestInit = {}) =>
  api(`/_api/v1/uploads/${id}/commit`, {
    ...init,
    method: "POST",
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    body: JSON.stringify(body),
  });

const devHead = async (key: string): Promise<{ found: boolean; uploaded?: string; size?: number }> =>
  (await (await apiJson("/_dev/r2/head", "POST", { key })).json()) as { found: boolean; uploaded?: string };

const devKeys = async (prefix: string): Promise<string[]> =>
  ((await (await apiJson("/_dev/r2/list", "POST", { prefix })).json()) as { keys: string[] }).keys;

describe("session → PUT → commit", () => {
  it("publishes a 5 MiB file straight to its blob key and serves identical bytes", async () => {
    const big = file("big.bin", randomBytes(5 * 1024 * 1024));
    const index = file("index.html", Buffer.from("<h1>big</h1>"));
    const session = await open([big, index]);
    expect(session.missing.sort()).toEqual([big.sha256, index.sha256].sort());

    await putAll(session, [big, index]);
    // Straight to the final key: no staging prefix ever existed.
    expect(await devKeys(`drops/${session.drop_id}/`)).toEqual(
      [big, index].map((f) => `drops/${session.drop_id}/blobs/${f.sha256}`).sort(),
    );

    const response = await commit(session.upload_id, { title: "Big", expires: "7d" });
    expect(response.status, await response.clone().text()).toBe(201);
    const drop = (await response.json()) as Json;
    expect(drop.slug).toBe(session.slug);
    expect(drop.url).toBe(`${BASE_URL}/${session.slug}/`);

    const served = await fetch(`${drop.url as string}big.bin`, { cache: "no-store" });
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("application/octet-stream");
    const body = Buffer.from(await served.arrayBuffer());
    expect(body.length).toBe(big.bytes.length);
    expect(createHash("sha256").update(body).digest("hex")).toBe(big.sha256);
  }, 90_000);

  it("writes each of the three session keys exactly once; a repeat commit replays", async () => {
    const f = file("a.txt", Buffer.from("once"));
    const session = await open([f]);
    await putAll(session, [f]);
    const first = await commit(session.upload_id, { title: "Once" });
    expect(first.status).toBe(201);
    const drop = (await first.json()) as Json;

    const keys = ["session.json", "commit", "result"].map((name) => `uploads/${session.upload_id}/${name}`);
    const before = await Promise.all(keys.map(devHead));
    for (const head of before) expect(head.found).toBe(true);
    // Write-once: a fresh claim on any of them is refused by R2.
    for (const key of keys) {
      const claim = await (await apiJson("/_dev/r2/claim", "POST", { key, body: "x" })).json();
      expect(claim).toEqual({ claimed: false });
    }

    const again = await commit(session.upload_id, { title: "Once" });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(drop);
    const after = await Promise.all(keys.map(devHead));
    expect(after.map((h) => h.uploaded)).toEqual(before.map((h) => h.uploaded));

    const other = await commit(session.upload_id, { title: "Twice" });
    expect(await errorOf(other)).toMatchObject({ status: 409, code: "IDEMPOTENCY_MISMATCH" });
  }, 60_000);
});

describe("R2 verifies the bytes", () => {
  it("a tampered PUT is HASH_MISMATCH, the key stays absent, and commit refuses", async () => {
    const f = file("a.txt", Buffer.from("genuine bytes"));
    const session = await open([f]);
    const url = session.put_urls[f.sha256]!;

    const tampered = await put(url, Buffer.from("tampered bytes"));
    expect(await errorOf(tampered)).toMatchObject({ status: 422, code: "HASH_MISMATCH" });
    expect((await devHead(`drops/${session.drop_id}/blobs/${f.sha256}`)).found).toBe(false);

    const refused = await errorOf(await commit(session.upload_id, {}));
    expect(refused).toMatchObject({ status: 400, code: "INVALID_INPUT" });
    expect((refused.body.error as Json).message).toContain(f.sha256);

    const short = await put(url, Buffer.from("short"));
    expect(await errorOf(short)).toMatchObject({ status: 422, code: "HASH_MISMATCH" });

    // The genuine bytes still go through: a PUT is retryable.
    expect((await put(url, f.bytes)).status).toBe(200);
    expect((await commit(session.upload_id, {})).status).toBe(201);
  }, 60_000);

  it("refuses a forged or expired signature", async () => {
    const f = file("a.txt", Buffer.from("x"));
    const session = await open([f]);
    const url = session.put_urls[f.sha256]!;
    expect(await errorOf(await put(url.replace(/sig=[0-9a-f]+/, `sig=${"0".repeat(64)}`), f.bytes))).toMatchObject({
      status: 401,
      code: "UNAUTHENTICATED",
    });
    expect(await errorOf(await put(url.replace(/exp=\d+/, "exp=1"), f.bytes))).toMatchObject({
      status: 401,
      code: "UNAUTHENTICATED",
    });
  });
});

describe("interruption at every step converges", () => {
  it("after the session: a rerun under the same key returns the same session, still missing everything", async () => {
    const f = file("a.txt", Buffer.from("after-session"));
    const key = `upload-${crypto.randomUUID()}`;
    const first = await open([f], { idempotency_key: key });
    const again = await open([f], { idempotency_key: key });
    expect(again.upload_id).toBe(first.upload_id);
    expect(again.slug).toBe(first.slug);
    expect(again.missing).toEqual([f.sha256]);
    await putAll(again, [f]);
    expect((await commit(again.upload_id, {})).status).toBe(201);
  }, 60_000);

  it("after N PUTs: the rerun asks only for what is not there", async () => {
    const a = file("a.txt", Buffer.from("first of two"));
    const b = file("b.txt", Buffer.from("second of two"));
    const key = `upload-${crypto.randomUUID()}`;
    const first = await open([a, b], { idempotency_key: key });
    expect((await put(first.put_urls[a.sha256]!, a.bytes)).status).toBe(200);

    const again = await open([a, b], { idempotency_key: key });
    expect(again.missing).toEqual([b.sha256]);
    expect(again.put_urls[a.sha256]).toBeUndefined();
    await putAll(again, [a, b]);
    const response = await commit(again.upload_id, { title: "Two" });
    expect(response.status, await response.clone().text()).toBe(201);
    const drop = (await response.json()) as Json;
    expect((drop.files as Json[]).map((x) => x.path)).toEqual(["a.txt", "b.txt"]);
  }, 60_000);

  it.each(["claim", "meta", "projections"])("after the commit %s: the retry finishes the same drop", async (point) => {
    const f = file("index.html", Buffer.from(`<p>${point}</p>`));
    const session = await open([f]);
    await putAll(session, [f]);
    const body = { title: `Fault ${point}`, expires: "14d" };

    const failed = await commit(session.upload_id, body, { headers: { "DEV-Fault": point } });
    expect(failed.status).toBe(500);
    if (point === "claim") {
      // Nothing served yet: the fault sits before meta.json.
      expect((await fetch(`${BASE_URL}/${session.slug}/`, { cache: "no-store" })).status).toBe(404);
    }

    const retried = await commit(session.upload_id, body);
    expect([200, 201], await retried.clone().text()).toContain(retried.status);
    const drop = (await retried.json()) as Json;
    expect(drop.title).toBe(`Fault ${point}`);
    expect(drop.slug).toBe(session.slug);

    const served = await fetch(drop.url as string, { cache: "no-store" });
    expect(await served.text()).toBe(`<p>${point}</p>`);

    const again = await commit(session.upload_id, body);
    expect(await again.json()).toEqual(drop);
    // Exactly one drop, exactly one generation.
    expect(await devKeys(`drops/${session.drop_id}/`)).toEqual([
      `drops/${session.drop_id}/blobs/${f.sha256}`,
      `drops/${session.drop_id}/meta.json`,
    ]);
  }, 60_000);
});

describe("expiry, ownership and abandonment", () => {
  it("a session past its day is UPLOAD_EXPIRED on PUT and on commit; an unknown id too", async () => {
    const f = file("a.txt", Buffer.from("late"));
    const session = await open([f]);
    const later = new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString();
    expect(await errorOf(await put(session.put_urls[f.sha256]!, f.bytes, { headers: { "DEV-Clock": later } }))).toMatchObject({
      status: 401,
      code: "UNAUTHENTICATED", // the one-hour URL signature expires first
    });
    await putAll(session, [f]);
    expect(await errorOf(await commit(session.upload_id, {}, { headers: { "DEV-Clock": later } }))).toMatchObject({
      status: 410,
      code: "UPLOAD_EXPIRED",
    });
    expect(await errorOf(await commit("01ARZ3NDEKTSV4RRFFQ69G5FAV", {}))).toMatchObject({
      status: 410,
      code: "UPLOAD_EXPIRED",
    });
    // Abandoned: blobs and a pending pointer, no meta.json, nothing served.
    expect(await devKeys(`drops/${session.drop_id}/`)).toEqual([`drops/${session.drop_id}/blobs/${f.sha256}`]);
    expect((await fetch(`${BASE_URL}/${session.slug}/`, { cache: "no-store" })).status).toBe(404);
  }, 60_000);

  it("only the key that opened the session may commit it", async () => {
    const f = file("a.txt", Buffer.from("mine"));
    const session = await open([f]);
    await putAll(session, [f]);
    const other = await addUser(`uploader-${crypto.randomUUID().slice(0, 8)}`);
    const response = await api(`/_api/v1/uploads/${session.upload_id}/commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }, other.key);
    expect(await errorOf(response)).toMatchObject({ status: 403, code: "FORBIDDEN_SCOPE" });
  }, 60_000);
});

describe("update by staging", () => {
  it("flips one generation, skips blobs the drop holds, and refuses a drop that moved", async () => {
    const index = file("index.html", Buffer.from("<p>v1</p>"));
    const keep = file("keep.txt", Buffer.from("keep"));
    const first = await open([index, keep]);
    await putAll(first, [index, keep]);
    const v1 = (await (await commit(first.upload_id, { title: "V1" })).json()) as Json;

    const index2 = file("index.html", Buffer.from("<p>v2</p>"));
    const second = await open([index2, keep], { target: v1.slug });
    expect(second.slug).toBe(v1.slug);
    expect(second.missing).toEqual([index2.sha256]);
    await putAll(second, [index2, keep]);

    const response = await commit(second.upload_id, { meta: { rev: 2 } });
    expect(response.status, await response.clone().text()).toBe(200);
    const v2 = (await response.json()) as Json;
    expect(v2.title).toBe("V1");
    expect(v2.meta).toEqual({ rev: 2 });
    expect(await (await fetch(v1.url as string, { cache: "no-store" })).text()).toBe("<p>v2</p>");
    expect(await devKeys(`drops/${first.drop_id}/blobs/`)).toEqual(
      [index2, keep].map((f) => `drops/${first.drop_id}/blobs/${f.sha256}`).sort(),
    );

    // A third session, then someone else updates the title meanwhile.
    const index3 = file("index.html", Buffer.from("<p>v3</p>"));
    const third = await open([index3], { target: v1.slug });
    await putAll(third, [index3]);
    const moved = await apiJson(`/_api/v1/drops/${v1.slug as string}`, "PATCH", { title: "Moved" });
    expect(moved.status).toBe(200);
    expect(await errorOf(await commit(third.upload_id, {}))).toMatchObject({ status: 409, code: "UPDATE_CONFLICT" });
    expect(await (await fetch(v1.url as string, { cache: "no-store" })).text()).toBe("<p>v2</p>");
  }, 90_000);
});
