/**
 * The tolerant `meta.json` reader (AGENTS.md, "Data durability": "readers
 * ignore unknown fields and default missing ones, so a newer Worker serves an
 * older drop unchanged"; issue #24, finding 18).
 *
 * Every read of the truth went through `JSON.parse(...) as DropMeta`, which is
 * a promise the type system cannot keep: a record written by another version
 * of this Worker has no reason to carry today's field set. One parser now
 * answers for all of them, and it does two things a cast cannot — it fills a
 * missing field with the value the product documents, and it CARRIES a field
 * it does not know, so a rewrite by an older Worker does not silently drop
 * what a newer one stored.
 */
import { describe, expect, it } from "vitest";
import { META_SCHEMA, parseDropMeta } from "../src/domain/meta.js";

const complete = {
  schema: 1,
  id: "01ABC",
  slug: "abcdefghij",
  title: "T",
  meta: { a: 1 },
  access: {},
  current_gen: "gen",
  manifest: { "a.txt": { sha256: "aa", size: 3, content_type: "text/plain" } },
  expires_at: null,
  noindex: true,
  created_by: { id: "k1", label: "anna" },
  created: "2026-09-04T00:00:00Z",
  updated: "2026-09-04T00:00:00Z",
};

describe("parseDropMeta", () => {
  it("round-trips a complete record unchanged", () => {
    expect(parseDropMeta(JSON.stringify(complete))).toEqual(complete);
  });

  it("defaults every field a leaner record leaves out", () => {
    const lean = { id: "01ABC", slug: "abcdefghij", manifest: {} };
    expect(parseDropMeta(JSON.stringify(lean))).toEqual({
      schema: META_SCHEMA,
      id: "01ABC",
      slug: "abcdefghij",
      title: null,
      meta: {},
      access: {},
      current_gen: "",
      manifest: {},
      expires_at: null,
      // On by default: the safe answer when a record does not say.
      noindex: true,
      created_by: { id: "", label: "" },
      created: "",
      updated: "",
    });
  });

  it("types a manifest entry from its path when the record does not", () => {
    const record = { ...complete, manifest: { "page.html": { sha256: "bb" } } };
    expect(parseDropMeta(JSON.stringify(record))!.manifest["page.html"]).toEqual({
      sha256: "bb",
      size: 0,
      content_type: "text/html",
    });
  });

  it("carries a field it does not know, so a rewrite loses nothing", () => {
    const newer = { ...complete, tenant: "acme", access: { price: 500 } };
    const parsed = parseDropMeta(JSON.stringify(newer))!;
    expect((parsed as unknown as { tenant: string }).tenant).toBe("acme");
    expect(parsed.access).toEqual({ price: 500 });
  });

  it("refuses a record that cannot name its own drop", () => {
    expect(parseDropMeta("not json")).toBeNull();
    expect(parseDropMeta("[]")).toBeNull();
    expect(parseDropMeta(JSON.stringify({ slug: "abcdefghij" }))).toBeNull();
    expect(parseDropMeta(JSON.stringify({ id: "01ABC" }))).toBeNull();
  });

  it("drops a manifest entry with no digest rather than serving a hole", () => {
    const record = { ...complete, manifest: { "a.txt": { size: 1 }, "b.txt": { sha256: "cc" } } };
    expect(Object.keys(parseDropMeta(JSON.stringify(record))!.manifest)).toEqual(["b.txt"]);
  });
});
