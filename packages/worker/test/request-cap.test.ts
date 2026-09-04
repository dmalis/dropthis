/**
 * The single-call ceiling (AGENTS.md: "the single-call ceiling is policy
 * `max_request_bytes`"; issue #24, finding 15).
 *
 * It is a ceiling in BYTES, and it must hold for a client that sends no
 * `Content-Length` — which is every client that streams. Counting
 * `String.length` counted UTF-16 code units instead, so a body of three-byte
 * characters passed at three times the cap; and reading the whole body before
 * measuring it meant an oversized call was paid for in full before it was
 * refused.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { harness, USER_KEY } from "./app-harness.js";
import type { Harness } from "./app-harness.js";

let h: Harness;
const CAP = 4096;

beforeEach(async () => {
  h = await harness({ max_request_bytes: CAP });
});

const encoder = new TextEncoder();

/** A body with no `Content-Length`: the shape a streaming client sends. */
function streamed(text: string): ReadableStream<Uint8Array> {
  const bytes = encoder.encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let at = 0; at < bytes.length; at += 512) {
        controller.enqueue(bytes.slice(at, at + 512));
      }
      controller.close();
    },
  });
}

const post = (body: ReadableStream<Uint8Array>) =>
  h.call(
    "/_api/v1/drops",
    { method: "POST", headers: { "content-type": "application/json" }, body, duplex: "half" } as RequestInit,
    USER_KEY,
  );

const codeOf = async (response: Response) =>
  ((await response.json()) as { error?: { code: string } }).error?.code;

describe("max_request_bytes with no Content-Length", () => {
  it("counts UTF-8 bytes, not UTF-16 code units", async () => {
    // 2,000 euro signs are 2,000 code units and 6,000 bytes: over the cap.
    const text = JSON.stringify({
      files: [{ path: "a.txt", text: "€".repeat(2000) }],
    });
    expect(text.length).toBeLessThan(CAP);
    expect(encoder.encode(text).length).toBeGreaterThan(CAP);

    const response = await post(streamed(text));
    expect(response.status).toBe(413);
    expect(await codeOf(response)).toBe("PAYLOAD_TOO_LARGE");
  });

  it("stops reading at the cap instead of buffering the whole body", async () => {
    let sent = 0;
    const chunk = encoder.encode("x".repeat(1024));
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += chunk.length;
        controller.enqueue(chunk);
        if (sent > CAP * 100) controller.close();
      },
    });

    const response = await post(body);
    expect(response.status).toBe(413);
    // Refused within a chunk or two of the cap, never after the whole stream.
    expect(sent).toBeLessThan(CAP * 4);
  });

  it("still accepts a body under the cap", async () => {
    const text = JSON.stringify({ files: [{ path: "a.txt", text: "€".repeat(100) }] });
    const response = await post(streamed(text));
    expect(response.status).toBe(201);
  });
});
