import { describe, expect, it } from "vitest";
import {
  blobKey,
  expiringKey,
  idempotencyHash,
  listKey,
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
