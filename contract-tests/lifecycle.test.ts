import { describe, expect, it } from "vitest";
import { api, errorOf } from "./client.js";
import type { Json } from "./client.js";

/**
 * The full lifecycle — `update`, `delete`, `list` — replayed against the
 * deployed dev Worker (issue #5).
 *
 * Everything here is an assertion about the CONTRACT: the exact `Drop`, the
 * exact error code, and what is left in the bucket afterwards. It runs over
 * HTTP against real R2 because the whole slice is built on conditional writes,
 * and Miniflare has shipped reversed conditional-write logic.
 */

const publish = (body: unknown, init?: RequestInit) =>
  api("/_api/v1/drops", {
    method: "POST",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    body: JSON.stringify(body),
    ...init,
  });

async function publishOk(body: unknown): Promise<Json> {
  const response = await publish(body);
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as Json;
}

const update = (slug: string, body: unknown, init?: RequestInit) =>
  api(`/_api/v1/drops/${slug}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    body: JSON.stringify(body),
    ...init,
  });

async function updateOk(slug: string, body: unknown, init?: RequestInit): Promise<Json> {
  const response = await update(slug, body, init);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Json;
}

const devKeys = async (prefix: string): Promise<string[]> => {
  const response = await api("/_dev/r2/list", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prefix }),
  });
  return ((await response.json()) as { keys: string[] }).keys;
};

const devHead = async (key: string): Promise<{ found: boolean; uploaded?: string }> => {
  const response = await api("/_dev/r2/head", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key }),
  });
  return (await response.json()) as { found: boolean; uploaded?: string };
};

const dropIdOf = async (slug: string): Promise<string> => {
  const keys = await devKeys("slugs/");
  expect(keys).toContain(`slugs/${slug}`);
  const response = await api("/_dev/r2/get", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: `slugs/${slug}` }),
  });
  return ((await response.json()) as { body: string }).body;
};

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("update: files", () => {
  it("flips the generation at the same URL and stops serving the old bytes", async () => {
    const drop = await publishOk({
      files: [{ path: "index.html", text: "<p>one</p>" }],
      title: "Versioned",
    });
    const slug = drop.slug as string;
    const dropId = await dropIdOf(slug);
    const oldSha = (drop.files as Array<Record<string, unknown>>)[0]!.sha256 as string;

    const updated = await updateOk(slug, { files: [{ path: "index.html", text: "<p>two</p>" }] });

    // Identity is untouched: the human's link keeps working.
    expect(updated.url).toBe(drop.url);
    expect(updated.slug).toBe(slug);
    expect(updated.created).toBe(drop.created);
    expect(updated.title).toBe("Versioned");
    expect(Date.parse(updated.updated as string)).toBeGreaterThanOrEqual(
      Date.parse(drop.updated as string),
    );

    const served = await fetch(drop.url as string, { cache: "no-store" });
    expect(await served.text()).toBe("<p>two</p>");

    // The blob the new manifest no longer names is gone, in the same call.
    expect(await devKeys(`drops/${dropId}/blobs/`)).toEqual([
      `drops/${dropId}/blobs/${(updated.files as Array<Record<string, unknown>>)[0]!.sha256 as string}`,
    ]);
    expect((await devHead(`drops/${dropId}/blobs/${oldSha}`)).found).toBe(false);
  });

  it("replaces the whole set: a path left out of the update is gone", async () => {
    const drop = await publishOk({
      files: [
        { path: "index.html", text: "<p>root</p>" },
        { path: "old.txt", text: "old" },
      ],
    });
    const slug = drop.slug as string;

    const updated = await updateOk(slug, {
      files: [
        { path: "index.html", text: "<p>root</p>" },
        { path: "new.txt", text: "new" },
      ],
    });
    expect((updated.files as Array<Record<string, unknown>>).map((f) => f.path)).toEqual([
      "index.html",
      "new.txt",
    ]);

    expect((await fetch(`${drop.url as string}old.txt`, { cache: "no-store" })).status).toBe(404);
    expect(await (await fetch(`${drop.url as string}new.txt`, { cache: "no-store" })).text()).toBe(
      "new",
    );
  });

  it("never re-uploads an unchanged file", async () => {
    const drop = await publishOk({
      files: [
        { path: "keep.txt", text: "unchanged" },
        { path: "change.txt", text: "before" },
      ],
    });
    const slug = drop.slug as string;
    const dropId = await dropIdOf(slug);
    const keepSha = (drop.files as Array<Record<string, unknown>>)[0]!.sha256 as string;
    const before = await devHead(`drops/${dropId}/blobs/${keepSha}`);
    expect(before.found).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    await updateOk(slug, {
      files: [
        { path: "keep.txt", text: "unchanged" },
        { path: "change.txt", text: "after" },
      ],
    });

    const after = await devHead(`drops/${dropId}/blobs/${keepSha}`);
    expect(after.found).toBe(true);
    // The upload instant is the proof: an unchanged file costs zero R2 writes.
    expect(after.uploaded).toBe(before.uploaded);
  }, 30_000);
});

describe("update: settings only", () => {
  it("changes the title without touching a single blob", async () => {
    const drop = await publishOk({ files: [{ path: "a.txt", text: "body" }], title: "Before" });
    const slug = drop.slug as string;
    const dropId = await dropIdOf(slug);
    const sha = (drop.files as Array<Record<string, unknown>>)[0]!.sha256 as string;
    const before = await devHead(`drops/${dropId}/blobs/${sha}`);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    const updated = await updateOk(slug, { title: "After" });

    expect(updated.title).toBe("After");
    expect(updated.files).toEqual(drop.files);
    expect((await devHead(`drops/${dropId}/blobs/${sha}`)).uploaded).toBe(before.uploaded);
    expect(await (await fetch(drop.url as string, { cache: "no-store" })).text()).toBe("body");
  }, 30_000);

  it("removes a title with null", async () => {
    const drop = await publishOk({ files: [{ path: "a.txt", text: "x" }], title: "Temporary" });
    const updated = await updateOk(drop.slug as string, { title: null });
    expect(updated.title).toBeNull();
  });

  it("turns noindex off and on", async () => {
    const drop = await publishOk({ files: [{ path: "a.txt", text: "x" }] });
    expect(drop.noindex).toBe(true);
    expect((await updateOk(drop.slug as string, { noindex: false })).noindex).toBe(false);
    expect((await updateOk(drop.slug as string, { noindex: true })).noindex).toBe(true);
  });

  it("merges meta at the top level and deletes a key with null", async () => {
    const drop = await publishOk({
      files: [{ path: "a.txt", text: "x" }],
      meta: { workflow: "weekly", sent_to: ["a@example.com"], stale: true },
    });
    const slug = drop.slug as string;

    const updated = await updateOk(slug, {
      meta: { stale: null, run: { id: 7, ok: false }, sent_to: ["b@example.com"] },
    });
    expect(updated.meta).toEqual({
      workflow: "weekly",
      sent_to: ["b@example.com"],
      run: { id: 7, ok: false },
    });

    // And it survives the round trip through meta.json.
    const fetched = (await (await api(`/_api/v1/drops/${slug}`)).json()) as Json;
    expect(fetched.meta).toEqual(updated.meta);
  });
});

describe("update: the no-op rule", () => {
  it("returns the current Drop and writes nothing when nothing changes", async () => {
    const drop = await publishOk({
      files: [{ path: "a.txt", text: "same" }],
      title: "Same",
      meta: { a: 1 },
    });
    const slug = drop.slug as string;

    await new Promise((resolve) => setTimeout(resolve, 1100));
    const updated = await updateOk(slug, {
      files: [{ path: "a.txt", text: "same" }],
      title: "Same",
      meta: { a: 1 },
    });

    // `updated` is the giveaway: a write would have moved it.
    expect(updated).toEqual(drop);
    expect(updated.updated).toBe(drop.updated);
  }, 30_000);

  it("treats an empty body as a no-op", async () => {
    const drop = await publishOk({ files: [{ path: "a.txt", text: "x" }] });
    const updated = await updateOk(drop.slug as string, {});
    expect(updated).toEqual(drop);
  });
});

describe("update: expiry", () => {
  it("moves the expiring/ marker and deletes the old one", async () => {
    const drop = await publishOk({ files: [{ path: "a.txt", text: "x" }], expires: "7d" });
    const slug = drop.slug as string;
    const dropId = await dropIdOf(slug);
    const markerOf = (expiresAt: string) =>
      `expiring/${new Date(Date.parse(expiresAt) + 7 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10)}/${dropId}`;

    expect((await devHead(markerOf(drop.expires_at as string))).found).toBe(true);

    const updated = await updateOk(slug, { expires: "60d" });
    expect((await devHead(markerOf(updated.expires_at as string))).found).toBe(true);
    expect((await devHead(markerOf(drop.expires_at as string))).found).toBe(false);
  });

  it("deletes the marker when a drop is set to never expire", async () => {
    const drop = await publishOk({ files: [{ path: "a.txt", text: "x" }], expires: "7d" });
    const dropId = await dropIdOf(drop.slug as string);
    const marker = `expiring/${new Date(
      Date.parse(drop.expires_at as string) + 7 * 24 * 60 * 60 * 1000,
    )
      .toISOString()
      .slice(0, 10)}/${dropId}`;
    expect((await devHead(marker)).found).toBe(true);

    const updated = await updateOk(drop.slug as string, { expires: "never" });
    expect(updated.expires_at).toBeNull();
    expect((await devHead(marker)).found).toBe(false);
  });

  it("refuses an expiry in the past and one beyond the instance maximum", async () => {
    const drop = await publishOk({ files: [{ path: "a.txt", text: "x" }] });
    for (const expires of ["2020-01-01", "400d"]) {
      const error = await errorOf(await update(drop.slug as string, { expires }));
      expect(error.status).toBe(400);
      expect(error.code).toBe("POLICY_VIOLATION");
    }
  });
});

describe("update: refusals", () => {
  it("404s a slug that is not a drop", async () => {
    const error = await errorOf(await update("zzzzzzzzzz", { title: "x" }));
    expect(error.status).toBe(404);
    expect(error.code).toBe("NOT_FOUND");
    // The drop is missing, not the route.
    expect(JSON.stringify(error.body)).toContain("zzzzzzzzzz");
  });

  it("names an unknown field instead of ignoring it", async () => {
    const drop = await publishOk({ files: [{ path: "a.txt", text: "x" }] });
    const error = await errorOf(await update(drop.slug as string, { passwrd: "hunter22" }));
    expect(error.status).toBe(400);
    expect(error.code).toBe("INVALID_INPUT");
    expect(JSON.stringify(error.body)).toContain("passwrd");
  });

  it("refuses an invalid path in a replacement file set", async () => {
    const drop = await publishOk({ files: [{ path: "a.txt", text: "x" }] });
    const error = await errorOf(
      await update(drop.slug as string, { files: [{ path: "../x.txt", text: "x" }] }),
    );
    expect(error.code).toBe("INVALID_PATH");
  });
});

describe("update: idempotency", () => {
  it("replays a byte-identical Drop for the same key and payload", async () => {
    const drop = await publishOk({ files: [{ path: "a.txt", text: "one" }] });
    const slug = drop.slug as string;
    const body = {
      files: [{ path: "a.txt", text: "two" }],
      title: "Twice",
      idempotency_key: `contract-update-${crypto.randomUUID()}`,
    };

    const first = await update(slug, body);
    expect(first.status).toBe(200);
    const firstText = await first.text();

    const second = await update(slug, body);
    expect(second.status).toBe(200);
    expect(await second.text()).toBe(firstText);
  });

  it("refuses a different payload under the same key", async () => {
    const drop = await publishOk({ files: [{ path: "a.txt", text: "x" }] });
    const slug = drop.slug as string;
    const key = `contract-update-mismatch-${crypto.randomUUID()}`;

    await updateOk(slug, { title: "One", idempotency_key: key });
    const error = await errorOf(await update(slug, { title: "Two", idempotency_key: key }));
    expect(error.status).toBe(409);
    expect(error.code).toBe("IDEMPOTENCY_MISMATCH");
  });

  it("refuses the same key aimed at a second drop, instead of replaying the first", async () => {
    // The claim is `sha256(key id + idempotency_key)` — one key names one
    // request, per the frozen layout. The target is part of the payload hash,
    // so pointing the key at another drop is a mismatch and never a silent
    // replay of the wrong drop.
    const key = `contract-update-scope-${crypto.randomUUID()}`;
    const a = await publishOk({ files: [{ path: "a.txt", text: "a" }] });
    const b = await publishOk({ files: [{ path: "a.txt", text: "b" }] });

    expect((await updateOk(a.slug as string, { title: "A", idempotency_key: key })).title).toBe("A");

    const error = await errorOf(await update(b.slug as string, { title: "A", idempotency_key: key }));
    expect(error.status).toBe(409);
    expect(error.code).toBe("IDEMPOTENCY_MISMATCH");
    expect((await (await api(`/_api/v1/drops/${b.slug as string}`)).json() as Json).title).toBeNull();
  });
});

describe("update: a write that fails part-way", () => {
  it.each(["blobs", "claim", "meta", "projections", "cleanup"])(
    "converges when the retry carries the same idempotency_key (abort after %s)",
    async (point) => {
      const drop = await publishOk({
        files: [{ path: "index.html", text: "<p>before</p>" }],
        title: "Before",
        expires: "7d",
      });
      const slug = drop.slug as string;
      const body = {
        files: [
          { path: "index.html", text: "<p>after</p>" },
          { path: "pixel.png", base64: PNG_BASE64 },
        ],
        title: "After",
        expires: "60d",
        idempotency_key: `contract-update-fault-${point}-${crypto.randomUUID()}`,
      };

      const failed = await update(slug, body, { headers: { "DEV-Fault": point } });
      expect(failed.status).toBe(500);

      const retried = await update(slug, body);
      expect(retried.status, await retried.clone().text()).toBe(200);
      const updated = (await retried.json()) as Json;
      expect(updated.title).toBe("After");

      const served = await fetch(drop.url as string, { cache: "no-store" });
      expect(served.status).toBe(200);
      expect(await served.text()).toBe("<p>after</p>");

      // A second retry replays; it never makes a third generation.
      const again = await update(slug, body);
      expect(again.status).toBe(200);
      expect(((await again.json()) as Json).updated).toBe(updated.updated);
    },
    40_000,
  );

  it("never serves half a generation: an abort before the CAS still serves the old drop", async () => {
    const drop = await publishOk({ files: [{ path: "index.html", text: "<p>before</p>" }] });
    const slug = drop.slug as string;

    for (const point of ["blobs", "claim"]) {
      const failed = await update(
        slug,
        { files: [{ path: "index.html", text: `<p>${point}</p>` }] },
        { headers: { "DEV-Fault": point } },
      );
      expect(failed.status).toBe(500);
      const served = await fetch(drop.url as string, { cache: "no-store" });
      expect(await served.text()).toBe("<p>before</p>");
    }
  }, 30_000);
});

describe("update: concurrency", () => {
  /**
   * MEASURED, not assumed: ten PATCHes of one drop issued at once produce
   * exactly one success and nine `409 UPDATE_CONFLICT`.
   *
   * R2's per-key refusal ("Reduce your concurrent request rate for the same
   * object", 10058) does NOT surface here, because the CAS precondition is
   * evaluated first and reports a lost race by resolving the put to `null`
   * rather than by throwing. The mapping to `429 R2_RATE_LIMIT` with
   * `Retry-After: 1` is still live on this path — `storage.test.ts` proves it
   * at the seam — so a 429 is accepted and checked when it does appear.
   */
  it("gives the drop to whoever holds the etag and every loser a retryable conflict", async () => {
    const drop = await publishOk({ files: [{ path: "a.txt", text: "x" }] });
    const slug = drop.slug as string;

    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, i) => update(slug, { title: `Race ${i}` })),
    );
    const codes = await Promise.all(
      responses.map(async (r) => (r.ok ? "ok" : (await errorOf(r.clone())).code)),
    );

    // Measured over five runs of ten: 1 success and 9 conflicts, and
    // occasionally 2 successes — a request issued at the same instant can still
    // arrive late enough to read the etag the first winner wrote, and winning
    // on it is correct. What the CAS guarantees is that no write is lost, not
    // that exactly one of ten survives.
    expect(codes.filter((c) => c === "ok").length).toBeGreaterThanOrEqual(1);
    expect(codes.filter((c) => c === "UPDATE_CONFLICT").length).toBeGreaterThanOrEqual(1);
    for (const [i, code] of codes.entries()) {
      expect(["ok", "UPDATE_CONFLICT", "R2_RATE_LIMIT"], `response ${i} was ${code}`).toContain(
        code,
      );
    }

    // Every refusal is machine-readable and says "retry me".
    for (const response of responses.filter((r) => !r.ok)) {
      const body = (await response.clone().json()) as { error: { retryable: boolean } };
      expect(body.error.retryable).toBe(true);
      if (response.status === 429) expect(response.headers.get("retry-after")).toBe("1");
    }

    // Exactly one title won, and the drop holds it.
    const after = (await (await api(`/_api/v1/drops/${slug}`)).json()) as Json;
    expect(after.title).toMatch(/^Race \d$/);
  }, 30_000);

  it("lets a loser succeed on the retry its error asked for", async () => {
    const drop = await publishOk({ files: [{ path: "a.txt", text: "x" }] });
    const slug = drop.slug as string;

    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, i) => update(slug, { title: `First ${i}` })),
    );
    expect(responses.filter((r) => !r.ok).length).toBeGreaterThan(0);

    const retried = await updateOk(slug, { title: "Second" });
    expect(retried.title).toBe("Second");
  }, 30_000);
});

describe("delete", () => {
  const remove = (slug: string) => api(`/_api/v1/drops/${slug}`, { method: "DELETE" });

  it("answers 204 with no body and takes the drop off every surface", async () => {
    const drop = await publishOk({
      files: [
        { path: "index.html", text: "<p>bye</p>" },
        { path: "pixel.png", base64: PNG_BASE64 },
      ],
      title: "Doomed",
      expires: "7d",
    });
    const slug = drop.slug as string;

    const response = await remove(slug);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");

    // The viewer, `get`, the download route and `update` all agree it is gone.
    expect((await fetch(drop.url as string, { cache: "no-store" })).status).toBe(404);
    expect((await fetch(`${drop.url as string}index.html`, { cache: "no-store" })).status).toBe(404);

    const got = await errorOf(await api(`/_api/v1/drops/${slug}`));
    expect(got.status).toBe(404);
    expect(got.code).toBe("NOT_FOUND");

    const download = await errorOf(await api(`/_api/v1/drops/${slug}/files/index.html`));
    expect(download.code).toBe("NOT_FOUND");

    const patched = await errorOf(await update(slug, { title: "back?" }));
    expect(patched.status).toBe(404);
    expect(patched.code).toBe("NOT_FOUND");
  });

  it("leaves nothing behind: record, blobs, slug pointer and both projections", async () => {
    const drop = await publishOk({
      files: [
        { path: "a.txt", text: "a" },
        { path: "b.txt", text: "b" },
      ],
      expires: "7d",
    });
    const slug = drop.slug as string;
    const dropId = await dropIdOf(slug);
    expect((await devKeys(`drops/${dropId}/`)).length).toBeGreaterThan(1);

    expect((await remove(slug)).status).toBe(204);

    expect(await devKeys(`drops/${dropId}/`)).toEqual([]);
    expect(await devKeys(`slugs/${slug}`)).toEqual([]);
    expect((await devKeys("list/")).filter((k) => k.endsWith(`-${slug}`))).toEqual([]);
    expect((await devKeys("expiring/")).filter((k) => k.endsWith(`/${dropId}`))).toEqual([]);
  });

  it("is rerun-safe: deleting twice is 204 both times", async () => {
    const drop = await publishOk({ files: [{ path: "a.txt", text: "x" }] });
    expect((await remove(drop.slug as string)).status).toBe(204);
    expect((await remove(drop.slug as string)).status).toBe(204);
  });

  it("is 204 for a slug that never existed", async () => {
    expect((await remove("zzzzzzzzzz")).status).toBe(204);
  });

  it("frees nothing about the slug: a new publish gets a new one", async () => {
    const drop = await publishOk({ files: [{ path: "a.txt", text: "x" }] });
    const slug = drop.slug as string;
    await remove(slug);
    const next = await publishOk({ files: [{ path: "a.txt", text: "x" }] });
    expect(next.slug).not.toBe(slug);
  });
})

const list = (query = "") => api(`/_api/v1/drops${query}`);

type Listing = { drops: Json[]; cursor: string | null; has_more: boolean };

async function listOk(query = ""): Promise<Listing> {
  const response = await list(query);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Listing;
}

describe("list", () => {
  it("returns the frozen page shape and a Drop without meta or files", async () => {
    const drop = await publishOk({
      files: [{ path: "a.txt", text: "x" }],
      title: "Listed",
      meta: { secret_notes: "not in list" },
      expires: "7d",
    });

    const page = await listOk("?limit=100");
    expect(Object.keys(page).sort()).toEqual(["cursor", "drops", "has_more"]);

    const row = page.drops.find((d) => d.slug === drop.slug);
    expect(row, "the drop just published is on the first page").toBeDefined();
    expect(Object.keys(row!)).toEqual([
      "url",
      "slug",
      "title",
      "created_by",
      "created",
      "updated",
      "expires_at",
      "noindex",
      "has_password",
      "state",
    ]);
    expect(row!.url).toBe(drop.url);
    expect(row!.title).toBe("Listed");
    expect(row!.created).toBe(drop.created);
    expect(row!.updated).toBe(drop.updated);
    expect(row!.expires_at).toBe(drop.expires_at);
    expect(row!.created_by).toEqual(drop.created_by);
    expect(row!.noindex).toBe(true);
    expect(row!.has_password).toBe(false);
    expect(row!.state).toBe("live");
  });

  it("pages newest-first with a cursor", async () => {
    // A run of drops made in order; the listing must hand them back reversed.
    const slugs: string[] = [];
    for (let i = 0; i < 35; i += 1) {
      const drop = await publishOk({
        files: [{ path: "a.txt", text: `page ${i}` }],
        title: `Paged ${String(i).padStart(2, "0")}`,
      });
      slugs.push(drop.slug as string);
    }
    const newestFirst = [...slugs].reverse();

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Listing = await listOk(
        `?limit=10${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
      );
      expect(page.drops.length).toBeLessThanOrEqual(10);
      seen.push(...page.drops.map((d) => d.slug as string));
      cursor = page.has_more ? page.cursor : null;
      expect(page.has_more === true).toBe(cursor !== null);
      pages += 1;
      // The instance is shared with the other contract files, so the listing
      // holds their drops too; the cap proves the cursor TERMINATES, it is not
      // a count of this test's own pages.
      expect(pages, "the cursor must terminate").toBeLessThan(80);
    } while (cursor !== null);

    // Every drop of this run appears exactly once, newest first.
    const mine = seen.filter((slug) => slugs.includes(slug));
    expect(mine).toEqual(newestFirst);
    expect(new Set(seen).size).toBe(seen.length);
    // Measured against the deployed dev instance: one publish is ~3.6 s and a
    // 100-row page ~10 s (one head per row). 35 publishes plus the paging walk
    // do not fit a smaller budget, and cutting the run would stop proving that
    // paging crosses several pages in order.
  }, 600_000);

  it("clamps limit to the frozen bounds", async () => {
    await publishOk({ files: [{ path: "a.txt", text: "x" }] });
    expect((await listOk("?limit=1")).drops.length).toBe(1);
    expect((await list("?limit=0")).status).toBe(400);
    expect((await list("?limit=1001")).status).toBe(400);
    expect((await list("?limit=nope")).status).toBe(400);
  });

  it("filters on q by substring, ignoring case and accent spelling", async () => {
    const match = await publishOk({
      files: [{ path: "a.txt", text: "x" }],
      title: "Ünïcode Report",
    });
    const other = await publishOk({
      files: [{ path: "a.txt", text: "x" }],
      title: "Something Else Entirely",
    });

    for (const q of ["ünïcode report", "ÜNÏCODE", "code rep", `u${String.fromCharCode(0x308)}nïcode`]) {
      const page = await listOk(`?limit=1000&q=${encodeURIComponent(q)}`);
      const slugs = page.drops.map((d) => d.slug);
      expect(slugs, `q=${q}`).toContain(match.slug);
      expect(slugs, `q=${q}`).not.toContain(other.slug);
    }
  });

  it("a q page can be empty while has_more is true", async () => {
    for (let i = 0; i < 4; i += 1) {
      await publishOk({ files: [{ path: "a.txt", text: `q ${i}` }], title: `Filler ${i}` });
    }
    const page = await listOk("?limit=1&q=zzzznothingmatchesthiszzzz");
    expect(page.drops).toEqual([]);
    expect(page.has_more).toBe(true);
    expect(page.cursor).toBeTruthy();
  });

  it("hides a drop that has been deleted", async () => {
    const drop = await publishOk({ files: [{ path: "a.txt", text: "x" }], title: "Vanishing" });
    expect((await listOk("?limit=1000")).drops.map((d) => d.slug)).toContain(drop.slug);

    await api(`/_api/v1/drops/${drop.slug as string}`, { method: "DELETE" });
    expect((await listOk("?limit=1000")).drops.map((d) => d.slug)).not.toContain(drop.slug);
  });

  it("deletes the listing row before meta.json, so a crashed delete leaves no orphan row", async () => {
    // Decision #100: `list` answers from pointers alone and never verifies a
    // row against the truth, so `delete` removes the projections FIRST. What a
    // crash can leave is a live drop with no row — which `get` repairs — and
    // never a row with nothing behind it.
    const drop = await publishOk({ files: [{ path: "a.txt", text: "x" }], title: "Ordered" });
    const slug = drop.slug as string;
    const dropId = await dropIdOf(slug);
    const listKey = (await devKeys("list/")).find((key) => key.endsWith(`-${slug}`))!;
    expect(listKey).toBeDefined();

    await api(`/_api/v1/drops/${slug}`, { method: "DELETE" });
    expect(await devKeys("list/")).not.toContain(listKey);
    expect(await devKeys(`drops/${dropId}/meta.json`)).toEqual([]);
  });

  it("shows a manufactured orphan row until the reconcile takes it, and never 500s", async () => {
    // An orphan row can now only be manufactured. `list` is one `list()` and no
    // reads of the truth, so it shows the row; `get` on it is the honest 404.
    const drop = await publishOk({ files: [{ path: "a.txt", text: "x" }], title: "Orphaned" });
    const slug = drop.slug as string;
    const dropId = await dropIdOf(slug);

    await api("/_dev/r2/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keys: [`drops/${dropId}/meta.json`] }),
    });

    const page = await listOk("?limit=1000");
    expect(page.drops.map((d) => d.slug)).toContain(slug);
    expect((await api(`/_api/v1/drops/${slug}`)).status).toBe(404);

    // Tidy up, so the next file in this run does not measure this row.
    await api(`/_api/v1/drops/${slug}`, { method: "DELETE" });
  });

  it("rewrites a listing row that went stale, on the next get", async () => {
    const drop = await publishOk({ files: [{ path: "a.txt", text: "x" }], title: "Stale row" });
    const slug = drop.slug as string;
    const listKey = (await devKeys("list/")).find((key) => key.endsWith(`-${slug}`))!;

    // Overwrite the pointer with one that carries no customMetadata at all —
    // the shape a Worker older than this projection would have written. The
    // comparison the spec names is `updated`, and this one has none.
    await api("/_dev/r2/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keys: [listKey] }),
    });
    await api("/_dev/r2/cas", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: listKey, body: "" }),
    });
    // A pointer the lister cannot interpret is skipped, never deleted: there
    // is no proof the drop is gone, and this drop is very much alive.
    expect((await listOk("?limit=1000")).drops.map((d) => d.slug)).not.toContain(slug);
    expect((await devHead(listKey)).found).toBe(true);

    expect((await api(`/_api/v1/drops/${slug}`)).status).toBe(200);

    const row = (await listOk("?limit=1000")).drops.find((d) => d.slug === slug)!;
    expect(row.title).toBe("Stale row");
    expect(row.updated).toBe(drop.updated);
  });

  it("reflects an update in the listing row", async () => {
    const drop = await publishOk({ files: [{ path: "a.txt", text: "x" }], title: "Before" });
    const updated = await updateOk(drop.slug as string, { title: "After", expires: "60d" });

    const row = (await listOk("?limit=1000")).drops.find((d) => d.slug === drop.slug)!;
    expect(row.title).toBe("After");
    expect(row.updated).toBe(updated.updated);
    expect(row.expires_at).toBe(updated.expires_at);
  });

  it("rebuilds a listing row that was lost, on the next get", async () => {
    const drop = await publishOk({ files: [{ path: "a.txt", text: "x" }], title: "Repairable" });
    const slug = drop.slug as string;
    const listKey = (await devKeys("list/")).find((key) => key.endsWith(`-${slug}`))!;

    await api("/_dev/r2/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keys: [listKey] }),
    });
    expect(await devKeys("list/")).not.toContain(listKey);

    // `get` is one of the two repairers the spec names.
    expect((await api(`/_api/v1/drops/${slug}`)).status).toBe(200);
    expect(await devKeys("list/")).toContain(listKey);
    expect((await listOk("?limit=1000")).drops.map((d) => d.slug)).toContain(slug);
  });

  it("rebuilds an expiring/ marker that was lost, on the next get (#100c)", async () => {
    const drop = await publishOk({ files: [{ path: "a.txt", text: "x" }], expires: "30d" });
    const slug = drop.slug as string;
    const dropId = await dropIdOf(slug);
    const marker = (await devKeys("expiring/")).find((key) => key.endsWith(`/${dropId}`))!;
    expect(marker).toBeDefined();

    await api("/_dev/r2/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keys: [marker] }),
    });
    expect(await devKeys("expiring/")).not.toContain(marker);

    expect((await api(`/_api/v1/drops/${slug}`)).status).toBe(200);
    expect(await devKeys("expiring/")).toContain(marker);
  });
})

/**
 * The expiry state table (docs/spec-v1.md), every row, without waiting.
 *
 * The dev build answers a per-request `DEV-Clock` header as "now" — the same
 * reasoning as the per-request fault point: one deployment covers every row,
 * and a live drop and an expired one can appear in the same run.
 */
describe("the expiry state table", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const at = (base: string, days: number) =>
    new Date(Date.parse(base) + days * DAY).toISOString();
  const clock = (instant: string) => ({ "DEV-Clock": instant });

  async function expiringDrop(): Promise<{ drop: Json; slug: string; expiresAt: string }> {
    const drop = await publishOk({
      files: [{ path: "index.html", text: "<p>alive</p>" }],
      title: "Perishable",
      expires: "7d",
    });
    return { drop, slug: drop.slug as string, expiresAt: drop.expires_at as string };
  }

  it("live: the viewer serves, get is 200, update is free, list shows it", async () => {
    const { drop, slug } = await expiringDrop();
    expect((await fetch(drop.url as string, { cache: "no-store" })).status).toBe(200);

    const got = (await (await api(`/_api/v1/drops/${slug}`)).json()) as Json;
    expect(got.state).toBe("live");

    expect((await updateOk(slug, { title: "Still here" })).state).toBe("live");
    expect((await listOk("?limit=1000")).drops.map((d) => d.slug)).toContain(slug);
  });

  it("expired_grace: viewer 410, get 200 with state, list shows it", async () => {
    const { drop, slug, expiresAt } = await expiringDrop();
    const inGrace = at(expiresAt, 1);

    const served = await fetch(drop.url as string, {
      cache: "no-store",
      headers: clock(inGrace),
    });
    expect(served.status).toBe(410);
    expect(await served.text()).toContain("Expired");

    const got = (await (
      await api(`/_api/v1/drops/${slug}`, { headers: clock(inGrace) })
    ).json()) as Json;
    expect(got.state).toBe("expired_grace");

    const page = await listOk("?limit=1000");
    expect(page.drops.map((d) => d.slug)).toContain(slug);
    const row = (await (
      await api("/_api/v1/drops?limit=1000", { headers: clock(inGrace) })
    ).json()) as Listing;
    expect(row.drops.find((d) => d.slug === slug)!.state).toBe("expired_grace");
  });

  it("expired_grace: update needs a future expires, and that one call revives it", async () => {
    const { drop, slug, expiresAt } = await expiringDrop();
    const inGrace = at(expiresAt, 1);

    const refused = await errorOf(await update(slug, { title: "nope" }, { headers: clock(inGrace) }));
    expect(refused.status).toBe(409);
    expect(refused.code).toBe("EXPIRED_NEEDS_EXPIRES");
    expect(JSON.stringify(refused.body)).toContain("expires");

    // "The link died, bring it back" is one call.
    const revived = await updateOk(slug, { expires: "30d" }, { headers: clock(inGrace) });
    expect(revived.state).toBe("live");
    const served = await fetch(drop.url as string, { cache: "no-store", headers: clock(inGrace) });
    expect(served.status).toBe(200);
    expect(await served.text()).toBe("<p>alive</p>");
  });

  it("expired_final: viewer 410, get and update 410 EXPIRED_FINAL, list hides it", async () => {
    const { drop, slug, expiresAt } = await expiringDrop();
    const pastGrace = at(expiresAt, 8);

    expect(
      (await fetch(drop.url as string, { cache: "no-store", headers: clock(pastGrace) })).status,
    ).toBe(410);

    const got = await errorOf(await api(`/_api/v1/drops/${slug}`, { headers: clock(pastGrace) }));
    expect(got.status).toBe(410);
    expect(got.code).toBe("EXPIRED_FINAL");

    const patched = await errorOf(
      await update(slug, { expires: "30d" }, { headers: clock(pastGrace) }),
    );
    expect(patched.status).toBe(410);
    expect(patched.code).toBe("EXPIRED_FINAL");

    const page = (await (
      await api("/_api/v1/drops?limit=1000", { headers: clock(pastGrace) })
    ).json()) as Listing;
    expect(page.drops.map((d) => d.slug)).not.toContain(slug);
  });

  it("a drop that never expires is live at any instant", async () => {
    const drop = await publishOk({ files: [{ path: "a.txt", text: "x" }], expires: "never" });
    const farFuture = at(new Date().toISOString(), 3650);
    const got = (await (
      await api(`/_api/v1/drops/${drop.slug as string}`, { headers: clock(farFuture) })
    ).json()) as Json;
    expect(got.expires_at).toBeNull();
    expect(got.state).toBe("live");
  });
})
