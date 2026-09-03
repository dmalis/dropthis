/**
 * The field rules `publish` and `update` share.
 *
 * They live in one file because the operation registry's promise is that REST,
 * the CLI and the MCP tools cannot drift (AGENTS.md, "Operation registry"). Two
 * operations that take `title` and disagree about its limit would be the same
 * drift one layer down.
 */
import { z } from "zod";
import { ApiError } from "../errors.js";

/** Derived from the Free subrequest budget: ~507 internal calls at 500 files. */
export const MAX_FILES_PER_CALL = 500;
/** The `title` limit everywhere it appears, including the `list/` pointer. */
export const MAX_TITLE_BYTES = 200;
/** The agent's own notes on the drop; large enough for real provenance. */
export const MAX_META_BYTES = 16 * 1024;

const encoder = new TextEncoder();

/** One canonical sentence per field, shared by every surface that shows a schema. */
export const PATH_DESCRIPTION =
  "Relative path inside the drop, forward slashes: index.html, report.pdf, docs/a.html.";
export const TITLE_DESCRIPTION =
  "Short human name of the drop (200 bytes max), shown in lists and on the password page. Always set it.";
export const META_DESCRIPTION =
  "Your own JSON notes on the drop (16 KB max): what it is, where the data came from, who it was sent to. Returned by get, never shown to visitors.";
export const EXPIRES_DESCRIPTION =
  'When the link stops working: "7d", "2026-12-31", an RFC 3339 instant, or "never".';
export const PASSWORD_DESCRIPTION =
  '"generate" for a random 16-character password returned once, in this response; a chosen ' +
  "password of at least 8 characters; or null for none.";
export const NOINDEX_DESCRIPTION = "Tell search engines to stay away (default true).";
export const IDEMPOTENCY_DESCRIPTION =
  "A key you choose; a retry with the same key and payload returns the same result instead of acting twice.";

const textEntry = z.strictObject({
  path: z.string().describe(PATH_DESCRIPTION),
  text: z.string().describe("The file's text (UTF-8). For text-typed files only."),
});
const base64Entry = z.strictObject({
  path: z.string().describe(PATH_DESCRIPTION),
  base64: z.string().describe("The file's bytes, base64-encoded. For binaries."),
  /**
   * Optional: a client that already hashed the bytes (the CLI always does)
   * sends it, and the Worker refuses a mismatch as `HASH_MISMATCH` instead of
   * storing bytes the client did not mean to send.
   */
  sha256: z.string().optional(),
});

/**
 * A union of strict objects, which is how "exactly one of `text` and `base64`"
 * is expressed: an entry with both matches neither branch, and so does an entry
 * with neither.
 */
export const fileEntry = z.union([textEntry, base64Entry]);

export const FILES_DESCRIPTION =
  "The files, each {path, text} or {path, base64}, exactly one of the two. On update, the WHOLE set.";

export type PublishFile = z.infer<typeof fileEntry>;

/** zod's first issue, as one sentence naming the field an agent must fix. */
export function describeIssues(error: z.ZodError, fields: string): string {
  const issue = error.issues[0];
  if (issue === undefined) return "The request body is not valid.";
  const where = issue.path.length > 0 ? issue.path.join(".") : "the request body";
  if (issue.code === "unrecognized_keys") {
    return `Unknown field${issue.keys.length > 1 ? "s" : ""} ${issue.keys.join(", ")}: this operation takes ${fields}.`;
  }
  if (issue.code === "invalid_union") {
    return `Each entry of ${where} needs a path and exactly one of text or base64.`;
  }
  return `${where}: ${issue.message}`;
}

/**
 * `files` is the whole set, on both operations: `publish` creates it and
 * `update` replaces it. An empty array is refused rather than treated as "no
 * files" — a drop with nothing in it is `delete`, spelled clearly.
 */
export function checkFiles(files: readonly unknown[]): void {
  if (files.length === 0) {
    throw new ApiError("INVALID_INPUT", "files must hold at least one entry.");
  }
  if (files.length > MAX_FILES_PER_CALL) {
    throw new ApiError(
      "POLICY_VIOLATION",
      `A single call carries at most ${MAX_FILES_PER_CALL} files; this one has ${files.length}.`,
    );
  }
}

/**
 * NFC now, because the title is hashed into the drop's state and compared byte
 * for byte on an idempotent retry.
 */
export function normalizeTitle(title: string): string {
  const normalized = title.normalize("NFC");
  const bytes = encoder.encode(normalized).length;
  if (bytes > MAX_TITLE_BYTES) {
    throw new ApiError(
      "INVALID_INPUT",
      `title is ${bytes} bytes; the limit is ${MAX_TITLE_BYTES} bytes of UTF-8.`,
    );
  }
  return normalized;
}

export function checkMetaSize(meta: Record<string, unknown>, what = "meta"): void {
  const bytes = encoder.encode(JSON.stringify(meta)).length;
  if (bytes > MAX_META_BYTES) {
    throw new ApiError(
      "INVALID_INPUT",
      `${what} is ${bytes} bytes; the limit is ${MAX_META_BYTES} bytes of JSON.`,
    );
  }
}
