import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashKey } from "../src/auth/key.js";
import type { Env } from "../src/bindings.js";
import { DEV_HOOKS } from "../src/dev/enabled-hooks.js";
import { sha256Hex } from "../src/domain/meta.js";
import { createApp } from "../src/index.js";
import { INITIAL_POLICY } from "../src/policy/defaults.js";
import { OPERATIONS, operation, routeOf } from "../src/registry/index.js";
import { CONFIG_KEY, keyHashKey, keyRecordKey } from "../src/storage/keys.js";
import { memoryBucket } from "./memory-bucket.js";
import type { MemoryBucket } from "./memory-bucket.js";

/**
 * The staged-upload path at the route level: session → signed PUTs → commit
 * (AGENTS.md, "One call uploads a drop"; docs/spec-v1.md, "Staged upload
 * path"). These pin OUR wiring — what each route takes and answers, the fence
 * on commit, the write-once session keys. Whether R2 refuses a wrong digest is
 * proven in `contract-tests/uploads.test.ts`, never here.
 */
const ADMIN_KEY = "a".repeat(64);
const USER_KEY = "b".repeat(64);
const ORIGIN = "https://drops.test";

let bucket: MemoryBucket;
let env: Env;

const encoder = new TextEncoder();

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
    JSON.stringify({ ...INITIAL_POLICY, canonical_url: ORIGIN, alias_origins: [] }),
  );
  await seedKey(ADMIN_KEY, "id-admin", "admin", "admin");
  await seedKey(USER_KEY, "id-anna", "anna", "user");
  env = { BUCKET: bucket, OAUTH_KV: {} as never, HMAC_SECRET: "s".repeat(32), DEV_ROUTES: "1" };
});

const app = () => createApp(DEV_HOOKS);

const call = (path: string, init: RequestInit = {}, key = ADMIN_KEY) =>
  app().fetch(
    new Request(`${ORIGIN}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${key}`, ...(init.headers ?? {}) },
    }),
    env,
  );

const json = (path: string, method: string, body: unknown, init: RequestInit = {}, key?: string) =>
  call(
    path,
    {
      ...init,
      method,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
      body: JSON.stringify(body),
    },
    key,
  );

type Json = Record<string, unknown>;

async function errorOf(response: Response): Promise<{ status: number; code: string; message: string }> {
  const body = (await response.json()) as { error: { code: string; message: string } };
  return { status: response.status, code: body.error.code, message: body.error.message };
}

type File = { path: string; bytes: Uint8Array<ArrayBuffer>; sha256: string };

async function file(path: string, text: string): Promise<File> {
  const bytes = encoder.encode(text);
  return { path, bytes, sha256: await sha256Hex(bytes) };
}

const manifestOf = (files: File[]) =>
  files.map((f) => ({ path: f.path, size: f.bytes.length, sha256: f.sha256 }));

/** Serves one body at one URL, so a `url` manifest entry has something to fetch. */
function stubFetch(bodies: Record<string, Uint8Array>) {
  const spy = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const bytes = bodies[url];
    if (bytes === undefined) return new Response("no", { status: 404 });
    return new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]).stream(), {
      status: 200,
      headers: { "content-length": String(bytes.length) },
    });
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

type Session = {
  upload_id: string;
  drop_id: string;
  slug: string;
  missing: string[];
  put_urls: Record<string, string>;
  expires: string;
};

async function openSession(files: File[], extra: Json = {}, key?: string): Promise<Session> {
  const response = await json("/_api/v1/uploads", "POST", { manifest: manifestOf(files), ...extra }, {}, key);
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as Session;
}

/** A signed PUT carries no bearer: the signature is its only credential. */
const putBlob = (url: string, bytes: Uint8Array, headers: Record<string, string> = {}) =>
  app().fetch(
    new Request(url, {
      method: "PUT",
      headers: { "content-length": String(bytes.length), ...headers },
      body: bytes,
    }),
    env,
  );

async function uploadAll(session: Session, files: File[]) {
  for (const f of files) {
    const url = session.put_urls[f.sha256];
    if (url === undefined) continue;
    const response = await putBlob(url, f.bytes);
    expect(response.status, await response.clone().text()).toBe(200);
  }
}

const commit = (id: string, body: Json, init: RequestInit = {}, key?: string) =>
  json(`/_api/v1/uploads/${id}/commit`, "POST", body, init, key);

describe("a staged manifest with url entries", () => {
  it("does not ask the client to upload a url entry, and fetches it at commit", async () => {
    const page = await file("index.html", "<img src=logo.png>");
    const logo = await file("logo.png", "PNGBYTES");
    const spy = stubFetch({ "https://cdn.example/logo.png": logo.bytes });

    const response = await json("/_api/v1/uploads", "POST", {
      manifest: [
        ...manifestOf([page]),
        { path: logo.path, size: logo.bytes.length, sha256: logo.sha256, url: "https://cdn.example/logo.png" },
      ],
    });
    const session = (await response.json()) as Session;
    // The instance fetches it, so it is not the client's to send.
    expect(session.missing).toEqual([page.sha256]);
    expect(spy).not.toHaveBeenCalled();

    await uploadAll(session, [page]);
    const committed = await commit(session.upload_id, { title: "With a logo" });
    expect(committed.status, await committed.clone().text()).toBe(201);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(bucket.keys(`drops/${session.drop_id}/blobs/`)).toContain(
      `drops/${session.drop_id}/blobs/${logo.sha256}`,
    );
  });

  it("refuses a forbidden target when the session opens, before any blob moves", async () => {
    const page = await file("index.html", "hi");
    const response = await json("/_api/v1/uploads", "POST", {
      manifest: [
        ...manifestOf([page]),
        { path: "a.png", size: 4, sha256: "c".repeat(64), url: "http://169.254.169.254/" },
      ],
    });
    expect(await errorOf(response)).toMatchObject({ code: "FETCH_FAILED" });
  });

  it("answers FETCH_FAILED at commit when the target is gone", async () => {
    const logo = await file("logo.png", "PNGBYTES");
    stubFetch({});
    const response = await json("/_api/v1/uploads", "POST", {
      manifest: [
        { path: logo.path, size: logo.bytes.length, sha256: logo.sha256, url: "https://cdn.example/logo.png" },
      ],
    });
    const session = (await response.json()) as Session;
    expect(await errorOf(await commit(session.upload_id, {}))).toMatchObject({
      code: "FETCH_FAILED",
    });
  });
});

describe("the registry rows", () => {
  it("declares the three staged-upload routes, REST-only, in the frozen order", () => {
    const names = OPERATIONS.map((op) => op.name);
    expect(names.slice(names.indexOf("file_download") + 1, names.indexOf("user.add"))).toEqual([
      "upload.create",
      "upload.put",
      "upload.commit",
    ]);
    expect(routeOf(operation("upload.create"))).toBe("POST /_api/v1/uploads");
    expect(routeOf(operation("upload.put"))).toBe("PUT /_api/v1/uploads/:id/blobs/:sha256");
    expect(routeOf(operation("upload.commit"))).toBe("POST /_api/v1/uploads/:id/commit");
    for (const name of ["upload.create", "upload.put", "upload.commit"]) {
      expect(operation(name).restOnly, name).toBe(true);
    }
    expect(operation("upload.put").scope).toBe("signed");
  });
});

describe("POST /uploads", () => {
  it("allocates the drop, claims its slug and returns a signed URL per missing blob", async () => {
    const files = [await file("index.html", "<h1>big</h1>"), await file("a.txt", "a")];
    const session = await openSession(files);

    expect(session.slug).toMatch(/^[a-z0-9]{10}$/);
    expect(session.missing.sort()).toEqual(files.map((f) => f.sha256).sort());
    for (const f of files) {
      expect(session.put_urls[f.sha256]).toMatch(
        new RegExp(`^${ORIGIN}/_api/v1/uploads/${session.upload_id}/blobs/${f.sha256}\\?exp=\\d+&sig=[0-9a-f]{64}$`),
      );
    }
    expect(Date.parse(session.expires) - Date.now()).toBeGreaterThan(23 * 3600 * 1000);

    // The slug is claimed now, pointing at the allocated drop id, and marked pending.
    expect(bucket.read(`slugs/${session.slug}`)).toBe(session.drop_id);
    expect(bucket.keys(`uploads/${session.upload_id}/`)).toEqual([
      `uploads/${session.upload_id}/session.json`,
    ]);
    // Nothing is served yet.
    const viewer = await app().fetch(new Request(`${ORIGIN}/${session.slug}/`), env);
    expect(viewer.status).toBe(404);
  });

  it("refuses a manifest with no entries, a bad path or a file above max_file_bytes", async () => {
    expect(await errorOf(await json("/_api/v1/uploads", "POST", { manifest: [] }))).toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
    });
    expect(
      await errorOf(
        await json("/_api/v1/uploads", "POST", {
          manifest: [{ path: "../x", size: 1, sha256: "a".repeat(64) }],
        }),
      ),
    ).toMatchObject({ status: 400, code: "INVALID_PATH" });
    expect(
      await errorOf(
        await json("/_api/v1/uploads", "POST", {
          manifest: [{ path: "x.bin", size: INITIAL_POLICY.max_file_bytes + 1, sha256: "a".repeat(64) }],
        }),
      ),
    ).toMatchObject({ status: 400, code: "POLICY_VIOLATION" });
  });

  it("names an unknown target NOT_FOUND", async () => {
    const files = [await file("a.txt", "a")];
    const response = await json("/_api/v1/uploads", "POST", {
      target: "abcdefghij",
      manifest: manifestOf(files),
    });
    expect(await errorOf(response)).toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  it("with an idempotency_key, a rerun returns the same session and slug", async () => {
    const files = [await file("a.txt", "a")];
    const first = await openSession(files, { idempotency_key: "run-1" });
    const rerun = await json("/_api/v1/uploads", "POST", { manifest: manifestOf(files), idempotency_key: "run-1" });
    expect(rerun.status).toBe(200);
    const again = (await rerun.json()) as Session;
    expect(again.upload_id).toBe(first.upload_id);
    expect(again.slug).toBe(first.slug);
    expect(again.drop_id).toBe(first.drop_id);

    const other = await json("/_api/v1/uploads", "POST", {
      manifest: manifestOf([await file("b.txt", "b")]),
      idempotency_key: "run-1",
    });
    expect(await errorOf(other)).toMatchObject({ status: 409, code: "IDEMPOTENCY_MISMATCH" });
  });
});

describe("PUT /uploads/:id/blobs/:sha256", () => {
  it("writes the blob straight to drops/<id>/blobs/<sha256>, with no bearer", async () => {
    const files = [await file("a.txt", "hello")];
    const session = await openSession(files);
    const response = await putBlob(session.put_urls[files[0]!.sha256]!, files[0]!.bytes);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sha256: files[0]!.sha256, size: 5 });
    expect(bucket.read(`drops/${session.drop_id}/blobs/${files[0]!.sha256}`)).toBe("hello");
  });

  it("refuses a tampered or expired signature, and a body of the wrong size", async () => {
    const files = [await file("a.txt", "hello")];
    const session = await openSession(files);
    const url = session.put_urls[files[0]!.sha256]!;

    const forged = url.replace(/sig=[0-9a-f]+$/, `sig=${"0".repeat(64)}`);
    expect(await errorOf(await putBlob(forged, files[0]!.bytes))).toMatchObject({
      status: 401,
      code: "UNAUTHENTICATED",
    });

    const stale = url.replace(/exp=\d+/, "exp=1");
    expect(await errorOf(await putBlob(stale, files[0]!.bytes))).toMatchObject({
      status: 401,
      code: "UNAUTHENTICATED",
    });

    const short = await putBlob(url, encoder.encode("hell"));
    expect(await errorOf(short)).toMatchObject({ status: 422, code: "HASH_MISMATCH" });
    expect(bucket.keys(`drops/${session.drop_id}/blobs/`)).toEqual([]);
  });

  it("answers UPLOAD_EXPIRED for a session that is gone", async () => {
    const files = [await file("a.txt", "hello")];
    const session = await openSession(files);
    await bucket.delete(`uploads/${session.upload_id}/session.json`);
    expect(await errorOf(await putBlob(session.put_urls[files[0]!.sha256]!, files[0]!.bytes))).toMatchObject({
      status: 410,
      code: "UPLOAD_EXPIRED",
    });
  });
});

describe("POST /uploads/:id/commit", () => {
  it("refuses until every blob is there, naming the missing hashes", async () => {
    const files = [await file("index.html", "<p>x</p>"), await file("a.txt", "a")];
    const session = await openSession(files);
    await putBlob(session.put_urls[files[0]!.sha256]!, files[0]!.bytes);

    const refused = await errorOf(await commit(session.upload_id, {}));
    expect(refused).toMatchObject({ status: 400, code: "INVALID_INPUT" });
    expect(refused.message).toContain(files[1]!.sha256);
    expect(bucket.keys(`drops/${session.drop_id}/`)).toEqual([
      `drops/${session.drop_id}/blobs/${files[0]!.sha256}`,
    ]);
  });

  it("publishes the drop with the settings publish takes, then replays on repeat", async () => {
    const files = [await file("index.html", "<p>staged</p>"), await file("a.txt", "a")];
    const session = await openSession(files);
    await uploadAll(session, files);

    const first = await commit(session.upload_id, { title: "Staged", meta: { via: "cli" }, expires: "7d" });
    expect(first.status, await first.clone().text()).toBe(201);
    const drop = (await first.json()) as Json;
    expect(drop.slug).toBe(session.slug);
    expect(drop.url).toBe(`${ORIGIN}/${session.slug}/`);
    expect(drop.title).toBe("Staged");
    expect(drop.meta).toEqual({ via: "cli" });
    expect(drop.created_by).toEqual({ id: "id-admin", label: "admin" });
    expect(drop.files).toEqual([
      { path: "index.html", size: 13, sha256: files[0]!.sha256, content_type: "text/html" },
      { path: "a.txt", size: 1, sha256: files[1]!.sha256, content_type: "text/plain" },
    ]);

    const served = await app().fetch(new Request(`${ORIGIN}/${session.slug}/`), env);
    expect(served.status).toBe(200);
    expect(await served.text()).toBe("<p>staged</p>");

    const again = await commit(session.upload_id, { title: "Staged", meta: { via: "cli" }, expires: "7d" });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(drop);

    const other = await commit(session.upload_id, { title: "Other" });
    expect(await errorOf(other)).toMatchObject({ status: 409, code: "IDEMPOTENCY_MISMATCH" });

    // Every session key was written exactly once.
    expect(bucket.log.filter((line) => line.startsWith(`put uploads/${session.upload_id}/`))).toEqual([
      `put uploads/${session.upload_id}/session.json`,
      `put uploads/${session.upload_id}/commit`,
      `put uploads/${session.upload_id}/result`,
    ]);
  });

  it("takes password exactly as publish does, returns it once and replays it", async () => {
    const files = [await file("index.html", "<p>staged</p>")];
    const session = await openSession(files);
    await uploadAll(session, files);

    const first = await commit(session.upload_id, { title: "Locked", password: "generate" });
    expect(first.status, await first.clone().text()).toBe(201);
    const drop = (await first.json()) as Json;
    expect(drop.has_password).toBe(true);
    expect(typeof drop.password).toBe("string");
    expect((drop.password as string).length).toBe(16);

    // The unlock gate is on, and the generated password opens it.
    const locked = await app().fetch(new Request(`${ORIGIN}/${session.slug}/`), env);
    expect(locked.status).toBe(401);

    // A retry replays the SAME password — a second generate would never converge.
    const again = await commit(session.upload_id, { title: "Locked", password: "generate" });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(drop);
  });

  it("enforces the instance's password rule, which a staged publish cannot skip", async () => {
    bucket.seed(
      CONFIG_KEY,
      JSON.stringify({
        ...INITIAL_POLICY,
        canonical_url: ORIGIN,
        alias_origins: [],
        password: { ...INITIAL_POLICY.password, required: true, default: "generate" },
      }),
    );

    const files = [await file("a.txt", "a")];
    const session = await openSession(files);
    await uploadAll(session, files);

    const open = await commit(session.upload_id, { title: "Must lock", password: null });
    expect(await errorOf(open)).toMatchObject({ status: 400, code: "POLICY_VIOLATION" });

    const other = await openSession(files);
    await uploadAll(other, files);
    const created = await commit(other.upload_id, { title: "Must lock" });
    expect(created.status, await created.clone().text()).toBe(201);
    const drop = (await created.json()) as Json;
    expect(drop.has_password).toBe(true);
    expect(typeof drop.password).toBe("string");
  });

  it("leaves a target drop's password alone when the commit does not send one", async () => {
    const files = [await file("a.txt", "a")];
    const first = await json("/_api/v1/drops", "POST", {
      files: [{ path: "a.txt", text: "a" }],
      title: "Held",
      password: "hunter2hunter2",
    });
    expect(first.status, await first.clone().text()).toBe(201);
    const original = (await first.json()) as Json;

    const session = await openSession(files, { target: original.slug });
    await uploadAll(session, files);
    const committed = await commit(session.upload_id, { title: "Held still" });
    expect(committed.status, await committed.clone().text()).toBe(200);
    const drop = (await committed.json()) as Json;
    expect(drop.has_password).toBe(true);
    expect(drop.password).toBeUndefined();
  });

  it("is the session owner's alone", async () => {
    const files = [await file("a.txt", "a")];
    const session = await openSession(files);
    await uploadAll(session, files);
    expect(await errorOf(await commit(session.upload_id, {}, {}, USER_KEY))).toMatchObject({
      status: 403,
      code: "FORBIDDEN_SCOPE",
    });
  });

  it("answers UPLOAD_EXPIRED past the session's expiry and for an unknown id", async () => {
    const files = [await file("a.txt", "a")];
    const session = await openSession(files);
    await uploadAll(session, files);
    const later = new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString();
    expect(await errorOf(await commit(session.upload_id, {}, { headers: { "DEV-Clock": later } }))).toMatchObject({
      status: 410,
      code: "UPLOAD_EXPIRED",
    });
    expect(await errorOf(await commit("01ARZ3NDEKTSV4RRFFQ69G5FAV", {}))).toMatchObject({
      status: 410,
      code: "UPLOAD_EXPIRED",
    });
    // An abandoned session leaves blobs and a pending pointer, never a meta.json.
    expect(bucket.keys(`drops/${session.drop_id}/`)).toEqual([
      `drops/${session.drop_id}/blobs/${files[0]!.sha256}`,
    ]);
  });

  it("converges after an abort past the commit claim", async () => {
    const files = [await file("a.txt", "a")];
    const session = await openSession(files);
    await uploadAll(session, files);

    const failed = await commit(session.upload_id, { title: "T" }, { headers: { "DEV-Fault": "claim" } });
    expect(failed.status).toBe(500);
    expect(bucket.keys(`drops/${session.drop_id}/meta.json`)).toEqual([]);

    const retried = await commit(session.upload_id, { title: "T" });
    expect(retried.status, await retried.clone().text()).toBe(201);
    const drop = (await retried.json()) as Json;
    expect(drop.title).toBe("T");

    const again = await commit(session.upload_id, { title: "T" });
    expect(await again.json()).toEqual(drop);
  });

  it("updates a target drop as one generation flip, skipping blobs it already holds", async () => {
    const before = [await file("index.html", "<p>v1</p>"), await file("keep.txt", "keep")];
    const first = await openSession(before);
    await uploadAll(first, before);
    const v1 = (await (await commit(first.upload_id, { title: "V1" })).json()) as Json;

    const after = [await file("index.html", "<p>v2</p>"), before[1]!];
    const second = await openSession(after, { target: v1.slug as string });
    expect(second.slug).toBe(v1.slug);
    expect(second.drop_id).toBe(first.drop_id);
    expect(second.missing).toEqual([after[0]!.sha256]);
    await uploadAll(second, after);

    const response = await commit(second.upload_id, { meta: { rev: 2 } });
    expect(response.status, await response.clone().text()).toBe(200);
    const v2 = (await response.json()) as Json;
    expect(v2.title).toBe("V1");
    expect(v2.meta).toEqual({ rev: 2 });
    expect((v2.files as Json[]).map((f) => f.sha256)).toEqual(after.map((f) => f.sha256));

    const served = await app().fetch(new Request(`${ORIGIN}/${v1.slug as string}/`), env);
    expect(await served.text()).toBe("<p>v2</p>");
    // The v1 index blob is unreferenced now, and gone.
    expect(bucket.keys(`drops/${first.drop_id}/blobs/`).sort()).toEqual(
      after.map((f) => `drops/${first.drop_id}/blobs/${f.sha256}`).sort(),
    );
  });

  it("refuses to commit an update over a drop that moved since the session opened", async () => {
    const before = [await file("index.html", "<p>v1</p>")];
    const first = await openSession(before);
    await uploadAll(first, before);
    const v1 = (await (await commit(first.upload_id, {})).json()) as Json;

    const after = [await file("index.html", "<p>v2</p>")];
    const session = await openSession(after, { target: v1.slug as string });
    await uploadAll(session, after);

    // Someone else updates the title meanwhile.
    const moved = await json(`/_api/v1/drops/${v1.slug as string}`, "PATCH", { title: "Moved" });
    expect(moved.status).toBe(200);

    expect(await errorOf(await commit(session.upload_id, {}))).toMatchObject({
      status: 409,
      code: "UPDATE_CONFLICT",
    });
  });
});
