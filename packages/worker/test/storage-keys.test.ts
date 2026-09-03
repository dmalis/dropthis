import { describe, expect, it } from "vitest";
import {
  blobKey,
  dropIdTimeMs,
  expiringKey,
  idempotencyHash,
  listKey,
  listKeyForDrop,
  metaKey,
  newDropId,
  requestClaimKey,
  requestResultKey,
  slugKey,
} from "../src/storage/keys.js";

describe("newDropId", () => {
  it("is a 26-character Crockford base32 ULID", () => {
    expect(newDropId(new Date("2026-09-03T12:00:00Z"))).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("does not repeat", () => {
    const ids = new Set(Array.from({ length: 500 }, () => newDropId()));
    expect(ids.size).toBe(500);
  });

  it("sorts by creation time, so `drops/` lists oldest first", () => {
    const early = newDropId(new Date("2026-09-03T12:00:00Z"));
    const late = newDropId(new Date("2026-09-03T12:00:01Z"));
    expect(early < late).toBe(true);
  });
});

describe("key builders", () => {
  it("places the record, the blobs and the pointer where the layout says", () => {
    expect(metaKey("D1")).toBe("drops/D1/meta.json");
    expect(blobKey("D1", "a".repeat(64))).toBe(`drops/D1/blobs/${"a".repeat(64)}`);
    expect(slugKey("abcdefghij")).toBe("slugs/abcdefghij");
    expect(expiringKey("2026-09-10", "D1")).toBe("expiring/2026-09-10/D1");
    expect(requestClaimKey("h")).toBe("requests/h/claim");
    expect(requestResultKey("h")).toBe("requests/h/result");
  });
});

describe("listKey", () => {
  it("inverts the creation time so R2's key order is newest-first", () => {
    const older = listKey(Date.parse("2026-09-03T12:00:00Z"), "aaaaaaaaaa");
    const newer = listKey(Date.parse("2026-09-04T12:00:00Z"), "aaaaaaaaaa");
    expect(newer < older).toBe(true);
  });

  it("zero-pads to a fixed width so string order is numeric order", () => {
    const long = listKey(Date.parse("2026-09-03T12:00:00Z"), "aaaaaaaaaa");
    const short = listKey(1, "aaaaaaaaaa");
    expect(long).toMatch(/^list\/\d{13}-aaaaaaaaaa$/);
    expect(short).toMatch(/^list\/\d{13}-aaaaaaaaaa$/);
    expect(long < short).toBe(true);
  });
});

describe("idempotencyHash", () => {
  it("scopes the key to the caller, so two keys never collide across users", async () => {
    expect(await idempotencyHash("key-a", "abc")).not.toBe(await idempotencyHash("key-b", "abc"));
  });

  it("is stable for the same caller and key", async () => {
    expect(await idempotencyHash("key-a", "abc")).toBe(await idempotencyHash("key-a", "abc"));
  });

  it("is 64 hex characters", async () => {
    expect(await idempotencyHash("key-a", "abc")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("dropIdTimeMs", () => {
  it("reads back the millisecond a drop id was minted at", () => {
    for (const iso of [
      "2026-09-03T12:00:00.000Z",
      "2026-09-03T12:00:00.001Z",
      "2026-09-03T12:00:00.999Z",
      "1970-01-01T00:00:00.000Z",
      "2199-12-31T23:59:59.999Z",
    ]) {
      const at = new Date(iso);
      expect(dropIdTimeMs(newDropId(at)), iso).toBe(at.getTime());
    }
  });

  it("orders two ids minted a millisecond apart", () => {
    const first = newDropId(new Date("2026-09-03T12:00:00.000Z"));
    const second = newDropId(new Date("2026-09-03T12:00:00.001Z"));
    expect(dropIdTimeMs(first)).toBeLessThan(dropIdTimeMs(second));
  });
});

/**
 * `list` is newest-first, and the ordering has to hold for drops published in
 * the SAME second — an agent publishing a batch does exactly that. The key
 * therefore carries milliseconds, which `created` (RFC 3339 at second
 * precision, a frozen response field) cannot supply; the drop id, a ULID, can.
 */
describe("listKeyForDrop", () => {
  it("sorts a newer drop before an older one, inside one second", () => {
    const older = newDropId(new Date("2026-09-03T12:00:00.100Z"));
    const newer = newDropId(new Date("2026-09-03T12:00:00.900Z"));
    expect(listKeyForDrop(newer, "bbbbbbbbbb") < listKeyForDrop(older, "aaaaaaaaaa")).toBe(true);
  });

  it("has the frozen shape", () => {
    const id = newDropId(new Date("2026-09-03T12:00:00.000Z"));
    expect(listKeyForDrop(id, "abcdefghij")).toMatch(/^list\/\d{13}-abcdefghij$/);
  });
})
