import { describe, expect, it } from "vitest";
import { generateSlug, isSlug, SLUG_ALPHABET, SLUG_LENGTH } from "../src/domain/slug.js";

/** A stand-in for `crypto.getRandomValues` that yields a scripted byte stream. */
function scriptedRandom(bytes: readonly number[]) {
  let next = 0;
  return (buffer: Uint8Array<ArrayBuffer>) => {
    for (let i = 0; i < buffer.length; i += 1) {
      buffer[i] = bytes[next % bytes.length] ?? 0;
      next += 1;
    }
    return buffer;
  };
}

describe("generateSlug", () => {
  it("is 10 characters of a-z0-9", () => {
    const slug = generateSlug();
    expect(slug).toHaveLength(SLUG_LENGTH);
    expect(slug).toMatch(/^[a-z0-9]{10}$/);
  });

  it("never starts with the reserved underscore", () => {
    for (let i = 0; i < 200; i += 1) expect(generateSlug().startsWith("_")).toBe(false);
  });

  it("does not repeat itself across calls", () => {
    const slugs = new Set(Array.from({ length: 200 }, () => generateSlug()));
    expect(slugs.size).toBe(200);
  });

  it("maps each accepted byte to the alphabet by index", () => {
    expect(generateSlug(scriptedRandom([0]))).toBe(SLUG_ALPHABET[0]!.repeat(10));
    expect(generateSlug(scriptedRandom([35]))).toBe(SLUG_ALPHABET[35]!.repeat(10));
  });

  it("rejects bytes in the biased tail instead of folding them", () => {
    // 256 is not a multiple of 36: bytes 252-255 would over-represent a-d.
    // 252 must be discarded and the next byte used, so the result is "aaaaaaaaaa".
    expect(generateSlug(scriptedRandom([252, 0]))).toBe("a".repeat(10));
  });
});

describe("isSlug", () => {
  it.each(["abcdefghij", "0123456789", "a1b2c3d4e5"])("accepts %s", (slug) => {
    expect(isSlug(slug)).toBe(true);
  });

  it.each(["", "abc", "abcdefghijk", "ABCDEFGHIJ", "_bcdefghij", "abcdefghi-", "abcdefghi/"])(
    "rejects %s",
    (slug) => {
      expect(isSlug(slug)).toBe(false);
    },
  );
});
