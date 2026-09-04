/**
 * What one `list` page costs (AGENTS.md, "Key layout": a page "costs ONE
 * `list()` and no `meta.json` reads"; issue #24, finding 13).
 *
 * The listing pointer's `customMetadata` carries every field of the row, so
 * the page needs nothing else. Verifying each row against the truth would put
 * one R2 operation per row back — measured at ~10 s for a 100-row page — and
 * that is the exact cost the projection exists to remove. Orphans are the
 * reconcile's, which is the component AGENTS.md gives them to.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Drop } from "../src/domain/meta.js";
import { harness, USER_KEY } from "./app-harness.js";
import type { Harness } from "./app-harness.js";

let h: Harness;

beforeEach(async () => {
  h = await harness();
});

const publish = async (title: string): Promise<Drop> => {
  const response = await h.json(
    "/_api/v1/drops",
    "POST",
    { files: [{ path: "a.txt", text: title }], title },
    { key: USER_KEY },
  );
  expect(response.status).toBe(201);
  return h.body<Drop>(response);
};

describe("one list page", () => {
  it("is one list() and no per-row read of the truth", async () => {
    for (const title of ["one", "two", "three"]) await publish(title);

    h.bucket.log.length = 0;
    const response = await h.call("/_api/v1/drops", {}, USER_KEY);
    expect(response.status).toBe(200);
    expect((await h.body<{ drops: Drop[] }>(response)).drops).toHaveLength(3);

    // The bearer lookup is two reads; the config is one. Beyond those the page
    // is a single `list()`.
    const drops = h.bucket.log.filter((line) => line.includes("drops/"));
    expect(drops).toEqual([]);
    expect(h.bucket.log.filter((line) => line.startsWith("list "))).toEqual(["list list/"]);
  });
});
