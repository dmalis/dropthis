/**
 * The idempotency claim — the record that makes a retry converge instead of
 * racing (AGENTS.md, "Idempotency is explicit"; Stripe's pattern).
 *
 * Two keys, each written exactly once. The CLAIM is put before any side effect
 * and fixes the identity of the call; the RESULT is put at the end, sealed, so
 * a lost response is recoverable exactly once. Both live under
 * `requests/<hash>/`, and the hash is over the caller AND their key, so two
 * agents that both send `idempotency_key: "report"` do not collide.
 *
 * `expires_at` and `created` are in the claim for the reason decision #74
 * records: anything the first attempt read from the clock belongs to the claim.
 * `"30d"` resolved a second later is a different instant, so a retry that
 * re-resolved it would build a different desired state and turn a converging
 * retry into `409 UPDATE_CONFLICT`.
 */
import type { Bucket } from "../bindings.js";
import type { Drop, Manifest } from "../domain/meta.js";
import { ApiError } from "../errors.js";
import { requestClaimKey, requestResultKey } from "../storage/keys.js";
import { claimKey } from "../storage/r2.js";
import { decryptResult, encryptResult } from "../storage/result-crypto.js";

export type ClaimRecord = {
  payload_hash: string;
  drop_id: string;
  slug: string;
  gen: string;
  manifest: Manifest;
  state_hash: string;
  created: string;
  /** The RESOLVED expiry, never the caller's spelling. See decision #74. */
  expires_at: string | null;
  /**
   * The stored `access` this call decided on — salt, hash and nonce included.
   * A generated password is random, so a retry that re-derived one would write
   * a different `meta.json` and conflict with the attempt it is retrying.
   */
  access: Record<string, unknown>;
  /**
   * The password itself, AES-GCM sealed, so the ONE response that carries it
   * can be rebuilt by a retry that finds the claim but no stored result. It is
   * a live secret, and the bucket is not the place to keep one in clear.
   */
  password_enc?: string;
};

/** The claim's sealed password, for a retry that has to rebuild the response. */
export async function openPassword(claim: ClaimRecord, secret: string): Promise<string | undefined> {
  if (claim.password_enc === undefined) return undefined;
  return decryptResult(secret, claim.password_enc);
}

/** The `password_enc` half of a claim, or nothing when the call set no password. */
export async function sealPassword(
  secret: string,
  password: string | undefined,
): Promise<{ password_enc?: string }> {
  return password === undefined ? {} : { password_enc: await encryptResult(secret, password) };
}

export async function readClaim(bucket: Bucket, hash: string): Promise<ClaimRecord | null> {
  const object = await bucket.get(requestClaimKey(hash));
  if (object === null) return null;
  try {
    return JSON.parse(await object.text()) as ClaimRecord;
  } catch {
    return null;
  }
}

export async function readResult(
  bucket: Bucket,
  hash: string,
  secret: string,
): Promise<Drop | null> {
  const object = await bucket.get(requestResultKey(hash));
  if (object === null) return null;
  return JSON.parse(await decryptResult(secret, await object.text())) as Drop;
}

export async function putResult(
  bucket: Bucket,
  hash: string,
  secret: string,
  drop: Drop,
): Promise<void> {
  await bucket.put(requestResultKey(hash), await encryptResult(secret, JSON.stringify(drop)), {
    onlyIf: { etagDoesNotMatch: "*" },
  });
}

export function putClaim(bucket: Bucket, hash: string, record: ClaimRecord) {
  return claimKey(bucket, requestClaimKey(hash), JSON.stringify(record));
}

/** A claim written for a different body under the same key is a caller error. */
export function requireSamePayload(claim: ClaimRecord, payloadHash: string): void {
  if (claim.payload_hash !== payloadHash) {
    throw new ApiError(
      "IDEMPOTENCY_MISMATCH",
      "This idempotency_key was used for a different payload.",
    );
  }
}
