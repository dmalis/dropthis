/**
 * `publish` — the write order, exactly as AGENTS.md states it.
 *
 *   0  resolve content, write every blob under `drops/<id>/blobs/<sha256>`
 *   1  put the idempotency claim, which FIXES the identity of this call
 *   2  claim `slugs/<slug>` with If-None-Match: *
 *   4  create `meta.json` with If-None-Match: *  — the drop becomes real here
 *   5  write the `list/` and `expiring/` projections
 *   6  put the idempotency result, encrypted
 *   7  (nothing to delete on a create)
 *
 * The order is the whole design. Blobs are unreachable until a manifest names
 * them, the slug is claimed before `meta.json` exists so a collision is found
 * before any other write, and `meta.json` is the single instant at which the
 * drop starts being served. A crash anywhere leaves either nothing served or a
 * complete drop — never half of one.
 *
 * The claim is read BEFORE step 0 when the caller sent an `idempotency_key`,
 * because blob keys contain the drop id: a retry has to write its blobs under
 * the id the first attempt chose, not a fresh one.
 */
import type { Bucket } from "../bindings.js";
import type { CreatedBy, Drop, DropMeta, Manifest } from "../domain/meta.js";
import { canonicalJson, newDropMeta, sha256Hex, stateHash, toDrop } from "../domain/meta.js";
import { expiringMarkerDate, ExpiryError, resolveExpiry } from "../domain/expiry.js";
import { generateSlug } from "../domain/slug.js";
import { ApiError } from "../errors.js";
import type { InstanceConfig, ResolvedPolicy } from "../instance-config.js";
import type { PublishInput } from "../registry/publish.js";
import {
  blobKey,
  expiringKey,
  idempotencyHash,
  listKey,
  metaKey,
  newDropId,
  requestClaimKey,
  requestResultKey,
  slugKey,
} from "../storage/keys.js";
import { claimKey, createPut, putBlob } from "../storage/r2.js";
import { decryptResult, encryptResult } from "../storage/result-crypto.js";
import { resolveInlineFiles } from "./resolve-content.js";

/**
 * Where a dev build may abort, to prove a retry converges. Gated on
 * `DEV_ROUTES=1` exactly like the `/_dev` probes, but chosen per request
 * (header `DEV-Fault`) so one deployment covers every step.
 */
export const FAULT_POINTS = ["blobs", "claim", "slug", "meta", "projections"] as const;
export type FaultPoint = (typeof FAULT_POINTS)[number];

export function parseFaultPoint(value: string | undefined | null): FaultPoint | undefined {
  return FAULT_POINTS.find((point) => point === value);
}

export type PublishContext = {
  bucket: Bucket;
  config: InstanceConfig;
  caller: CreatedBy;
  now: Date;
  /** `HMAC_SECRET`; the idempotency result is sealed with a key derived from it. */
  secret: string;
  fault?: FaultPoint | undefined;
};

/** The identity a call commits to before it writes anything reachable. */
type Identity = { dropId: string; slug: string; slugClaimedHere: boolean };

type ClaimRecord = {
  payload_hash: string;
  drop_id: string;
  slug: string;
  gen: string;
  manifest: Manifest;
  state_hash: string;
  created: string;
  /**
   * The RESOLVED expiry, not the caller's spelling. "30d" means a different
   * instant on every attempt, so re-resolving it on a retry would produce a
   * different desired state and turn a converging retry into UPDATE_CONFLICT.
   * The claim fixes every clock-derived value, not just the id and the slug.
   */
  expires_at: string | null;
};

export type PublishResult = { drop: Drop; created: boolean };

export async function publish(input: PublishInput, ctx: PublishContext): Promise<PublishResult> {
  const { bucket, config, now } = ctx;

  const payloadHash = await hashPayload(input);
  const hash =
    input.idempotency_key === undefined
      ? undefined
      : await idempotencyHash(ctx.caller.id, input.idempotency_key);

  // The claim is read before anything else, including decoding the payload: a
  // replay costs one GET, and the claim owns the drop id that every blob key
  // contains.
  let claim = hash === undefined ? null : await readClaim(bucket, hash);
  if (claim !== null) {
    if (claim.payload_hash !== payloadHash) {
      throw new ApiError(
        "IDEMPOTENCY_MISMATCH",
        "This idempotency_key was used for a different payload.",
      );
    }
    const replayed = await readResult(bucket, hash!, ctx.secret);
    if (replayed !== null) return { drop: replayed, created: false };
  }

  const noindex = config.policy.noindex.forced
    ? config.policy.noindex.default
    : (input.noindex ?? config.policy.noindex.default);

  const content = await resolveInlineFiles(input.files);

  let identity: Identity =
    claim === null
      ? { dropId: newDropId(now), slug: generateSlug(), slugClaimedHere: false }
      : { dropId: claim.drop_id, slug: claim.slug, slugClaimedHere: false };
  // A retry keeps the first attempt's clock-derived values. `created` is part
  // of the state hash and of the `list/` key, and "30d" resolved a second later
  // is a different instant — either would fork the identity the claim fixed.
  let created = claim?.created ?? `${now.toISOString().slice(0, 19)}Z`;
  let expiresAt =
    claim === null
      ? resolveExpiryOrFail(input.expires ?? config.policy.expiry.default, config.policy, now)
      : claim.expires_at;

  const buildMeta = (slug: string) =>
    newDropMeta({
      id: identity.dropId,
      slug,
      title: input.title ?? null,
      meta: input.meta ?? {},
      manifest: content.manifest,
      expiresAt,
      noindex,
      createdBy: ctx.caller,
      now,
      created,
    });

  // (0) blobs — unreachable until `meta.json` names them.
  await writeBlobs(bucket, identity.dropId, content.blobs);
  fault(ctx, "blobs");

  // (1) the claim fixes the identity for every retry.
  if (hash !== undefined && claim === null) {
    const desired = await buildMeta(identity.slug);
    const record: ClaimRecord = {
      payload_hash: payloadHash,
      drop_id: identity.dropId,
      slug: identity.slug,
      gen: desired.current_gen,
      manifest: content.manifest,
      state_hash: await stateHash(desired),
      created: desired.created,
      expires_at: desired.expires_at,
    };
    const claimed = await claimKey(bucket, requestClaimKey(hash), JSON.stringify(record));
    if (!claimed.claimed) {
      // A concurrent retry won the claim. Adopt its identity; the blobs written
      // under ours are unreferenced and the reconcile removes them.
      claim = await readClaim(bucket, hash);
      if (claim === null) throw new ApiError("INTERNAL", "The idempotency claim vanished mid-write.");
      if (claim.payload_hash !== payloadHash) {
        throw new ApiError(
          "IDEMPOTENCY_MISMATCH",
          "This idempotency_key was used for a different payload.",
        );
      }
      const replayed = await readResult(bucket, hash, ctx.secret);
      if (replayed !== null) return { drop: replayed, created: false };
      identity = { dropId: claim.drop_id, slug: claim.slug, slugClaimedHere: false };
      created = claim.created;
      expiresAt = claim.expires_at;
      await writeBlobs(bucket, identity.dropId, content.blobs);
    } else {
      claim = record;
    }
  }
  fault(ctx, "claim");

  // (2) the slug: claimed before `meta.json` exists, so a collision costs one write.
  identity = await claimSlug(bucket, identity, claim !== null);
  fault(ctx, "slug");

  // (4) `meta.json` — the drop becomes real, and served, here.
  const stored = await commitMeta(bucket, identity, await buildMeta(identity.slug));
  fault(ctx, "meta");

  // (5) projections — repairable, so they follow the truth rather than gate it.
  await writeProjections(bucket, stored);
  fault(ctx, "projections");

  const drop = toDrop(stored, { canonicalUrl: config.canonicalUrl, now });

  // (6) the result, sealed, so a lost response is recoverable exactly once.
  if (hash !== undefined) {
    await bucket.put(
      requestResultKey(hash),
      await encryptResult(ctx.secret, JSON.stringify(drop)),
      { onlyIf: { etagDoesNotMatch: "*" } },
    );
  }

  return { drop, created: true };
}

function resolveExpiryOrFail(value: string, policy: ResolvedPolicy, now: Date): string | null {
  try {
    return resolveExpiry(value, { max: policy.expiry.max, allowNever: policy.expiry.allow_never }, now);
  } catch (error) {
    if (error instanceof ExpiryError) throw new ApiError(error.code, error.message);
    throw error;
  }
}

/**
 * The payload's identity for idempotency. It is the canonical JSON of the
 * request as parsed — so a reordered but otherwise identical body is the same
 * call, and any change of content, title or setting is not.
 */
function hashPayload(input: PublishInput): Promise<string> {
  return sha256Hex(canonicalJson(input));
}

async function readClaim(bucket: Bucket, hash: string): Promise<ClaimRecord | null> {
  const object = await bucket.get(requestClaimKey(hash));
  if (object === null) return null;
  try {
    return JSON.parse(await object.text()) as ClaimRecord;
  } catch {
    return null;
  }
}

async function readResult(bucket: Bucket, hash: string, secret: string): Promise<Drop | null> {
  const object = await bucket.get(requestResultKey(hash));
  if (object === null) return null;
  return JSON.parse(await decryptResult(secret, await object.text())) as Drop;
}

async function writeBlobs(
  bucket: Bucket,
  dropId: string,
  blobs: Map<string, Uint8Array<ArrayBuffer>>,
): Promise<void> {
  for (const [digest, bytes] of blobs) {
    await putBlob(bucket, blobKey(dropId, digest), bytes, digest);
  }
}

/**
 * Claim `slugs/<slug>`. A pointer already holding this drop id counts as
 * claimed — that is what makes a retry idempotent. A pointer holding another
 * id is a real collision: generate a new slug, unless the idempotency claim
 * already fixed one, in which case there is nothing safe left to do.
 */
async function claimSlug(bucket: Bucket, identity: Identity, slugIsFixed: boolean): Promise<Identity> {
  let slug = identity.slug;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const claimed = await claimKey(bucket, slugKey(slug), identity.dropId);
    if (claimed.claimed) return { ...identity, slug, slugClaimedHere: true };

    const existing = await bucket.get(slugKey(slug));
    if (existing !== null && (await existing.text()) === identity.dropId) {
      return { ...identity, slug, slugClaimedHere: false };
    }
    if (slugIsFixed) {
      throw new ApiError("INTERNAL", `The slug ${slug} of this idempotent retry belongs to another drop.`);
    }
    slug = generateSlug();
  }
  throw new ApiError("INTERNAL", "Could not find a free slug in five attempts.");
}

/**
 * Create `meta.json`. A conflict means someone else got there first: if what
 * they stored is the state this call wanted, this call is simply done (its own
 * retry, converging); otherwise it is a real conflict and a slug this call
 * claimed is released.
 */
async function commitMeta(bucket: Bucket, identity: Identity, meta: DropMeta): Promise<DropMeta> {
  const written = await createPut(bucket, metaKey(identity.dropId), JSON.stringify(meta), {
    httpMetadata: { contentType: "application/json" },
  });
  if (written.ok) return meta;

  const existing = await bucket.get(metaKey(identity.dropId));
  if (existing !== null) {
    const stored = JSON.parse(await existing.text()) as DropMeta;
    if ((await stateHash(stored)) === (await stateHash(meta))) return stored;
  }
  if (identity.slugClaimedHere) await bucket.delete(slugKey(identity.slug));
  throw new ApiError("UPDATE_CONFLICT", "Another write reached this drop first.");
}

/**
 * `list/` and `expiring/` are projections of `meta.json`, never truth. Both are
 * repaired on read and by the reconcile, so a failure here loses a listing row
 * for a while — it never loses a drop.
 */
async function writeProjections(bucket: Bucket, meta: DropMeta): Promise<void> {
  const customMetadata: Record<string, string> = {
    id: meta.id,
    updated: meta.updated,
    created_by_id: meta.created_by.id,
    created_by_label: meta.created_by.label,
  };
  if (meta.expires_at !== null) customMetadata.expires_at = meta.expires_at;
  if (meta.title !== null) customMetadata.title = meta.title;

  await bucket.put(listKey(Date.parse(meta.created), meta.slug), "", { customMetadata });

  if (meta.expires_at !== null) {
    await bucket.put(expiringKey(expiringMarkerDate(meta.expires_at), meta.id), "");
  }
}

function fault(ctx: PublishContext, point: FaultPoint): void {
  if (ctx.fault === point) {
    throw new Error(`DEV_FAULT: aborted after ${point}.`);
  }
}
