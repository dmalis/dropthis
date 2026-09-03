/**
 * `user add` — mint a key, name a person, hand back everything needed to
 * onboard them (AGENTS.md, "Team model"; docs/spec-v1.md, story 50).
 *
 * Write order, and why it is this one:
 *
 *   1  `keys/<id>.json`     the record. Unreachable until a pointer names it,
 *                           so writing it first costs nothing if we stop here.
 *   2  `keyhash/<hash>`     the auth lookup. The key becomes usable HERE.
 *   3  `users/<label>`      the uniqueness claim, with `If-None-Match: *`.
 *                           A lost claim is the honest answer to "two agents
 *                           added Anna at once": one wins, the loser undoes
 *                           its two writes and reports `LABEL_TAKEN`.
 *
 * The claim is last because it is the only step that can fail on a race, and
 * undoing two writes is cheaper than repairing a claim whose key never
 * existed. A crash between 1 and 3 leaves an orphan record and pointer under
 * an id nothing names; with an `idempotency_key` the rerun adopts them exactly,
 * and without one the reconcile removes them.
 *
 * Idempotency follows `publish`: the claim is written BEFORE any side effect
 * and fixes the identity — the key id, the label and the generated key itself,
 * sealed, because the key must come back once and only to the same call.
 */
import { normalizeLabel, LabelError } from "../domain/label.js";
import { canonicalJson, sha256Hex } from "../domain/meta.js";
import { ApiError } from "../errors.js";
import { hashKey, mintKey } from "../auth/key.js";
import type { KeyRecord } from "../auth/key.js";
import type { Bucket } from "../bindings.js";
import { connectFor, onboardingMessage } from "../registry/connect.js";
import type { Connect } from "../registry/connect.js";
import type { InstanceConfig } from "../instance-config.js";
import {
  idempotencyHash,
  keyHashKey,
  keyRecordKey,
  newKeyId,
  requestClaimKey,
  requestResultKey,
  userKey,
} from "../storage/keys.js";
import { claimKey } from "../storage/r2.js";
import { decryptResult, encryptResult } from "../storage/result-crypto.js";

/** Where a dev build may abort `user add`, to prove a rerun converges. */
export const USER_ADD_FAULTS = ["claim", "record", "keyhash", "label", "result"] as const;
export type UserAddFault = (typeof USER_ADD_FAULTS)[number];

export function parseUserAddFault(value: string | undefined | null): UserAddFault | undefined {
  return USER_ADD_FAULTS.includes(value as UserAddFault) ? (value as UserAddFault) : undefined;
}

export type UserAddInput = {
  label: string;
  idempotency_key?: string | undefined;
};

export type UserAddContext = {
  bucket: Bucket;
  config: InstanceConfig;
  /** The admin whose `idempotency_key` namespace this call lives in. */
  callerId: string;
  now: Date;
  secret: string;
  fault?: UserAddFault | undefined;
};

export type AddedUser = {
  user: { id: string; label: string; scope: "user"; created: string };
  key: string;
  connect: Connect;
  message: string;
};

/** The identity an `idempotency_key` fixes before anything is written. */
type AddClaim = {
  payload_hash: string;
  key_id: string;
  label: string;
  created: string;
  /** The generated key, sealed: a live credential must not sit in the bucket. */
  key: string;
};

export async function addUser(input: UserAddInput, ctx: UserAddContext): Promise<AddedUser> {
  const label = normalize(input.label);
  const { bucket, secret } = ctx;

  const hash =
    input.idempotency_key === undefined
      ? undefined
      : await idempotencyHash(ctx.callerId, input.idempotency_key);
  const payloadHash = await sha256Hex(canonicalJson({ label }));

  // The claim is read BEFORE the result, and the payload compared first: a
  // second label sent under a key that already named someone is a mismatch,
  // not a replay. A result can only exist where a claim does, so this costs
  // one extra read on a replay and nothing at all on a first call.
  let claim = hash === undefined ? null : await readClaim(bucket, hash, secret);
  if (claim !== null) {
    mismatchUnless(claim, payloadHash);
    // A finished call answers from the sealed result: the key comes back once
    // more, to this retry and to nobody else.
    const done = await readResult(bucket, hash!, secret);
    if (done !== null) return render(done, ctx);
  }

  if (hash !== undefined && claim === null) {
    const record: AddClaim = {
      payload_hash: payloadHash,
      key_id: newKeyId(ctx.now),
      label,
      created: `${ctx.now.toISOString().slice(0, 19)}Z`,
      key: await encryptResult(secret, mintKey()),
    };
    const claimed = await claimKey(bucket, requestClaimKey(hash), JSON.stringify(record));
    if (!claimed.claimed) {
      // A concurrent retry won it. Adopt its identity rather than mint a
      // second key for one person.
      claim = await readClaim(bucket, hash, secret);
      if (claim === null) throw new ApiError("INTERNAL", "The idempotency claim vanished mid-write.");
      mismatchUnless(claim, payloadHash);
    } else {
      claim = record;
    }
  }
  abortAt(ctx, "claim");

  const id = claim?.key_id ?? newKeyId(ctx.now);
  const created = claim?.created ?? `${ctx.now.toISOString().slice(0, 19)}Z`;
  const key = claim === null ? mintKey() : await decryptResult(secret, claim.key);
  const keyHash = await hashKey(key);

  const record: KeyRecord = { id, label, scope: "user", hash: keyHash, created };

  // (1) the record.
  await bucket.put(keyRecordKey(id), JSON.stringify(record));
  abortAt(ctx, "record");

  // (2) the pointer: the key works from here on.
  await bucket.put(keyHashKey(keyHash), JSON.stringify({ id }));
  abortAt(ctx, "keyhash");

  // (3) the claim that makes the label mean one person.
  const claimed = await claimKey(bucket, userKey(label), JSON.stringify({ id }));
  if (!claimed.claimed && !(await ownsLabel(bucket, label, id))) {
    // Undo, in the reverse order: the pointer first, so the key stops working
    // before its record disappears.
    await bucket.delete(keyHashKey(keyHash));
    await bucket.delete(keyRecordKey(id));
    throw new ApiError("LABEL_TAKEN", `The label ${label} is already in use on this instance.`);
  }
  abortAt(ctx, "label");

  const result: AddedUser = render({ record, key }, ctx);

  if (hash !== undefined) {
    await bucket.put(
      requestResultKey(hash),
      await encryptResult(secret, JSON.stringify({ record, key })),
      { onlyIf: { etagDoesNotMatch: "*" } },
    );
  }
  abortAt(ctx, "result");

  return result;
}

/** The label already claimed by THIS key id — a rerun, not a collision. */
async function ownsLabel(bucket: Bucket, label: string, id: string): Promise<boolean> {
  const object = await bucket.get(userKey(label));
  if (object === null) return false;
  try {
    return (JSON.parse(await object.text()) as { id?: unknown }).id === id;
  } catch {
    return false;
  }
}

function normalize(raw: unknown): string {
  if (typeof raw !== "string") throw new ApiError("INVALID_INPUT", "label must be a string.");
  try {
    return normalizeLabel(raw);
  } catch (error) {
    if (error instanceof LabelError) throw new ApiError("INVALID_INPUT", error.message);
    throw error;
  }
}

function mismatchUnless(claim: AddClaim, payloadHash: string): void {
  if (claim.payload_hash !== payloadHash) {
    throw new ApiError(
      "IDEMPOTENCY_MISMATCH",
      "This idempotency_key was used to add a different label.",
    );
  }
}

type Stored = { record: KeyRecord; key: string };

function render(stored: Stored, ctx: UserAddContext): AddedUser {
  const connect = connectFor({
    canonicalUrl: ctx.config.canonicalUrl,
    instanceName: ctx.config.instanceName,
  });
  return {
    user: {
      id: stored.record.id,
      label: stored.record.label,
      scope: "user",
      created: stored.record.created,
    },
    key: stored.key,
    connect,
    message: onboardingMessage(connect, stored.record.label),
  };
}

async function readClaim(bucket: Bucket, hash: string, secret: string): Promise<AddClaim | null> {
  const object = await bucket.get(requestClaimKey(hash));
  if (object === null) return null;
  try {
    return JSON.parse(await object.text()) as AddClaim;
  } catch {
    return null;
  }
}

async function readResult(bucket: Bucket, hash: string, secret: string): Promise<Stored | null> {
  const object = await bucket.get(requestResultKey(hash));
  if (object === null) return null;
  return JSON.parse(await decryptResult(secret, await object.text())) as Stored;
}

function abortAt(ctx: UserAddContext, point: UserAddFault): void {
  if (ctx.fault === point) {
    throw new ApiError("INTERNAL", `Dev fault injected after ${point}.`);
  }
}
