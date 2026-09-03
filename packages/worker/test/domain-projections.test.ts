import { describe, expect, it } from "vitest";
import { newDropMeta, toDrop } from "../src/domain/meta.js";
import type { DropMeta } from "../src/domain/meta.js";
import { dropFromListEntry, listEntryMetadata, slugOfListKey } from "../src/domain/projections.js";
import { listKey, listKeyForDrop } from "../src/storage/keys.js";

const NOW = new Date("2026-09-03T12:00:00Z");
const CANONICAL = "https://drops.example.com";

async function meta(overrides: Partial<DropMeta> = {}): Promise<DropMeta> {
  const base = await newDropMeta({
    id: "01K4ABCDEFGHJKMNPQRSTVWXYZ",
    slug: "abcdefghij",
    title: "Quarterly Report",
    meta: { workflow: "weekly" },
    manifest: { "a.txt": { sha256: "ab".repeat(32), size: 1, content_type: "text/plain" } },
    expiresAt: "2026-10-03T12:00:00Z",
    noindex: true,
    createdBy: { id: "key_1", label: "alice" },
    now: NOW,
  });
  return { ...base, ...overrides };
}

/**
 * `list` builds its items from the pointer's `customMetadata` alone — no
 * `meta.json` read per row. That only works if the projection carries every
 * field of the `Drop` shape `list` returns, so the invariant is checked
 * directly: projecting and reading back equals `toDrop` of the record itself.
 */
describe("the list/ projection round-trips to the Drop list shape", () => {
  it("reproduces toDrop exactly, without meta and without files", async () => {
    const record = await meta();
    const key = listKeyForDrop(record.id, record.slug);
    const projected = dropFromListEntry(key, listEntryMetadata(record), {
      canonicalUrl: CANONICAL,
      now: NOW,
    });
    expect(projected).toEqual(toDrop(record, { canonicalUrl: CANONICAL, now: NOW, files: false, meta: false }));
  });

  it("round-trips a drop with no title and no expiry", async () => {
    const record = await meta({ title: null, expires_at: null });
    const key = listKeyForDrop(record.id, record.slug);
    const projected = dropFromListEntry(key, listEntryMetadata(record), {
      canonicalUrl: CANONICAL,
      now: NOW,
    });
    expect(projected.title).toBeNull();
    expect(projected.expires_at).toBeNull();
    expect(projected.state).toBe("live");
  });

  it("round-trips has_password and noindex", async () => {
    const record = await meta({ noindex: false, access: { password: { algorithm: "pbkdf2-sha256" } } });
    const key = listKeyForDrop(record.id, record.slug);
    const projected = dropFromListEntry(key, listEntryMetadata(record), {
      canonicalUrl: CANONICAL,
      now: NOW,
    });
    expect(projected.noindex).toBe(false);
    expect(projected.has_password).toBe(true);
  });

  it("derives the state at list time, not at write time", async () => {
    const record = await meta({ expires_at: "2026-09-01T00:00:00Z" });
    const key = listKeyForDrop(record.id, record.slug);
    const entry = listEntryMetadata(record);

    expect(dropFromListEntry(key, entry, { canonicalUrl: CANONICAL, now: NOW }).state).toBe(
      "expired_grace",
    );
    expect(
      dropFromListEntry(key, entry, {
        canonicalUrl: CANONICAL,
        now: new Date("2026-09-20T00:00:00Z"),
      }).state,
    ).toBe("expired_final");
  });

  it("stays inside R2's 8,192-byte customMetadata cap at every field's limit", async () => {
    const record = await meta({
      title: "é".repeat(100),
      created_by: { id: "k".repeat(64), label: "l".repeat(64) },
    });
    const entry = listEntryMetadata(record);
    const bytes = new TextEncoder().encode(
      Object.entries(entry)
        .map(([k, v]) => k + v)
        .join(""),
    ).length;
    expect(bytes).toBeLessThan(8192);
  });

  it("omits the expiry key entirely when a drop never expires", async () => {
    const record = await meta({ expires_at: null, title: null });
    expect(listEntryMetadata(record).expires_at).toBeUndefined();
    expect(listEntryMetadata(record).title).toBeUndefined();
  });
});

describe("slugOfListKey", () => {
  it("reads the slug back out of the key it was written into", () => {
    expect(slugOfListKey(listKey(Date.parse("2026-09-03T12:00:00Z"), "abcdefghij"))).toBe(
      "abcdefghij",
    );
  });

  /**
   * A chosen slug holds dashes, and the key is `<13 digits>-<slug>`: the
   * separator is the dash after a FIXED-width number, so the slug half is
   * unambiguous however many dashes it carries. `list` builds its whole row —
   * url included — from this, so a slug that failed to parse would come back
   * as an empty string and a broken URL.
   */
  it("reads a chosen slug back, dashes and all", () => {
    const key = listKey(Date.parse("2026-09-03T12:00:00Z"), "spring-2026-campaign");
    expect(slugOfListKey(key)).toBe("spring-2026-campaign");
  });

  it("returns null for a key that is not a listing pointer", () => {
    expect(slugOfListKey("list/nonsense")).toBeNull();
    expect(slugOfListKey("drops/x/meta.json")).toBeNull();
    expect(slugOfListKey("list/0000000000000--tan-dash")).toBeNull();
    expect(slugOfListKey("list/0000000000000-ab")).toBeNull();
  });
});
