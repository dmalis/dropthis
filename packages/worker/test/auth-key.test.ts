import { describe, expect, it } from "vitest";
import { hashKey, mintKey, sameHash } from "../src/auth/key.js";
import { keyHashKey, keyRecordKey, newKeyId, userKey } from "../src/storage/keys.js";

/**
 * Keys are 32 random bytes, shown once, stored only as `sha256(key)`
 * (docs/spec-v1.md, "Auth"). Nothing here can turn a stored hash back into a
 * key, which is why `user add` is the only moment a key exists in plaintext.
 */
describe("mintKey", () => {
  it("is 32 bytes, presented as 64 lowercase hex characters", () => {
    expect(mintKey()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never repeats", () => {
    const minted = new Set(Array.from({ length: 200 }, () => mintKey()));
    expect(minted.size).toBe(200);
  });
});

describe("hashKey", () => {
  it("is sha256 of the key text, in lowercase hex", async () => {
    // `printf 'dropthis' | shasum -a 256` — computed outside this codebase.
    expect(await hashKey("dropthis")).toBe(
      "6f1f0169069d94ac21731188fe0b2730e50ada3e8935953090b2033c86ed7659",
    );
  });

  it("gives a different hash for a different key", async () => {
    expect(await hashKey(mintKey())).not.toBe(await hashKey(mintKey()));
  });
});

describe("sameHash", () => {
  it("accepts two identical hashes", async () => {
    const hash = await hashKey("k");
    expect(sameHash(hash, hash)).toBe(true);
  });

  it("rejects a different hash of the same length", async () => {
    expect(sameHash(await hashKey("a"), await hashKey("b"))).toBe(false);
  });

  it("rejects a hash of a different length without throwing", () => {
    expect(sameHash("abc", "abcd")).toBe(false);
  });

  it("rejects a non-hex string without throwing", () => {
    expect(sameHash("zz", "zz")).toBe(false);
  });
});

describe("key layout", () => {
  it("computes the three key records' bucket keys", () => {
    expect(keyRecordKey("01J")).toBe("keys/01J.json");
    expect(keyHashKey("deadbeef")).toBe("keyhash/deadbeef");
    expect(userKey("anna")).toBe("users/anna");
  });

  it("mints a sortable key id", () => {
    const early = newKeyId(new Date("2026-01-01T00:00:00Z"));
    const late = newKeyId(new Date("2026-09-03T00:00:00Z"));
    expect(early < late).toBe(true);
    expect(early).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});
