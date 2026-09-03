import { describe, expect, it } from "vitest";
import { normalizeDropPath, normalizeManifestPaths, PathError } from "../src/domain/paths.js";

/** "cafe" + U+0301 COMBINING ACUTE ACCENT — the NFD spelling of "café". */
const CAFE_NFD = `cafe${String.fromCharCode(0x301)}`;
/** The same word as one precomposed code point. */
const CAFE_NFC = "café";

const chr = String.fromCharCode;

describe("normalizeDropPath", () => {
  it("keeps an ordinary relative path", () => {
    expect(normalizeDropPath("docs/report.html")).toBe("docs/report.html");
  });

  it("normalises to NFC so two spellings of the same name collide", () => {
    expect(normalizeDropPath(`${CAFE_NFD}/index.html`)).toBe(`${CAFE_NFC}/index.html`);
  });

  it.each([
    ["absolute", "/index.html"],
    ["parent segment", "a/../b.txt"],
    ["dot segment", "./a.txt"],
    ["bare parent", ".."],
    ["backslash", "a\\b.txt"],
    ["control character", `a${chr(0x01)}b.txt`],
    ["nul", `a${chr(0x00)}b`],
    ["delete character", `a${chr(0x7f)}b.txt`],
    ["empty", ""],
    ["empty segment", "a//b.txt"],
    ["trailing slash", "a/b/"],
  ])("rejects %s", (_label, path) => {
    expect(() => normalizeDropPath(path)).toThrow(PathError);
  });

  it("rejects a segment over 255 bytes", () => {
    expect(() => normalizeDropPath(`${"a".repeat(256)}.txt`)).toThrow(PathError);
  });

  it("accepts a segment of exactly 255 bytes", () => {
    const segment = "a".repeat(255);
    expect(normalizeDropPath(segment)).toBe(segment);
  });

  it("counts segment length in UTF-8 bytes, not code points", () => {
    // 128 precomposed "é" = 128 code points but 256 UTF-8 bytes.
    expect(() => normalizeDropPath(CAFE_NFC.slice(3).repeat(128))).toThrow(PathError);
  });

  it("rejects a path over 1024 bytes in total", () => {
    const path = Array.from({ length: 8 }, () => "a".repeat(200)).join("/");
    expect(path.length).toBeGreaterThan(1024);
    expect(() => normalizeDropPath(path)).toThrow(PathError);
  });
});

describe("normalizeManifestPaths", () => {
  it("returns the normalised paths in input order", () => {
    expect(normalizeManifestPaths(["b.txt", "a.txt"])).toEqual(["b.txt", "a.txt"]);
  });

  it("rejects duplicates that appear only after NFC normalisation", () => {
    expect(() => normalizeManifestPaths([`${CAFE_NFD}.txt`, `${CAFE_NFC}.txt`])).toThrow(PathError);
  });

  it("names the offending path in the error message", () => {
    expect(() => normalizeManifestPaths(["ok.txt", "../bad.txt"])).toThrow(/\.\.\/bad\.txt/);
  });
});
