import { describe, expect, it } from "vitest";
import {
  SlugError,
  VANITY_MAX_LENGTH,
  VANITY_MIN_LENGTH,
  generateSlug,
  isSlug,
  normalizeVanitySlug,
  SLUG_ALPHABET,
  SLUG_LENGTH,
} from "../src/domain/slug.js";
import { RESERVED_PREFIXES } from "../src/reserved.js";

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
  it.each(["abcdefghij", "0123456789", "a1b2c3d4e5"])("accepts the generated form %s", (slug) => {
    expect(isSlug(slug)).toBe(true);
  });

  it.each(["abc", "tan-dash", "spring-2026-campaign", "newsletter", "9".repeat(40)])(
    "accepts the vanity form %s",
    (slug) => {
      expect(isSlug(slug)).toBe(true);
    },
  );

  it.each(["", "ab", "a".repeat(41), "ABCDEFGHIJ", "_bcdefghij", "-tan-dash", "tan_dash", "abcdefghi/", "tan dash", "tän-dash"])(
    "rejects %s",
    (slug) => {
      expect(isSlug(slug)).toBe(false);
    },
  );

  it.each(RESERVED_PREFIXES)("rejects the reserved prefix %s", (prefix) => {
    expect(isSlug(prefix.slice(1))).toBe(false);
  });
});

/**
 * The two forms are NOT disjoint, deliberately: a ten-character all-alphanumeric
 * vanity slug ("newsletter") is exactly what a marketing team asks for, and
 * refusing it to keep the namespaces apart would be a worse product for no
 * safety. Nothing in the Worker ever has to tell a generated slug from a chosen
 * one, and the collision is already handled where it happens: `slugs/<slug>` is
 * claimed with `If-None-Match: *`, so a generated publish that lands on a taken
 * slug simply generates another (`operations/publish.ts`, `claimSlug`), and a
 * chosen one that lands on a taken slug is SLUG_TAKEN.
 */
describe("normalizeVanitySlug", () => {
  it("returns a valid slug unchanged", () => {
    expect(normalizeVanitySlug("tan-dash")).toBe("tan-dash");
  });

  it("lower-cases, NFC-normalises and trims before validating", () => {
    expect(normalizeVanitySlug("  TAN-Dash ")).toBe("tan-dash");
    // U+0041 U+030A (A + combining ring) folds to NFC "Å", which is not a-z0-9.
    expect(() => normalizeVanitySlug("A\u030Angstrom")).toThrow(SlugError);
  });

  it("accepts the ten-character generated shape as a chosen slug", () => {
    expect(normalizeVanitySlug("newsletter")).toBe("newsletter");
    expect(normalizeVanitySlug("newsletter")).toHaveLength(SLUG_LENGTH);
  });

  it.each([
    ["ab", "shorter than the minimum"],
    ["a".repeat(VANITY_MAX_LENGTH + 1), "longer than the maximum"],
    ["-tan-dash", "a leading dash"],
    ["_tan-dash", "a leading underscore"],
    ["tan_dash", "an underscore"],
    ["tan dash", "a space"],
    ["tan.dash", "a dot"],
    ["tan/dash", "a slash"],
  ])("refuses %s (%s)", (value) => {
    expect(() => normalizeVanitySlug(value)).toThrow(SlugError);
  });

  it.each(RESERVED_PREFIXES)("refuses the reserved prefix %s", (prefix) => {
    expect(() => normalizeVanitySlug(prefix.slice(1))).toThrow(SlugError);
  });

  it("names INVALID_INPUT so the route layer needs no mapping table", () => {
    expect(() => normalizeVanitySlug("ab")).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(VANITY_MIN_LENGTH).toBe(3);
    expect(VANITY_MAX_LENGTH).toBe(40);
  });
});
