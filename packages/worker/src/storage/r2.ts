/**
 * The storage seam: every conditional write dropthis relies on, in one place.
 *
 * The R2 binding is the storage API (AGENTS.md, "Stack") — there is no ORM and
 * no wrapper object. These are pure functions over the binding that map its two
 * ways of saying "no" onto the frozen error catalogue:
 *
 *   - a failed precondition, which the binding reports by resolving `put` to
 *     `null`, becomes a `{claimed:false}` / `{ok:false, conflict:true}` result
 *     the caller must branch on;
 *   - a thrown error, which becomes a typed `StorageError` carrying an error
 *     code. The per-key write-rate limit is `R2_RATE_LIMIT` and is NEVER
 *     retried in the Worker: the caller is told to wait `Retry-After` seconds.
 *
 * The types below are the exact subset of the binding these functions use.
 * Declaring the subset here keeps the Worker on Node's type set and makes the
 * seam readable: this is everything dropthis asks of R2.
 */

import type { ErrorCode } from "../errors.js";

export type R2WriteOptions = {
  onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string };
  sha256?: string;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
};

export type R2WriteResult = { etag: string; size?: number };

export type R2BucketLike = {
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string | ReadableStream | null,
    options?: R2WriteOptions,
  ): Promise<R2WriteResult | null>;
};

export type R2Body = ArrayBuffer | ArrayBufferView | string | ReadableStream;

/** An R2 failure already mapped to the catalogue code the caller must send. */
export class StorageError extends Error {
  readonly code: ErrorCode;
  readonly retryAfterSeconds: number | undefined;

  constructor(code: ErrorCode, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "StorageError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export type ClaimResult = { claimed: true; etag: string } | { claimed: false };

/**
 * Claim a key that must not exist yet: `slugs/<slug>`, `users/<label>`,
 * `requests/<hash>/claim`, `uploads/<id>/commit`. The claim is the atom the
 * whole write order is built on, so a lost race is a normal result, not an
 * error.
 */
export async function claimKey(
  bucket: R2BucketLike,
  key: string,
  body: R2Body,
): Promise<ClaimResult> {
  const written = await write(bucket, key, body, { onlyIf: { etagDoesNotMatch: "*" } });
  return written === null ? { claimed: false } : { claimed: true, etag: written.etag };
}

export type WriteResult = { ok: true; etag: string } | { ok: false; conflict: true };

/**
 * Create an object that must not exist yet — `meta.json` on a fresh publish.
 * A conflict means another writer created it first, which the write order turns
 * into `UPDATE_CONFLICT` (or, for an idempotent retry, into "already done").
 */
export async function createPut(
  bucket: R2BucketLike,
  key: string,
  body: R2Body,
  options: Omit<R2WriteOptions, "onlyIf"> = {},
): Promise<WriteResult> {
  const written = await write(bucket, key, body, {
    ...options,
    onlyIf: { etagDoesNotMatch: "*" },
  });
  return written === null ? { ok: false, conflict: true } : { ok: true, etag: written.etag };
}

/**
 * Compare-and-swap the object at `key` against the etag the caller read. This
 * is the generation flip: `meta.json` is the only truth, and a lost CAS is
 * `UPDATE_CONFLICT`, never a blind overwrite.
 */
export async function casPut(
  bucket: R2BucketLike,
  key: string,
  body: R2Body,
  etag: string,
  options: Omit<R2WriteOptions, "onlyIf"> = {},
): Promise<WriteResult> {
  const written = await write(bucket, key, body, { ...options, onlyIf: { etagMatches: etag } });
  return written === null ? { ok: false, conflict: true } : { ok: true, etag: written.etag };
}

/**
 * Write a file body with its digest, so R2 verifies the bytes and the Worker
 * never has to hash a streamed body itself. A digest R2 rejects is the caller's
 * mistake: `HASH_MISMATCH`, and the key stays absent.
 */
export async function putBlob(
  bucket: R2BucketLike,
  key: string,
  body: R2Body,
  sha256Hex: string,
): Promise<R2WriteResult> {
  const written = await write(bucket, key, body, { sha256: sha256Hex });
  if (written === null) {
    throw new StorageError("INTERNAL", `Blob write to ${key} was refused without a precondition.`);
  }
  return written;
}

async function write(
  bucket: R2BucketLike,
  key: string,
  body: R2Body,
  options: R2WriteOptions,
): Promise<R2WriteResult | null> {
  try {
    return await bucket.put(key, body, options);
  } catch (error) {
    throw mapStorageError(error, key);
  }
}

/**
 * R2's thrown failures, mapped to the catalogue.
 *
 * The refusal remote R2 actually sends when several writes to one key are in
 * flight is `put: Reduce your concurrent request rate for the same object.
 * (10058)` — measured against the deployed dev Worker, transcript in
 * docs/research/2026-09-03-free-plan-measurements.md. `10029` is the rate-limit
 * code of the same family. The match stays broad on purpose: the wording is
 * Cloudflare's to change, and reporting a throttle as `INTERNAL` would tell an
 * agent not to retry something that only needed a second.
 */
export function mapStorageError(error: unknown, key: string): StorageError {
  if (error instanceof StorageError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (
    lower.includes("10029") ||
    lower.includes("10058") ||
    lower.includes("concurrent request rate") ||
    lower.includes("same object") ||
    lower.includes("429") ||
    lower.includes("too many requests") ||
    lower.includes("rate at which") ||
    lower.includes("rate limit") ||
    lower.includes("throttl")
  ) {
    return new StorageError("R2_RATE_LIMIT", `Too many writes to ${key}.`, 1);
  }
  if (lower.includes("sha-256") || lower.includes("sha256") || lower.includes("checksum")) {
    return new StorageError("HASH_MISMATCH", `The bytes written to ${key} did not match sha256.`);
  }
  return new StorageError("INTERNAL", `R2 write to ${key} failed: ${message}`);
}
