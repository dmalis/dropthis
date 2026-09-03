import { beforeEach, describe, expect, it } from "vitest";
import { GRACE_MS, expiringMarkerDate } from "../src/domain/expiry.js";
import { prune, usage } from "../src/operations/usage.js";
import { expiringKey, listKeyForDrop, slugKey } from "../src/storage/keys.js";
import { memoryBucket } from "./memory-bucket.js";
import type { MemoryBucket } from "./memory-bucket.js";

/**
 * `usage` and `prune` (AGENTS.md, "Pruning").
 *
 * One scan answers both. The states are the four of the expiry table plus
 * `staging` (a half-finished upload) and `orphan` (blobs whose `meta.json` is
 * gone, so nothing can name them). `prune` deletes only `expired_final`: past
 * the grace window, where `get` and `update` already refuse.
 */
const NOW = new Date("2026-09-03T12:00:00Z");
const CREATED = "2026-08-01T00:00:00Z";

let bucket: MemoryBucket;

function seedDrop(
  id: string,
  slug: string,
  expiresAt: string | null,
  blobs: Array<[string, number]> = [["aa", 100]],
): void {
  const manifest: Record<string, unknown> = {};
  for (const [digest, size] of blobs) {
    manifest[`${digest}.txt`] = { sha256: digest, size, content_type: "text/plain" };
    bucket.seed(`drops/${id}/blobs/${digest}`, "x".repeat(size));
  }
  const meta = {
    schema: 1,
    id,
    slug,
    title: null,
    meta: {},
    access: {},
    current_gen: "gen",
    manifest,
    expires_at: expiresAt,
    noindex: true,
    created_by: { id: "admin", label: "admin" },
    created: CREATED,
    updated: CREATED,
  };
  bucket.seed(`drops/${id}/meta.json`, JSON.stringify(meta));
  bucket.seed(slugKey(slug), id);
  bucket.seed(listKeyForDrop(id, slug), "");
  if (expiresAt !== null) bucket.seed(expiringKey(expiringMarkerDate(expiresAt), id), "");
}

const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString().slice(0, 19) + "Z";

beforeEach(() => {
  bucket = memoryBucket();
});

const scan = (budget = 100) => usage({ bucket, now: NOW, budget });

describe("usage", () => {
  it("reports zeroes for an empty bucket", async () => {
    const report = await scan();
    expect(report.total).toEqual({ count: 0, bytes: 0 });
    expect(report.incomplete).toBe(false);
    expect(Object.keys(report.states)).toEqual([
      "live",
      "expired_grace",
      "expired_final",
      "staging",
      "orphan",
    ]);
  });

  it("books each drop into the state its expiry puts it in", async () => {
    seedDrop("D1", "aaaaaaaaaa", null); // never expires
    seedDrop("D2", "bbbbbbbbbb", at(60 * 60 * 1000)); // an hour from now
    seedDrop("D3", "cccccccccc", at(-60 * 60 * 1000)); // an hour ago: grace
    seedDrop("D4", "dddddddddd", at(-GRACE_MS - 1000)); // past grace

    const report = await scan();

    expect(report.states.live.count).toBe(2);
    expect(report.states.expired_grace.count).toBe(1);
    expect(report.states.expired_final.count).toBe(1);
    expect(report.total.count).toBe(4);
  });

  it("counts the bytes of every object a drop holds, meta included", async () => {
    seedDrop("D1", "aaaaaaaaaa", null, [
      ["aa", 100],
      ["bb", 250],
    ]);
    const report = await scan();

    // 350 bytes of blobs plus the meta.json body itself.
    expect(report.states.live.bytes).toBeGreaterThan(350);
    expect(report.total.bytes).toBe(report.states.live.bytes);
  });

  it("calls blobs with no meta.json orphans, and reads nothing to decide it", async () => {
    bucket.seed("drops/GONE/blobs/aa", "x".repeat(40));
    bucket.log.length = 0;

    const report = await scan();

    expect(report.states.orphan).toEqual({ count: 1, bytes: 40 });
    expect(bucket.log.filter((entry) => entry.startsWith("get "))).toHaveLength(0);
  });

  it("counts a staged upload as staging, not as a drop", async () => {
    bucket.seed("uploads/U1/session.json", "x".repeat(30));
    const report = await scan();

    expect(report.states.staging).toEqual({ count: 1, bytes: 30 });
    expect(report.states.live.count).toBe(0);
  });

  it("stops at the ops budget and hands back a cursor", async () => {
    for (let i = 0; i < 5; i += 1) seedDrop(`D${i}`, `slug-${i}-xxxx`, null);

    const report = await usage({ bucket, now: NOW, budget: 3 });

    expect(report.incomplete).toBe(true);
    expect(report.total.count).toBeLessThan(5);
    expect(report.cursor).toBe("D1");
  });

  it("resumes from the cursor and counts every drop exactly once", async () => {
    for (let i = 0; i < 5; i += 1) seedDrop(`D${i}`, `slug-${i}-xxxx`, null);

    let counted = 0;
    let cursor: string | undefined;
    for (let round = 0; round < 10; round += 1) {
      const page: { total: { count: number }; incomplete: boolean; cursor?: string } =
        await usage({ bucket, now: NOW, budget: 3, cursor });
      counted += page.total.count;
      if (!page.incomplete) break;
      expect(page.cursor).toBeDefined();
      cursor = page.cursor;
    }

    expect(counted).toBe(5);
  });

  it("finishes when the budget is enough", async () => {
    for (let i = 0; i < 5; i += 1) seedDrop(`D${i}`, `slug-${i}-xxxx`, null);

    const report = await usage({ bucket, now: NOW, budget: 100 });

    expect(report.incomplete).toBe(false);
    expect(report.cursor).toBeUndefined();
    expect(report.total.count).toBe(5);
  });
});

describe("prune", () => {
  it("deletes nothing on a dry run and reports what it would take", async () => {
    seedDrop("D1", "aaaaaaaaaa", at(-GRACE_MS - 1000));
    const before = bucket.keys().length;

    const report = await prune({ bucket, now: NOW, budget: 100, dryRun: true });

    expect(report.dry_run).toBe(true);
    expect(report.states.expired_final.count).toBe(1);
    expect(report.deleted).toEqual({ drops: 0, objects: 0, bytes: 0 });
    expect(bucket.keys().length).toBe(before);
  });

  it("deletes an expired_final drop with all four of its keys", async () => {
    const expiresAt = at(-GRACE_MS - 1000);
    seedDrop("D1", "aaaaaaaaaa", expiresAt);

    const report = await prune({ bucket, now: NOW, budget: 100, dryRun: false });

    expect(report.deleted.drops).toBe(1);
    expect(bucket.keys()).toEqual([]);
  });

  it("leaves a drop inside its grace window alone", async () => {
    seedDrop("D1", "aaaaaaaaaa", at(-60 * 60 * 1000));

    const report = await prune({ bucket, now: NOW, budget: 100, dryRun: false });

    expect(report.deleted.drops).toBe(0);
    expect(bucket.keys("drops/D1/")).toHaveLength(2);
  });

  it("leaves an orphan to the reconcile rather than guessing", async () => {
    bucket.seed("drops/GONE/blobs/aa", "x");

    await prune({ bucket, now: NOW, budget: 100, dryRun: false });

    expect(bucket.keys("drops/GONE/")).toHaveLength(1);
  });

  it("is safe to run twice", async () => {
    seedDrop("D1", "aaaaaaaaaa", at(-GRACE_MS - 1000));

    await prune({ bucket, now: NOW, budget: 100, dryRun: false });
    const second = await prune({ bucket, now: NOW, budget: 100, dryRun: false });

    expect(second.deleted.drops).toBe(0);
    expect(second.total.count).toBe(0);
  });

  it("shares the usage report's shape", async () => {
    seedDrop("D1", "aaaaaaaaaa", null);

    const report = await prune({ bucket, now: NOW, budget: 100, dryRun: true });
    const plain = await scan();

    expect(report.states).toEqual(plain.states);
    expect(report.total).toEqual(plain.total);
  });
});
