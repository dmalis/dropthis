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
import { ExpiryError, resolveExpiry } from "../domain/expiry.js";
import { resolvePassword } from "../domain/password.js";
import { generateSlug } from "../domain/slug.js";
import { ApiError } from "../errors.js";
import type { InstanceConfig, ResolvedPolicy } from "../instance-config.js";
import type { PublishInput } from "../registry/publish.js";
import { blobKey, idempotencyHash, metaKey, newDropId, slugKey } from "../storage/keys.js";
import { claimKey, createPut, putBlob } from "../storage/r2.js";
import type { ClaimRecord } from "./idempotency.js";
import {
  openPassword,
  putClaim,
  putResult,
  readClaim,
  readResult,
  requireSamePayload,
  sealPassword,
} from "./idempotency.js";
import { writeProjections } from "./projections.js";
import { resolveFiles } from "./resolve-content.js";
import { newFetchBudget } from "./fetch-url.js";

/**
 * Where a dev build may abort, to prove a retry converges. Gated on
 * `DEV_ROUTES=1` exactly like the `/_dev` probes, but chosen per request
 * (header `DEV-Fault`) so one deployment covers every step.
 */
export const FAULT_POINTS = [
  "blobs",
  "claim",
  "slug",
  "meta",
  "projections",
  "cleanup",
] as const;
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
type Identity = {
  dropId: string;
  slug: string;
  slugClaimedHere: boolean;
  /** The caller chose this slug, so a collision is theirs to fix (#94). */
  slugChosen: boolean;
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
    requireSamePayload(claim, payloadHash);
    const replayed = await readResult(bucket, hash!, ctx.secret);
    if (replayed !== null) return { drop: replayed, created: false };
  }

  const noindex = config.policy.noindex.forced
    ? config.policy.noindex.default
    : (input.noindex ?? config.policy.noindex.default);

  const slugChosen = input.slug !== undefined;
  let identity: Identity =
    claim === null
      ? {
          dropId: newDropId(now),
          slug: input.slug ?? generateSlug(),
          slugClaimedHere: false,
          slugChosen,
        }
      : { dropId: claim.drop_id, slug: claim.slug, slugClaimedHere: false, slugChosen };
  // A retry keeps the first attempt's clock-derived values. `created` is part
  // of the state hash and of the `list/` key, and "30d" resolved a second later
  // is a different instant — either would fork the identity the claim fixed.
  let created = claim?.created ?? `${now.toISOString().slice(0, 19)}Z`;
  let expiresAt =
    claim === null
      ? resolveExpiryOrFail(input.expires ?? config.policy.expiry.default, config.policy, now)
      : claim.expires_at;

  // (0a) content. The drop id is settled first because a `url` body streams to
  // `drops/<id>/blobs/<sha256>` as it arrives — it is never held in memory —
  // and a retry re-fetches only what its own claim's blobs are missing.
  const budget = newFetchBudget();
  const resolve = async (dropId: string, fixed: ClaimRecord | null) => {
    const held = fixed === null ? new Map<string, number>() : await heldBlobs(bucket, dropId, fixed);
    const resolved = await resolveFiles(input.files, {
      policy: config.policy,
      held,
      budget,
      streamBlob: async (digest, body) =>
        (await putBlob(bucket, blobKey(dropId, digest), body, digest)).size,
    });
    if (fixed !== null) requireSameManifest(fixed, resolved.manifest);
    return { resolved, held };
  };
  let content = await resolve(identity.dropId, claim);

  // The password is decided before any write: it goes into the desired
  // `meta.json`, and therefore into the state hash the claim fixes. A retry
  // adopts the claim's decision rather than generating a second password.
  const change = await resolvePassword(undefined, input.password, {
    iterations: config.policy.pbkdf2_iterations,
    required: config.policy.password.required,
    default: config.policy.password.default,
  });
  let access: Record<string, unknown> =
    change.kind === "set" ? { password: change.record } : {};
  let password: string | undefined = change.kind === "set" ? change.password : undefined;
  if (claim !== null) {
    access = claim.access;
    password = await openPassword(claim, ctx.secret);
  }

  const buildMeta = (slug: string) =>
    newDropMeta({
      id: identity.dropId,
      slug,
      title: input.title ?? null,
      meta: input.meta ?? {},
      manifest: content.resolved.manifest,
      expiresAt,
      noindex,
      createdBy: ctx.caller,
      access,
      now,
      created,
    });

  // (0b) the blobs the Worker holds in memory — inline entries, and a fetched
  // body it had to hash itself. Unreachable until `meta.json` names them.
  await writeBlobs(bucket, identity.dropId, content.resolved.blobs, content.held);
  fault(ctx, "blobs");

  // (1) the claim fixes the identity for every retry.
  if (hash !== undefined && claim === null) {
    const desired = await buildMeta(identity.slug);
    const record: ClaimRecord = {
      payload_hash: payloadHash,
      drop_id: identity.dropId,
      slug: identity.slug,
      gen: desired.current_gen,
      manifest: content.resolved.manifest,
      state_hash: await stateHash(desired),
      created: desired.created,
      expires_at: desired.expires_at,
      access: desired.access,
      ...(await sealPassword(ctx.secret, password)),
    };
    const claimed = await putClaim(bucket, hash, record);
    if (!claimed.claimed) {
      // A concurrent retry won the claim. Adopt its identity; the blobs written
      // under ours are unreferenced and the reconcile removes them.
      claim = await readClaim(bucket, hash);
      if (claim === null) throw new ApiError("INTERNAL", "The idempotency claim vanished mid-write.");
      requireSamePayload(claim, payloadHash);
      const replayed = await readResult(bucket, hash, ctx.secret);
      if (replayed !== null) return { drop: replayed, created: false };
      identity = { dropId: claim.drop_id, slug: claim.slug, slugClaimedHere: false, slugChosen };
      created = claim.created;
      expiresAt = claim.expires_at;
      access = claim.access;
      password = await openPassword(claim, ctx.secret);
      // The winner's drop id owns the blob keys, so the content is resolved
      // again under it — a `url` entry is fetched a second time, and its bytes
      // must still hash to what the claim fixed.
      content = await resolve(identity.dropId, claim);
      await writeBlobs(bucket, identity.dropId, content.resolved.blobs, content.held);
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
  // "Returned once" is this line: the password rides the response that set it
  // and the sealed result a retry replays, and lives nowhere else a caller can
  // reach — `get` and `list` build the same `Drop` without it.
  if (password !== undefined) drop.password = password;

  // (6) the result, sealed, so a lost response is recoverable exactly once.
  if (hash !== undefined) await putResult(bucket, hash, ctx.secret, drop);

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

async function writeBlobs(
  bucket: Bucket,
  dropId: string,
  blobs: Map<string, Uint8Array<ArrayBuffer>>,
  held: ReadonlyMap<string, number>,
): Promise<void> {
  for (const [digest, bytes] of blobs) {
    if (held.has(digest)) continue;
    await putBlob(bucket, blobKey(dropId, digest), bytes, digest);
  }
}

/**
 * The blobs a resumed attempt already stored, so a retry neither re-fetches a
 * `url` nor re-writes a body it already wrote. A digest the claim names but
 * the bucket does not hold is simply absent here, and is fetched again.
 */
async function heldBlobs(
  bucket: Bucket,
  dropId: string,
  claim: ClaimRecord,
): Promise<Map<string, number>> {
  const held = new Map<string, number>();
  for (const entry of Object.values(claim.manifest)) {
    if (held.has(entry.sha256)) continue;
    if ((await bucket.head(blobKey(dropId, entry.sha256))) !== null) {
      held.set(entry.sha256, entry.size);
    }
  }
  return held;
}

/**
 * Decision #74, applied to fetched content: the claim fixed the manifest, so a
 * retry whose `url` now answers different bytes is a different call and says
 * so, rather than storing blobs no manifest names.
 */
export function requireSameManifest(claim: ClaimRecord, manifest: Manifest): void {
  const same =
    Object.keys(claim.manifest).length === Object.keys(manifest).length &&
    Object.entries(claim.manifest).every(
      ([path, entry]) => manifest[path]?.sha256 === entry.sha256,
    );
  if (!same) {
    throw new ApiError(
      "IDEMPOTENCY_MISMATCH",
      "A url entry of this retry answers different bytes than the first attempt stored.",
    );
  }
}

/**
 * Claim `slugs/<slug>`. A pointer already holding this drop id counts as
 * claimed — that is what makes a retry idempotent. A pointer holding another
 * id is a real collision, and what happens next depends on whose slug it is:
 * a slug the CALLER chose is `SLUG_TAKEN` and theirs to fix, a generated one
 * is retried here and the caller never learns it happened — unless the
 * idempotency claim already fixed it, in which case there is nothing safe
 * left to do.
 *
 * The failing claim leaves the existing pointer exactly as it was: it is a
 * conditional write, so nothing of the losing call reaches the winner's drop.
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
    if (identity.slugChosen) {
      throw new ApiError("SLUG_TAKEN", `The slug ${slug} already belongs to another drop.`);
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

function fault(ctx: PublishContext, point: FaultPoint): void {
  if (ctx.fault === point) {
    throw new Error(`DEV_FAULT: aborted after ${point}.`);
  }
}
