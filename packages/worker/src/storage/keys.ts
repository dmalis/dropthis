/**
 * Every bucket key dropthis writes, computed in one place (AGENTS.md, "Key
 * layout"). The layout is frozen: these strings are the schema, and renaming
 * one would strand every drop already published.
 *
 * "Files are the database" only works if every hot read is a key we can compute
 * from what the request already carries — which is why nothing here needs a
 * `list()`.
 */
import { sha256Hex } from "../domain/meta.js";

export const metaKey = (dropId: string) => `drops/${dropId}/meta.json`;
export const blobKey = (dropId: string, sha256: string) => `drops/${dropId}/blobs/${sha256}`;
export const slugKey = (slug: string) => `slugs/${slug}`;
export const expiringKey = (date: string, dropId: string) => `expiring/${date}/${dropId}`;
export const requestClaimKey = (hash: string) => `requests/${hash}/claim`;
export const requestResultKey = (hash: string) => `requests/${hash}/result`;

/**
 * The staged-upload session: three write-once keys under one prefix, so the
 * bucket's 1-day lifecycle rule on `uploads/` removes an abandoned session
 * whole. The blobs themselves are never here — a staged PUT writes straight to
 * `drops/<id>/blobs/<sha256>`, so commit copies nothing.
 */
export const uploadSessionKey = (uploadId: string) => `uploads/${uploadId}/session.json`;
export const uploadCommitKey = (uploadId: string) => `uploads/${uploadId}/commit`;
export const uploadResultKey = (uploadId: string) => `uploads/${uploadId}/result`;

/**
 * The three records a credential is made of. `keyhash/` is the AUTH lookup —
 * one computed GET per request — and `users/` is the uniqueness claim that
 * makes a label mean one person. Deleting `keyhash/` first is what makes
 * `user remove` end access in its first step.
 */
export const keyRecordKey = (id: string) => `keys/${id}.json`;
export const keyHashKey = (hash: string) => `keyhash/${hash}`;
export const userKey = (label: string) => `users/${label}`;

/** The prefixes the two deliberate `list()` scans walk. */
export const KEYS_PREFIX = "keys/";
export const DROPS_PREFIX = "drops/";
export const UPLOADS_PREFIX = "uploads/";

export const CONFIG_KEY = "system/config.json";
/** The cron's cursors. One key, written once per invocation, at the end. */
export const PRUNE_STATE_KEY = "system/prune-state.json";

/** The prefixes the cron walks. */
export const EXPIRING_PREFIX = "expiring/";
export const SLUGS_PREFIX = "slugs/";

/**
 * The listing pointer. R2 lists keys in lexicographic order and `list` must be
 * newest-first, so the creation time is INVERTED and zero-padded: a newer drop
 * gets a smaller number and therefore an earlier key. One `list()` over this
 * prefix is a page of results with a cursor, and no index file is maintained.
 */
/** The prefix `list` walks; the only prefix scan in the product's hot path. */
export const LIST_PREFIX = "list/";

const LIST_KEY_SPAN = 10 ** 13 - 1;

export function listKey(createdMs: number, slug: string): string {
  const inverted = Math.max(0, LIST_KEY_SPAN - Math.trunc(createdMs));
  return `${LIST_PREFIX}${String(inverted).padStart(13, "0")}-${slug}`;
}

/**
 * The listing key of a drop, from the two values that never change about it.
 *
 * The time comes from the drop ID, not from `created`. `created` is RFC 3339 at
 * SECOND precision — a frozen response field, and not one to widen — so drops
 * published inside one second would all share a key prefix and fall back to
 * sorting by their random slug. An agent publishing a batch does exactly that,
 * and "newest first" would quietly stop being true. The id is a ULID and
 * carries the millisecond; an idempotent retry reuses the id its claim fixed,
 * so the key is stable across retries too.
 */
export function listKeyForDrop(dropId: string, slug: string): string {
  return listKey(dropIdTimeMs(dropId), slug);
}

/**
 * The idempotency record's name. It is keyed on the CALLER plus their key, so
 * two people who both send `idempotency_key: "report"` do not collide — and one
 * caller cannot probe another's stored result.
 */
export function idempotencyHash(callerId: string, idempotencyKey: string): Promise<string> {
  return sha256Hex(`${callerId}\u0000${idempotencyKey}`);
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A drop id: a ULID — 48 bits of millisecond timestamp then 80 bits of
 * randomness, in Crockford base32. Time-sortable, so a `list()` over `drops/`
 * (the reconcile's only scan) walks oldest first and its cursor means something.
 */
export function newDropId(now: Date = new Date()): string {
  return newUlid(now);
}

/**
 * A key id. The same ULID as a drop id: `user list` reads `keys/` with one
 * `list()`, and a sortable id makes that page oldest-first without a sort.
 */
export function newKeyId(now: Date = new Date()): string {
  return newUlid(now);
}

/** An upload session id without an idempotency key: a fresh ULID. */
export function newUploadId(now: Date = new Date()): string {
  return newUlid(now);
}

function newUlid(now: Date): string {
  let id = "";
  let time = now.getTime();
  for (let i = 9; i >= 0; i -= 1) {
    id = CROCKFORD[time % 32] + id;
    time = Math.floor(time / 32);
  }
  const random = crypto.getRandomValues(new Uint8Array(16));
  for (let i = 0; i < 16; i += 1) id += CROCKFORD[random[i]! % 32];
  return id;
}

/** The millisecond a ULID drop id was minted at: its first 10 characters. */
export function dropIdTimeMs(dropId: string): number {
  let time = 0;
  for (const character of dropId.slice(0, 10)) {
    time = time * 32 + CROCKFORD.indexOf(character);
  }
  return time;
}
