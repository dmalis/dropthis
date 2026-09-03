import { describe, expect, it } from "vitest";
import { LabelError, normalizeLabel } from "../src/domain/label.js";

/**
 * The one normalization every surface uses (AGENTS.md, "Team model"):
 * NFKC → case fold → trim → whitespace to `-`, then
 * `^[a-z0-9][a-z0-9._-]{0,62}$`. Two labels that normalize alike are ONE
 * person, which is what makes `users/<label>` a uniqueness claim.
 */
describe("normalizeLabel", () => {
  it("lowercases and trims", () => {
    expect(normalizeLabel("  Anna  ")).toBe("anna");
  });

  it("collapses inner whitespace to single dashes", () => {
    expect(normalizeLabel("Anna  Maria\tSmith")).toBe("anna-maria-smith");
  });

  it("applies NFKC before folding, so compatibility forms collide", () => {
    // U+FF21 FULLWIDTH LATIN CAPITAL LETTER A folds onto plain "anna".
    expect(normalizeLabel("\uFF21nna")).toBe("anna");
  });

  it("refuses a label that is not ASCII after folding", () => {
    // NFKC keeps "\u00e9"; the frozen regex is ASCII, so "jos\u00e9" is not a label.
    expect(() => normalizeLabel("Jos\u00e9")).toThrow(LabelError);
  });

  it("keeps the allowed punctuation", () => {
    expect(normalizeLabel("ci.bot_2-x")).toBe("ci.bot_2-x");
  });

  it("passes the admin label through unchanged", () => {
    expect(normalizeLabel("admin")).toBe("admin");
  });

  const rejected: Array<[string, string]> = [
    ["empty", ""],
    ["whitespace only", "   "],
    ["leading dash", "-anna"],
    ["leading dot", ".anna"],
    ["a slash", "anna/bob"],
    ["a colon", "anna:bob"],
    ["an at sign", "anna@example.com"],
    ["a control character", "an\u0001na"],
    ["longer than 63 characters", "a".repeat(64)],
  ];

  it.each(rejected)("refuses %s", (_name, value) => {
    expect(() => normalizeLabel(value)).toThrow(LabelError);
  });

  it("accepts exactly 63 characters", () => {
    expect(normalizeLabel("a".repeat(63))).toBe("a".repeat(63));
  });

  it("names the field and the rule in the message", () => {
    let message = "";
    try {
      normalizeLabel("-nope");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("label");
    expect(message).toContain("a-z0-9");
  });
});
