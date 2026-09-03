import { describe, expect, it } from "vitest";
import { mergeAgentMeta } from "../src/domain/meta.js";

/**
 * `update({meta})` merges at the top level and `null` deletes a key
 * (docs/spec-v1.md, "`update` semantics"). Values are ANY JSON: the archived
 * product advertised JSON and rejected non-strings, and agents got 422s.
 */
describe("mergeAgentMeta", () => {
  it("adds a key the drop did not have", () => {
    expect(mergeAgentMeta({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
  });

  it("overwrites a key at the top level, whole", () => {
    expect(mergeAgentMeta({ a: { keep: 1 } }, { a: { other: 2 } })).toEqual({ a: { other: 2 } });
  });

  it("deletes a key set to null", () => {
    expect(mergeAgentMeta({ a: 1, b: 2 }, { b: null })).toEqual({ a: 1 });
  });

  it("deleting a key that is not there is not an error", () => {
    expect(mergeAgentMeta({ a: 1 }, { gone: null })).toEqual({ a: 1 });
  });

  it("keeps any JSON value, including nested null inside an object or array", () => {
    const merged = mergeAgentMeta({}, {
      n: 0,
      f: false,
      s: "",
      arr: [1, null, { x: null }],
      obj: { inner: null },
    });
    expect(merged).toEqual({
      n: 0,
      f: false,
      s: "",
      arr: [1, null, { x: null }],
      obj: { inner: null },
    });
  });

  it("does not mutate the stored meta", () => {
    const current = { a: 1, b: 2 };
    mergeAgentMeta(current, { b: null, c: 3 });
    expect(current).toEqual({ a: 1, b: 2 });
  });

  it("an empty patch is the identity", () => {
    expect(mergeAgentMeta({ a: 1 }, {})).toEqual({ a: 1 });
  });

  it("a patch of only nulls can empty the object", () => {
    expect(mergeAgentMeta({ a: 1 }, { a: null })).toEqual({});
  });
})
