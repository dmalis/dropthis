import { describe, expect, it } from "vitest";
import { foldForSearch, matchesTitleQuery } from "../src/domain/search.js";

/**
 * `list?q=` is a substring match over `title` after NFC normalisation and
 * Unicode case folding, locale-independent (docs/spec-v1.md, "Responses").
 * There is no search index and there never will be, so the whole of `q` is
 * these two functions.
 */
describe("foldForSearch", () => {
  it("case-folds without a locale", () => {
    expect(foldForSearch("Ünïcode Report")).toBe("ünïcode report");
  });

  it("folds the two spellings of an accent to one string", () => {
    const composed = "café";
    const decomposed = `cafe${String.fromCharCode(0x301)}`;
    expect(composed).not.toBe(decomposed);
    expect(foldForSearch(decomposed)).toBe(foldForSearch(composed));
  });

  it("folds beyond simple lowercasing", () => {
    // Full case folding, not `toLowerCase`: ß folds to ss, ﬁ to fi.
    expect(foldForSearch("Straße")).toBe(foldForSearch("STRASSE"));
    expect(foldForSearch("ﬁle")).toBe(foldForSearch("FILE"));
  });

  it("is idempotent, so a folded string folds to itself", () => {
    for (const text of ["Ünïcode", "Straße", "ΟΔΟΣ", "café"]) {
      expect(foldForSearch(foldForSearch(text))).toBe(foldForSearch(text));
    }
  });

  it("folds Greek final sigma the same on both sides", () => {
    expect(foldForSearch("ΟΔΟΣ")).toBe(foldForSearch("οδος"));
  });
});

describe("matchesTitleQuery", () => {
  it("matches a substring anywhere in the title", () => {
    expect(matchesTitleQuery("Quarterly Report 2026", "report")).toBe(true);
    expect(matchesTitleQuery("Quarterly Report 2026", "2026")).toBe(true);
    expect(matchesTitleQuery("Quarterly Report 2026", "quarterly")).toBe(true);
  });

  it("does not match what is not there", () => {
    expect(matchesTitleQuery("Quarterly Report", "annual")).toBe(false);
  });

  it("ignores case and accent spelling on both sides", () => {
    expect(matchesTitleQuery("Ünïcode Report", "ünïcode report")).toBe(true);
    expect(matchesTitleQuery("Café Notes", `cafe${String.fromCharCode(0x301)}`)).toBe(true);
  });

  it("treats a drop with no title as unmatched, never as a wildcard", () => {
    expect(matchesTitleQuery(null, "anything")).toBe(false);
  });

  it("matches everything when the query is empty", () => {
    expect(matchesTitleQuery("anything", "")).toBe(true);
    expect(matchesTitleQuery(null, "")).toBe(true);
  });
});
