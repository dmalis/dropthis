/**
 * Inline or staged? (AGENTS.md, "One call uploads a drop"; decision #73.)
 *
 * The CLI publishes inline when the encoded request body fits the ceiling it
 * knows — the packaged default `max_request_bytes`, 4 MiB — and stages above
 * it. It never asks the instance for its policy first: that is a round trip
 * on every publish for a number that almost never changes. An instance set
 * BELOW the default answers `PAYLOAD_TOO_LARGE` to the inline attempt, and
 * the caller falls back to the staged path on that code.
 */
import { INITIAL_POLICY } from "../../../worker/src/policy/defaults.js";
import type { LocalFile } from "./files.js";

export const INLINE_CEILING_BYTES: number = INITIAL_POLICY.max_request_bytes;

export type Transfer = "inline" | "staged";

/**
 * The exact size of the inline body without building it: base64 has no
 * characters JSON escapes, so an entry's encoded length is arithmetic.
 */
export function inlineBodyBytes(files: readonly LocalFile[], settings: Record<string, unknown>): number {
  const skeleton = JSON.stringify({
    files: files.map((file) => ({ path: file.path, base64: "", sha256: file.sha256 })),
    ...settings,
  });
  const base64 = files.reduce((sum, file) => sum + Math.ceil(file.size / 3) * 4, 0);
  return Buffer.byteLength(skeleton) + base64;
}

export function chooseTransfer(
  files: readonly LocalFile[],
  settings: Record<string, unknown>,
  ceiling = INLINE_CEILING_BYTES,
): Transfer {
  return inlineBodyBytes(files, settings) <= ceiling ? "inline" : "staged";
}
