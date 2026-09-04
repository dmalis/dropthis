import { describe, expect, it } from "vitest";
import { expiringMarkerDate } from "../src/domain/expiry.js";
import type { DropMeta } from "../src/domain/meta.js";
import {
  RECONCILE_EVERY_DAYS,
  UNREFERENCED_BLOB_AGE_MS,
  readCronState,
  runCron,
} from "../src/operations/cron.js";
import { PRUNE_STATE_KEY, blobKey, expiringKey, listKeyForDrop, metaKey, slugKey } from "../src/storage/keys.js";
import { memoryBucket } from "./memory-bucket.js";
import type { MemoryBucket } from "./memory-bucket.js";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2031-03-01T00:00:00Z");
const NOW = new Date(T0 + 30 * DAY);
const rfc = (ms: number) => `${new Date(ms).toISOString().slice(0, 19)}Z`;
const long_ago = new Date(NOW.getTime() - UNREFERENCED_BLOB_AGE_MS - 1000);

function seedMeta(bucket: MemoryBucket, id: string, slug: string, shas: string[]): DropMeta {
  const created = rfc(T0);
  const meta: DropMeta = {
    schema: 1,
    id,
    slug,
    title: null,
    meta: {},
    access: {},
    current_gen: "gen",
    manifest: Object.fromEntries(
      shas.map((sha, i) => [`f${i}.txt`, { sha256: sha, size: 3, content_type: "text/plain" }]),
    ),
    expires_at: rfc(T0 + 400 * DAY),
    noindex: true,
    created_by: { id: "admin", label: "admin" },
    created,
    updated: created,
  };
  bucket.seed(metaKey(id), JSON.stringify(meta));
  bucket.seed(slugKey(slug), id);
  return meta;
}

/** The state a bucket is in when a reconcile is due today. */
function reconcileDueState(bucket: MemoryBucket): void {
  bucket.seed(
    PRUNE_STATE_KEY,
    JSON.stringify({
      oldest_pending_date: NOW.toISOString().slice(0, 10),
      day_cursor: null,
      reconcile_cursor: null,
      last_reconcile_date: new Date(NOW.getTime() - RECONCILE_EVERY_DAYS * DAY)
        .toISOString()
        .slice(0, 10),
      updated: rfc(T0),
    }),
  );
}

const reconcileNow = (bucket: MemoryBucket, budget = 60) =>
  runCron({ bucket, now: NOW, budget, force: "reconcile" });

describe("when the reconcile runs", () => {
  it("does not run on a brand-new instance's first invocation", async () => {
    const bucket = memoryBucket();
    const report = await runCron({ bucket, now: NOW, budget: 40 });
    expect(report.ran).toBe("sweep");
  });

  it("runs once a week has passed since the last one finished", async () => {
    const bucket = memoryBucket();
    reconcileDueState(bucket);
    expect((await runCron({ bucket, now: NOW, budget: 40 })).ran).toBe("reconcile");
  });

  it("does not run again the day after it finished", async () => {
    const bucket = memoryBucket();
    reconcileDueState(bucket);
    await runCron({ bucket, now: NOW, budget: 40 });
    const next = await runCron({ bucket, now: new Date(NOW.getTime() + DAY), budget: 40 });
    expect(next.ran).toBe("sweep");
  });

  it("finishes a reconcile it had to interrupt before it sweeps again", async () => {
    const bucket = memoryBucket();
    bucket.seed(
      PRUNE_STATE_KEY,
      JSON.stringify({
        oldest_pending_date: NOW.toISOString().slice(0, 10),
        day_cursor: null,
        reconcile_cursor: "list:",
        last_reconcile_date: NOW.toISOString().slice(0, 10),
        updated: rfc(T0),
      }),
    );
    expect((await runCron({ bucket, now: NOW, budget: 40 })).ran).toBe("reconcile");
  });
});

describe("unreferenced blobs", () => {
  it("removes a blob the current manifest no longer names", async () => {
    const bucket = memoryBucket();
    seedMeta(bucket, "A", "aaaaaaaaaa", ["keep"]);
    bucket.seed(blobKey("A", "keep"), "abc", undefined, long_ago);
    bucket.seed(blobKey("A", "orphan"), "abc", undefined, long_ago);
    reconcileDueState(bucket);

    const report = await reconcileNow(bucket);

    expect(report.deleted.blobs).toBe(1);
    expect(bucket.read(blobKey("A", "keep"))).not.toBeNull();
    expect(bucket.read(blobKey("A", "orphan"))).toBeNull();
  });

  /**
   * A publish writes its blobs BEFORE the `meta.json` that names them, so a
   * blob written seconds ago may belong to a call that is still running.
   */
  it("leaves an unreferenced blob that is younger than a day", async () => {
    const bucket = memoryBucket();
    seedMeta(bucket, "A", "aaaaaaaaaa", ["keep"]);
    bucket.seed(blobKey("A", "keep"), "abc", undefined, long_ago);
    bucket.seed(blobKey("A", "fresh"), "abc", undefined, new Date(NOW.getTime() - 60_000));
    reconcileDueState(bucket);

    const report = await reconcileNow(bucket);

    expect(report.deleted.blobs).toBe(0);
    expect(bucket.read(blobKey("A", "fresh"))).not.toBeNull();
  });

  it("removes every blob of a drop whose meta.json is gone", async () => {
    const bucket = memoryBucket();
    bucket.seed(blobKey("GONE", "one"), "abc", undefined, long_ago);
    bucket.seed(blobKey("GONE", "two"), "abc", undefined, long_ago);
    reconcileDueState(bucket);

    const report = await reconcileNow(bucket);

    expect(report.deleted.blobs).toBe(2);
    expect(bucket.keys("drops/")).toEqual([]);
  });
});

describe("pointers with nothing behind them", () => {
  it("removes a slug pointer whose meta.json never appeared", async () => {
    const bucket = memoryBucket();
    bucket.seed(slugKey("zzzzzzzzzz"), "NEVER");
    reconcileDueState(bucket);

    await reconcileNow(bucket);

    expect(bucket.read(slugKey("zzzzzzzzzz"))).toBeNull();
  });

  it("keeps a slug pointer a staged upload still owns", async () => {
    const bucket = memoryBucket();
    bucket.seed(slugKey("zzzzzzzzzz"), "PENDING", {
      pending_upload: "1",
      expires: rfc(NOW.getTime() + DAY),
    });
    reconcileDueState(bucket);

    await reconcileNow(bucket);

    expect(bucket.read(slugKey("zzzzzzzzzz"))).not.toBeNull();
  });

  /**
   * Issue #24, finding 12: "the reconcile removes a meta-less pointer only when
   * no LIVE session owns it." A session lasts a day; a pointer whose session
   * has expired — or that carries no readable expiry at all — is owned by
   * nobody and holds a slug hostage forever.
   */
  it("removes a pending pointer whose session has expired", async () => {
    const bucket = memoryBucket();
    bucket.seed(slugKey("zzzzzzzzzz"), "PENDING", {
      pending_upload: "1",
      expires: rfc(NOW.getTime() - 1000),
    });
    reconcileDueState(bucket);

    await reconcileNow(bucket);

    expect(bucket.read(slugKey("zzzzzzzzzz"))).toBeNull();
  });

  it("removes a pending pointer with no readable expiry", async () => {
    const bucket = memoryBucket();
    bucket.seed(slugKey("yyyyyyyyyy"), "PENDING", { pending_upload: "1" });
    bucket.seed(slugKey("xxxxxxxxxx"), "PENDING", { pending_upload: "1", expires: "soon" });
    reconcileDueState(bucket);

    await reconcileNow(bucket);

    expect(bucket.read(slugKey("yyyyyyyyyy"))).toBeNull();
    expect(bucket.read(slugKey("xxxxxxxxxx"))).toBeNull();
  });

  it("removes a listing entry and an expiring marker whose drop is gone", async () => {
    const bucket = memoryBucket();
    bucket.seed(listKeyForDrop("GONE", "zzzzzzzzzz"), "", { id: "GONE", updated: rfc(T0) });
    bucket.seed(expiringKey("2031-04-01", "GONE"), "");
    reconcileDueState(bucket);

    const report = await reconcileNow(bucket);

    expect(bucket.keys("list/")).toEqual([]);
    expect(bucket.keys("expiring/")).toEqual([]);
    expect(report.deleted.pointers).toBe(2);
  });
});

describe("projections that went missing", () => {
  it("rewrites a listing entry a failed publish never wrote", async () => {
    const bucket = memoryBucket();
    const meta = seedMeta(bucket, "A", "aaaaaaaaaa", []);
    bucket.seed(expiringKey(expiringMarkerDate(meta.expires_at!), "A"), "");
    reconcileDueState(bucket);

    const report = await reconcileNow(bucket);

    expect(report.repaired.list).toBe(1);
    expect(bucket.keys("list/")).toEqual([listKeyForDrop(meta.id, "aaaaaaaaaa")]);
  });

  it("rewrites a listing entry that is out of date", async () => {
    const bucket = memoryBucket();
    const meta = seedMeta(bucket, "A", "aaaaaaaaaa", []);
    bucket.seed(listKeyForDrop(meta.id, "aaaaaaaaaa"), "", {
      id: "A",
      updated: "2020-01-01T00:00:00Z",
    });
    bucket.seed(expiringKey(expiringMarkerDate(meta.expires_at!), "A"), "");
    reconcileDueState(bucket);

    expect((await reconcileNow(bucket)).repaired.list).toBe(1);
  });

  it("rewrites a missing expiring marker", async () => {
    const bucket = memoryBucket();
    const meta = seedMeta(bucket, "A", "aaaaaaaaaa", []);
    bucket.seed(listKeyForDrop(meta.id, "aaaaaaaaaa"), "", {
      id: "A",
      updated: meta.updated,
    });
    reconcileDueState(bucket);

    const report = await reconcileNow(bucket);

    expect(report.repaired.expiring).toBe(1);
    expect(bucket.keys("expiring/")).toEqual([
      expiringKey(expiringMarkerDate(meta.expires_at!), "A"),
    ]);
  });

  it("repairs nothing when everything is already in place", async () => {
    const bucket = memoryBucket();
    const meta = seedMeta(bucket, "A", "aaaaaaaaaa", []);
    bucket.seed(listKeyForDrop(meta.id, "aaaaaaaaaa"), "", {
      id: "A",
      updated: meta.updated,
    });
    bucket.seed(expiringKey(expiringMarkerDate(meta.expires_at!), "A"), "");
    reconcileDueState(bucket);

    const report = await reconcileNow(bucket);

    expect(report.repaired).toEqual({ list: 0, expiring: 0 });
    expect(report.deleted.objects).toBe(0);
  });
});

describe("the reconcile's own budget", () => {
  it("stops inside it, remembers the phase, and finishes over several runs", async () => {
    const bucket = memoryBucket();
    for (let i = 0; i < 10; i += 1) {
      bucket.seed(slugKey(`zzzzzzzz${String(i).padStart(2, "0")}`), `GONE${i}`);
    }
    reconcileDueState(bucket);

    const first = await runCron({ bucket, now: NOW, budget: 8, force: "reconcile" });
    expect(first.incomplete).toBe(true);
    expect(first.ops).toBeLessThanOrEqual(8);
    expect((await readCronState(bucket)).reconcile_cursor).toMatch(/^slugs:/);

    for (let run = 0; run < 20 && bucket.keys("slugs/").length > 0; run += 1) {
      await runCron({ bucket, now: NOW, budget: 8, force: "reconcile" });
    }

    expect(bucket.keys("slugs/")).toEqual([]);
    expect((await readCronState(bucket)).reconcile_cursor).toBeNull();
    expect((await readCronState(bucket)).last_reconcile_date).toBe(NOW.toISOString().slice(0, 10));
  });

  it("writes its checkpoint exactly once, however much it did", async () => {
    const bucket = memoryBucket();
    for (let i = 0; i < 10; i += 1) {
      bucket.seed(slugKey(`zzzzzzzz${String(i).padStart(2, "0")}`), `GONE${i}`);
    }
    reconcileDueState(bucket);

    const report = await reconcileNow(bucket);

    expect(report.state_writes).toBe(1);
    expect(bucket.log.filter((line) => line === `put ${PRUNE_STATE_KEY}`)).toHaveLength(1);
  });
});
