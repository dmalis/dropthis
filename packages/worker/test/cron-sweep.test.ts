import { describe, expect, it } from "vitest";
import { GRACE_MS, expiringMarkerDate } from "../src/domain/expiry.js";
import type { DropMeta } from "../src/domain/meta.js";
import { runCron, readCronState, PRUNE_STATE_KEY } from "../src/operations/cron.js";
import type { CronState } from "../src/operations/cron.js";
import { blobKey, expiringKey, listKeyForDrop, metaKey, slugKey } from "../src/storage/keys.js";
import { memoryBucket } from "./memory-bucket.js";
import type { MemoryBucket } from "./memory-bucket.js";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2031-03-01T00:00:00Z");
const rfc = (ms: number) => `${new Date(ms).toISOString().slice(0, 19)}Z`;

/** A drop already in the bucket, with every projection a real publish writes. */
function seedDrop(
  bucket: MemoryBucket,
  options: { id: string; slug: string; expiresAt: string | null; created?: number },
): DropMeta {
  const created = rfc(options.created ?? T0);
  const meta: DropMeta = {
    schema: 1,
    id: options.id,
    slug: options.slug,
    title: null,
    meta: {},
    access: {},
    current_gen: "gen",
    manifest: { "index.html": { sha256: `sha-${options.id}`, size: 3, content_type: "text/html" } },
    expires_at: options.expiresAt,
    noindex: true,
    created_by: { id: "admin", label: "admin" },
    created,
    updated: created,
  };
  bucket.seed(metaKey(meta.id), JSON.stringify(meta));
  bucket.seed(blobKey(meta.id, `sha-${meta.id}`), "abc");
  bucket.seed(slugKey(meta.slug), meta.id);
  bucket.seed(listKeyForDrop(meta.id, meta.slug), "", { id: meta.id, updated: meta.updated });
  if (meta.expires_at !== null) {
    bucket.seed(expiringKey(expiringMarkerDate(meta.expires_at), meta.id), "");
  }
  return meta;
}

const sweep = (bucket: MemoryBucket, nowMs: number, budget = 40) =>
  runCron({ bucket, now: new Date(nowMs), budget });

async function state(bucket: MemoryBucket): Promise<CronState> {
  return readCronState(bucket);
}

describe("the cron's very first run", () => {
  /**
   * With no stored state there is no day to start from, and starting at the
   * epoch would mean walking twenty thousand empty days before reaching any
   * work — one list() each, so the drop below would never be reached inside
   * any budget. Deleting it in a single run IS the proof that the run started
   * from the bucket's own oldest marker.
   */
  it("starts at the oldest expiring day in the bucket, not at the epoch", async () => {
    const bucket = memoryBucket();
    seedDrop(bucket, { id: "A", slug: "aaaaaaaaaa", expiresAt: rfc(T0 + 10 * DAY) });

    const report = await sweep(bucket, T0 + 17 * DAY + 1000);

    expect(report.deleted.drops).toBe(1);
    expect(report.ops).toBeLessThanOrEqual(40);
    expect((await state(bucket)).oldest_pending_date).toBe(
      new Date(T0 + 17 * DAY).toISOString().slice(0, 10),
    );
  });

  it("parks on today when there is nothing to sweep at all", async () => {
    const bucket = memoryBucket();
    const report = await sweep(bucket, T0 + 30 * DAY);

    expect(report.deleted.drops).toBe(0);
    expect((await state(bucket)).oldest_pending_date).toBe(
      new Date(T0 + 30 * DAY).toISOString().slice(0, 10),
    );
  });
});

describe("what the sweep deletes", () => {
  it("deletes a drop whose grace window has closed, and everything it owned", async () => {
    const bucket = memoryBucket();
    const meta = seedDrop(bucket, { id: "A", slug: "aaaaaaaaaa", expiresAt: rfc(T0 + DAY) });

    const report = await sweep(bucket, T0 + DAY + GRACE_MS + 1000);

    expect(report.deleted.drops).toBe(1);
    expect(bucket.read(metaKey("A"))).toBeNull();
    expect(bucket.read(blobKey("A", "sha-A"))).toBeNull();
    expect(bucket.read(slugKey("aaaaaaaaaa"))).toBeNull();
    expect(bucket.keys("list/")).toEqual([]);
    expect(bucket.keys("expiring/")).toEqual([]);
    expect(meta.expires_at).not.toBeNull();
  });

  it("leaves a drop that is still inside its grace window", async () => {
    const bucket = memoryBucket();
    seedDrop(bucket, { id: "A", slug: "aaaaaaaaaa", expiresAt: rfc(T0 + DAY) });

    const report = await sweep(bucket, T0 + DAY + GRACE_MS - 1000);

    expect(report.deleted.drops).toBe(0);
    expect(bucket.read(metaKey("A"))).not.toBeNull();
    expect(bucket.keys("expiring/")).toHaveLength(1);
  });

  it("leaves a live drop alone even when a stale marker points at it", async () => {
    const bucket = memoryBucket();
    seedDrop(bucket, { id: "A", slug: "aaaaaaaaaa", expiresAt: rfc(T0 + 400 * DAY) });
    // A marker from an expiry the drop no longer has — what a revive leaves behind.
    bucket.seed(expiringKey(new Date(T0 + DAY).toISOString().slice(0, 10), "A"), "");

    const report = await sweep(bucket, T0 + 5 * DAY);

    expect(report.deleted.drops).toBe(0);
    expect(bucket.read(metaKey("A"))).not.toBeNull();
    expect(report.deleted.markers).toBe(1);
    expect(bucket.keys("expiring/")).toHaveLength(1);
  });

  it("deletes a marker whose drop is already gone", async () => {
    const bucket = memoryBucket();
    bucket.seed(expiringKey(new Date(T0 + DAY).toISOString().slice(0, 10), "GONE"), "");

    const report = await sweep(bucket, T0 + 5 * DAY);

    expect(report.deleted.markers).toBe(1);
    expect(bucket.keys("expiring/")).toEqual([]);
  });
});

describe("the checkpoint", () => {
  it("writes system/prune-state.json exactly once per invocation", async () => {
    const bucket = memoryBucket();
    for (let i = 0; i < 5; i += 1) {
      seedDrop(bucket, { id: `D${i}`, slug: `dddddddd0${i}`, expiresAt: rfc(T0 + DAY) });
    }

    const report = await sweep(bucket, T0 + DAY + GRACE_MS + 1000);

    expect(report.state_writes).toBe(1);
    expect(bucket.log.filter((line) => line === `put ${PRUNE_STATE_KEY}`)).toHaveLength(1);
  });

  it("never checkpoints past a day that is not over in UTC", async () => {
    const bucket = memoryBucket();
    const noon = Date.parse("2031-03-20T12:00:00Z");
    seedDrop(bucket, { id: "A", slug: "aaaaaaaaaa", expiresAt: rfc(T0) });

    await sweep(bucket, noon);

    expect((await state(bucket)).oldest_pending_date).toBe("2031-03-20");
  });

  it("catches up three missed days in one run", async () => {
    const bucket = memoryBucket();
    for (let i = 0; i < 3; i += 1) {
      seedDrop(bucket, { id: `D${i}`, slug: `dddddddd0${i}`, expiresAt: rfc(T0 + i * DAY) });
    }

    // Grace ends on three consecutive days; the run happens two days after the last.
    const report = await sweep(bucket, T0 + 2 * DAY + GRACE_MS + 2 * DAY);

    expect(report.deleted.drops).toBe(3);
    expect(bucket.keys("drops/")).toEqual([]);
  });

  it("replays harmlessly when a crash lost the checkpoint", async () => {
    const bucket = memoryBucket();
    seedDrop(bucket, { id: "A", slug: "aaaaaaaaaa", expiresAt: rfc(T0 + DAY) });
    const now = T0 + DAY + GRACE_MS + 1000;

    const first = await sweep(bucket, now);
    // Throw the checkpoint away, exactly as a crash before step (n) would.
    await bucket.delete(PRUNE_STATE_KEY);
    const second = await sweep(bucket, now);

    expect(first.deleted.drops).toBe(1);
    expect(second.deleted.drops).toBe(0);
    expect(second.errors).toEqual([]);
  });
});

describe("the ops budget", () => {
  it("stops inside the budget and resumes where it stopped", async () => {
    const bucket = memoryBucket();
    for (let i = 0; i < 12; i += 1) {
      seedDrop(bucket, {
        id: `D${String(i).padStart(2, "0")}`,
        slug: `dddddddd${String(i).padStart(2, "0")}`,
        expiresAt: rfc(T0 + DAY),
      });
    }
    const now = T0 + DAY + GRACE_MS + 1000;

    const first = await sweep(bucket, now, 8);
    expect(first.incomplete).toBe(true);
    expect(first.ops).toBeLessThanOrEqual(8);
    expect(first.deleted.drops).toBeGreaterThan(0);
    expect(first.deleted.drops).toBeLessThan(12);

    let done = first.deleted.drops;
    let runs = 1;
    while (done < 12 && runs < 30) {
      const next = await sweep(bucket, now, 8);
      expect(next.ops, `run ${runs}`).toBeLessThanOrEqual(8);
      // Every run must make progress, or the cron is stuck rather than slow.
      expect(next.deleted.drops, `run ${runs}`).toBeGreaterThan(0);
      done += next.deleted.drops;
      runs += 1;
    }

    expect(done).toBe(12);
    expect(bucket.keys("drops/")).toEqual([]);
  });

  it("does not re-read a drop a previous run already finished", async () => {
    const bucket = memoryBucket();
    for (let i = 0; i < 12; i += 1) {
      seedDrop(bucket, {
        id: `D${String(i).padStart(2, "0")}`,
        slug: `dddddddd${String(i).padStart(2, "0")}`,
        expiresAt: rfc(T0 + 400 * DAY),
      });
      // Markers due today, but every drop is long-lived: each is a stale marker,
      // so nothing is deleted and the cursor is the only thing that can advance.
      bucket.seed(expiringKey(new Date(T0 + DAY).toISOString().slice(0, 10), `D${String(i).padStart(2, "0")}`), "");
    }
    const now = T0 + 5 * DAY;

    await sweep(bucket, now, 6);
    const after = await state(bucket);
    expect(after.day_cursor).not.toBeNull();

    // Whatever the first run cleared, the second must not look at again.
    const before = bucket.log.length;
    await sweep(bucket, now, 6);
    const reads = bucket.log.slice(before).filter((line) => line.startsWith("get drops/"));
    expect(reads.length).toBeLessThanOrEqual(6);
  });
});
