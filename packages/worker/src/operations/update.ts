/**
 * `update` — the generation flip, in the write order AGENTS.md states.
 *
 *   0  resolve content, write the blobs the drop does not already hold
 *   1  put the idempotency claim, which FIXES what this call is trying to reach
 *   4  compare-and-swap `meta.json` against the etag it was read at
 *   5  rewrite the `list/` entry and MOVE the `expiring/` marker
 *   6  put the idempotency result, encrypted
 *   7  delete the blobs the new manifest no longer names, one batched delete
 *
 * There is no step (2): the slug already exists and already holds this drop id.
 *
 * The CAS is the whole atomicity story. `meta.json` is the only truth, so a
 * visitor sees the old generation until it lands and the new one after — never
 * half of each. A lost CAS is `409 UPDATE_CONFLICT`, retryable, EXCEPT when the
 * record that beat us is byte-for-byte the state this call wanted: that is our
 * own retry arriving twice, and it is success.
 *
 * The equality that decides all of this is `state_hash` — the canonical JSON of
 * the whole desired `meta.json` minus `updated`. `current_gen` alone proves
 * nothing: the same files with a different title are a different state.
 */
import type { Bucket } from "../bindings.js";
import { canonicalJson, mergeAgentMeta, sha256Hex, stateHash, toDrop } from "../domain/meta.js";
import type { CreatedBy, Drop, DropMeta, Manifest } from "../domain/meta.js";
import { dropState, ExpiryError, resolveExpiry } from "../domain/expiry.js";
import { ApiError } from "../errors.js";
import type { InstanceConfig, ResolvedPolicy } from "../instance-config.js";
import { checkMetaSize } from "../registry/fields.js";
import type { UpdateInput } from "../registry/update.js";
import { blobKey, idempotencyHash, metaKey } from "../storage/keys.js";
import { casPut, putBlob } from "../storage/r2.js";
import { loadDrop } from "./get.js";
import type { ClaimRecord } from "./idempotency.js";
import { putClaim, putResult, readClaim, readResult, requireSamePayload } from "./idempotency.js";
import type { FaultPoint } from "./publish.js";
import { repairListEntry, writeProjections } from "./projections.js";
import { resolveInlineFiles } from "./resolve-content.js";

export type UpdateContext = {
  bucket: Bucket;
  config: InstanceConfig;
  caller: CreatedBy;
  now: Date;
  /** `HMAC_SECRET`; the idempotency result is sealed with a key derived from it. */
  secret: string;
  fault?: FaultPoint | undefined;
};

export async function updateDrop(
  slug: string,
  input: UpdateInput,
  ctx: UpdateContext,
): Promise<Drop> {
  const { bucket, config, now } = ctx;

  // The claim's own key is `sha256(caller id + idempotency_key)` — the frozen
  // layout, so one idempotency_key names one request. The TARGET goes into the
  // payload hash, so the same key aimed at a second drop is a mismatch rather
  // than a silent replay of the first drop's result.
  const payloadHash = await sha256Hex(canonicalJson({ slug, ...input }));
  const hash =
    input.idempotency_key === undefined
      ? undefined
      : await idempotencyHash(ctx.caller.id, input.idempotency_key);

  let claim = hash === undefined ? null : await readClaim(bucket, hash);
  if (claim !== null) {
    requireSamePayload(claim, payloadHash);
    const replayed = await readResult(bucket, hash!, ctx.secret);
    if (replayed !== null) return replayed;
  }

  const loaded = await loadDrop(bucket, slug);
  if (loaded === null) throw new ApiError("NOT_FOUND", `No drop at ${slug}.`);
  const current = loaded.meta;

  const state = dropState(current.expires_at, now);
  if (state === "expired_final") {
    throw new ApiError("EXPIRED_FINAL", `The drop at ${slug} is past recovery.`);
  }
  // Inside grace the drop is revivable, and only by naming a new expiry: an
  // update that ignored the expiry would quietly leave a dead link dead.
  if (state === "expired_grace" && input.expires === undefined) {
    throw new ApiError(
      "EXPIRED_NEEDS_EXPIRES",
      `The drop at ${slug} expired at ${current.expires_at}; send expires to bring it back.`,
    );
  }

  const content = input.files === undefined ? null : await resolveInlineFiles(input.files);
  const manifest: Manifest = claim?.manifest ?? content?.manifest ?? current.manifest;

  const desired = await desiredMeta(current, input, manifest, {
    policy: config.policy,
    now,
    // Decision #74: everything the first attempt read from the clock lives in
    // the claim, so a retry does not re-resolve "30d" against its own clock.
    expiresAt: claim === null ? undefined : claim.expires_at,
  });
  const desiredHash = await stateHash(desired);

  // The no-op rule: equality is the canonical `meta.json` minus `updated`. It
  // writes NOTHING — not the record, not a claim, not a result. A repeat of the
  // same no-op is another no-op, so convergence needs no bookkeeping.
  if (desiredHash === (await stateHash(current))) {
    await repairListEntry(bucket, current);
    return toDrop(current, { canonicalUrl: config.canonicalUrl, now });
  }

  // (0) blobs. A digest the drop already holds is not written again — that is
  // what makes a settings change cost zero blob writes and a one-file change in
  // a hundred-file drop cost one.
  if (content !== null) {
    const held = new Set(Object.values(current.manifest).map((entry) => entry.sha256));
    for (const [digest, bytes] of content.blobs) {
      if (held.has(digest)) continue;
      await putBlob(bucket, blobKey(current.id, digest), bytes, digest);
    }
  }
  fault(ctx, "blobs");

  // (1) the claim fixes the desired state for every retry.
  if (hash !== undefined && claim === null) {
    const record: ClaimRecord = {
      payload_hash: payloadHash,
      drop_id: current.id,
      slug: current.slug,
      gen: desired.current_gen,
      manifest,
      state_hash: desiredHash,
      created: desired.created,
      expires_at: desired.expires_at,
    };
    const claimed = await putClaim(bucket, hash, record);
    if (!claimed.claimed) {
      // A concurrent retry of this same call won the claim. Its record is the
      // identity now; if it already finished, replay its result.
      claim = await readClaim(bucket, hash);
      if (claim === null) throw new ApiError("INTERNAL", "The idempotency claim vanished mid-write.");
      requireSamePayload(claim, payloadHash);
      const replayed = await readResult(bucket, hash, ctx.secret);
      if (replayed !== null) return replayed;
    } else {
      claim = record;
    }
  }
  fault(ctx, "claim");

  // (4) the flip. Everything before this is invisible; everything after is
  // repairable.
  const committed = await commit(bucket, loaded.etag, desired, desiredHash);
  fault(ctx, "meta");

  if (!committed.ours) {
    // Another writer stored exactly this state. It owns the cleanup for the
    // record it wrote, and our view of "unreferenced" came from a `meta.json`
    // that is no longer current.
    return toDrop(committed.meta, { canonicalUrl: config.canonicalUrl, now });
  }

  // (5) projections. The marker moves with the expiry; `never` deletes it.
  await writeProjections(bucket, desired, current.expires_at);
  fault(ctx, "projections");

  const drop = toDrop(desired, { canonicalUrl: config.canonicalUrl, now });

  // (6) the result, sealed, so a lost response is recoverable exactly once.
  if (hash !== undefined) await putResult(bucket, hash, ctx.secret, drop);

  // (7) the blobs the new manifest no longer names. Deleting is free in R2 and
  // safe here: nothing references them any more, because `meta.json` already
  // flipped.
  const kept = new Set(Object.values(desired.manifest).map((entry) => entry.sha256));
  const orphaned = [...new Set(Object.values(current.manifest).map((entry) => entry.sha256))]
    .filter((digest) => !kept.has(digest))
    .map((digest) => blobKey(current.id, digest));
  if (orphaned.length > 0) await bucket.delete(orphaned);
  fault(ctx, "cleanup");

  return drop;
}

type DesiredOptions = {
  policy: ResolvedPolicy;
  now: Date;
  /** The claim's resolved expiry, when this call is resuming one. */
  expiresAt?: string | null | undefined;
};

/**
 * The `meta.json` this call is trying to reach: only the fields the caller
 * provided move.
 *
 * Policy *defaults* never apply here — they fill omitted fields on `publish`
 * only. Policy *rules* apply to the fields this call provides, so an omitted
 * field that a later `config set` made non-compliant is grandfathered until the
 * caller next sets it.
 */
async function desiredMeta(
  current: DropMeta,
  input: UpdateInput,
  manifest: Manifest,
  options: DesiredOptions,
): Promise<DropMeta> {
  const meta =
    input.meta === undefined ? current.meta : mergeAgentMeta(current.meta, input.meta);
  if (input.meta !== undefined) checkMetaSize(meta);

  const expiresAt =
    options.expiresAt !== undefined
      ? options.expiresAt
      : input.expires === undefined
        ? current.expires_at
        : resolveExpiryOrFail(input.expires, options.policy, options.now);

  const noindex = options.policy.noindex.forced
    ? options.policy.noindex.default
    : (input.noindex ?? current.noindex);

  return {
    ...current,
    title: input.title === undefined ? current.title : input.title,
    meta,
    current_gen: await sha256Hex(canonicalJson(manifest)),
    manifest,
    expires_at: expiresAt,
    noindex,
    updated: `${options.now.toISOString().slice(0, 19)}Z`,
  };
}

type Committed = { ours: true } | { ours: false; meta: DropMeta };

/**
 * Compare-and-swap `meta.json`. A lost CAS is re-read once: if the stored
 * record hashes to the state this call wanted, this is a converging retry and
 * it succeeded. Anything else is a genuine concurrent edit.
 */
async function commit(
  bucket: Bucket,
  etag: string,
  desired: DropMeta,
  desiredHash: string,
): Promise<Committed> {
  const written = await casPut(bucket, metaKey(desired.id), JSON.stringify(desired), etag, {
    httpMetadata: { contentType: "application/json" },
  });
  if (written.ok) return { ours: true };

  const existing = await bucket.get(metaKey(desired.id));
  if (existing !== null) {
    const stored = JSON.parse(await existing.text()) as DropMeta;
    if ((await stateHash(stored)) === desiredHash) return { ours: false, meta: stored };
  }
  throw new ApiError("UPDATE_CONFLICT", "Another write reached this drop first.");
}

function resolveExpiryOrFail(value: string, policy: ResolvedPolicy, now: Date): string | null {
  try {
    return resolveExpiry(
      value,
      { max: policy.expiry.max, allowNever: policy.expiry.allow_never },
      now,
    );
  } catch (error) {
    if (error instanceof ExpiryError) throw new ApiError(error.code, error.message);
    throw error;
  }
}

function fault(ctx: UpdateContext, point: FaultPoint): void {
  if (ctx.fault === point) {
    throw new Error(`DEV_FAULT: aborted after ${point}.`);
  }
}
