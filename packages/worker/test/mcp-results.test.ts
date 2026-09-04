/**
 * What a tool call ANSWERS, as opposed to what its description promises
 * (decision #80; issue #24, standards findings 1 and 2).
 *
 * Two rules meet here. "No `next` hints on success" (#51): the URL is the id,
 * and a line that tells an agent what to call next spends context on every
 * call to re-teach what the tool text already says. And "every operation is
 * defined once": the one line a text-only client sees belongs ON the operation
 * entry, not in a second map keyed by operation name — a map like that is a
 * registry nobody remembers to update.
 */
import { describe, expect, it } from "vitest";
import { successResult } from "../src/mcp/results.js";
import { OPERATIONS } from "../src/registry/index.js";
import { toolSurface } from "../src/mcp/tools.js";

const lineOf = (result: { content: Array<{ type: string; text?: string }> }) =>
  result.content[0]!.text!.split("\n")[0]!;

describe("the result line", () => {
  it("lives on the operation entry, for every tool the surface exposes", () => {
    const missing = toolSurface()
      .filter((tool) => OPERATIONS.find((op) => op.name === tool.operation)?.resultLine === undefined)
      .map((tool) => tool.name);
    expect(missing).toEqual([]);
  });

  it("tells the agent what happened and never what to call next", () => {
    const session = successResult(
      "upload.create",
      {},
      { upload_id: "u1", missing: ["aa", "bb"], put_urls: {} },
    );
    expect(lineOf(session)).toBe("Upload u1: PUT 2 files");
    expect(lineOf(session)).not.toContain("dropthis_commit");
  });

  it("opens with the URL on publish, which is the whole answer", () => {
    const published = successResult("publish", {}, { url: "https://x.test/abc", state: "live" });
    expect(lineOf(published)).toBe("Published: https://x.test/abc");
  });

  it("refuses an operation with no line rather than answering with none", () => {
    expect(() => successResult("nope", {}, {})).toThrow(/nope/);
  });
});
