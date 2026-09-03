import { describe, expect, it } from "vitest";
import { INLINE_CEILING_BYTES, chooseTransfer, inlineBodyBytes } from "../../src/cli/transfer.js";
import type { LocalFile } from "../../src/cli/files.js";

/**
 * The CLI publishes inline when the encoded body fits the ceiling it knows —
 * the packaged default `max_request_bytes`, 4 MiB — and stages above it. It
 * never asks the instance for its policy first (slice spec); an instance set
 * below the default answers PAYLOAD_TOO_LARGE and the CLI falls back.
 */
const file = (path: string, size: number): LocalFile => ({
  path,
  file: `/tmp/${path}`,
  size,
  sha256: "a".repeat(64),
});

describe("chooseTransfer", () => {
  it("knows the packaged ceiling", () => {
    expect(INLINE_CEILING_BYTES).toBe(4 * 1024 * 1024);
  });

  it("counts the base64 growth and the JSON around it", () => {
    const bytes = inlineBodyBytes([file("a.txt", 3)], { title: "T" });
    // {"files":[{"path":"a.txt","base64":"AAAA","sha256":"aaa…"}],"title":"T"}
    expect(bytes).toBe(
      Buffer.byteLength(JSON.stringify({ files: [{ path: "a.txt", base64: "AAAA", sha256: "a".repeat(64) }], title: "T" })),
    );
  });

  it("goes inline under the ceiling and staged above it", () => {
    expect(chooseTransfer([file("small.bin", Math.floor(2.9 * 1024 * 1024))], {})).toBe("inline");
    expect(chooseTransfer([file("big.bin", 5 * 1024 * 1024)], {})).toBe("staged");
    // Base64 growth: 3 MiB of bytes is 4 MiB encoded, plus the JSON around it.
    expect(chooseTransfer([file("edge.bin", 3 * 1024 * 1024)], {})).toBe("staged");
  });
});
