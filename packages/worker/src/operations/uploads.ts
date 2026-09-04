/**
 * The staged-upload path — the way past `max_request_bytes` for the CLI and
 * for any MCP agent whose environment can run `curl` (AGENTS.md, "One call
 * uploads a drop"; docs/spec-v1.md, "Staged upload path"; decision #93).
 *
 *   session   allocate the drop (id, slug claimed now) or fix the update target
 *             (its `meta.json` etag), record the manifest, answer which blobs
 *             are missing and a signed PUT URL for each
 *   put       stream one blob STRAIGHT to `drops/<id>/blobs/<sha256>`; R2
 *             verifies the digest, the Worker never hashes a body
 *   commit    the settings `publish`/`update` take, fenced by the session's
 *             own claim, then steps (4)–(7) of the write order
 *
 * Nothing is ever copied: a blob lands on its final key on the first PUT and
 * is unreachable until commit names it in `meta.json`. A session abandoned
 * before commit leaves blobs, a pending slug pointer and its three keys, all
 * of which the lifecycle rule and the reconcile remove.
 *
 * The three session keys are each written once (`session.json` at creation,
 * `commit` = the fenced claim, `result` = the sealed Drop), so a retry of any
 * step converges on one outcome the way `publish`'s idempotency claim does —
 * and, per decision #74, the claim fixes every clock-derived value.
 */
import type { Bucket } from "../bindings.js";
import type { Caller } from "../auth/caller.js";
import { contentTypeForPath } from "../domain/content-type.js";
import { dropState, resolveExpiryOrFail } from "../domain/expiry.js";
import type { CreatedBy, Drop, DropMeta, Manifest } from "../domain/meta.js";
import { canonicalJson, newDropMeta, parseDropMeta, sha256Hex, stateHash, toDrop } from "../domain/meta.js";
import { normalizeManifestPaths, PathError } from "../domain/paths.js";
import { resolvePassword, storedPassword } from "../domain/password.js";
import { generateSlug } from "../domain/slug.js";
import { ApiError } from "../errors.js";
import type { InstanceConfig, ResolvedPolicy } from "../instance-config.js";
import { MAX_FILES_PER_CALL, checkMetaSize, normalizeTitle } from "../registry/fields.js";
import {
  blobKey,
  idempotencyHash,
  metaKey,
  newDropId,
  newUploadId,
  slugKey,
  uploadCommitKey,
  uploadResultKey,
  uploadSessionKey,
} from "../storage/keys.js";
import { casPut, claimKey, createPut, putBlob } from "../storage/r2.js";
import { decryptResult, encryptResult } from "../storage/result-crypto.js";
import { signUploadUrl, verifyUploadSignature } from "../storage/upload-sign.js";
import { checkPublicUrl, fetchPublicUrl, newFetchBudget } from "./fetch-url.js";
import { MAX_URL_ENTRIES } from "../registry/fields.js";
import { resolveKeep, streamToBlob } from "./resolve-content.js";
import { loadDrop } from "./get.js";
import { openPassword, sealPassword } from "./idempotency.js";
import { writeProjections } from "./projections.js";
import type { FaultPoint } from "./publish.js";
import { desiredUpdateMeta } from "./update.js";

/** A session lives one day; the bucket's lifecycle rule on `uploads/` matches. */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
/** A signed PUT URL lives one hour. */
export const PUT_URL_TTL_S = 60 * 60;

export type ManifestInput = {
  path: string;
  /**
   * Absent = the keep kind (#95): the target drop already holds this digest, so
   * its size and content type come from the drop and nothing is uploaded. It is
   * the same `{path, sha256}` an inline `update` takes.
   */
  size?: number | undefined;
  sha256: string;
  /** A public URL the INSTANCE fetches at commit; the client never uploads it. */
  url?: string | undefined;
};

/** A manifest entry as the caller sent it, before a keep is resolved. */
type DeclaredEntry = { path: string; sha256: string; size?: number | undefined };

export type SessionInput = {
  target?: string | undefined;
  manifest: ManifestInput[];
  idempotency_key?: string | undefined;
};

export type CommitInput = {
  title?: string | null | undefined;
  meta?: Record<string, unknown> | undefined;
  /** `"generate"`, a chosen password, or `null` to remove one — as `update`. */
  password?: string | null | undefined;
  expires?: string | undefined;
  noindex?: boolean | undefined;
};

/** `uploads/<id>/session.json` — written once, at creation. */
export type UploadSession = {
  id: string;
  key_id: string;
  drop_id: string;
  slug: string;
  /** The slug being updated, or `null` for a new drop. */
  target: string | null;
  /** An update's `meta.json` etag at session open; commit CASes against it. */
  base_etag: string | null;
  manifest: Manifest;
  /**
   * `sha256` → the public URL the instance fetches for it at commit. A blob
   * with a source is never asked of the client, so a drop too large for one
   * call can still carry an image that already lives on the web.
   */
  sources?: Record<string, string>;
  /** So an idempotent rerun can tell "the same upload" from "another one". */
  manifest_hash: string;
  created: string;
  expires: string;
};

/** `uploads/<id>/commit` — the fenced claim the first commit writes. */
type CommitClaim = {
  payload_hash: string;
  state_hash: string;
  gen: string;
  created: string;
  expires_at: string | null;
  /**
   * The stored `access` this commit decided on, exactly as `publish`'s claim
   * carries it: a generated password is random, so a retry that derived a
   * second one would build a different `meta.json` and never converge.
   */
  access: Record<string, unknown>;
  /** That password, AES-GCM sealed, so a retry can rebuild the one response. */
  password_enc?: string;
  /**
   * The generation this commit is replacing, on an update: enough of the base
   * `meta.json` to finish steps (5) and (7) — move the `expiring/` marker and
   * delete the blobs the new manifest no longer names.
   *
   * It lives in the CLAIM and not in the session because the base is what the
   * FIRST commit attempt read, and a retry that finds `meta.json` already
   * flipped can no longer read it anywhere else (issue #24, finding 11).
   */
  previous?: { manifest: Manifest; expires_at: string | null };
};

export type SessionResult = {
  upload_id: string;
  drop_id: string;
  slug: string;
  missing: string[];
  put_urls: Record<string, string>;
  expires: string;
};

export type UploadContext = {
  bucket: Bucket;
  config: InstanceConfig;
  caller: Caller;
  now: Date;
  secret: string;
  canonicalUrl: string;
  fault?: FaultPoint | undefined;
};

const SHA256_HEX = /^[0-9a-f]{64}$/;

function second(now: Date): string {
  return `${now.toISOString().slice(0, 19)}Z`;
}

/* ------------------------------------------------------------------ session */

export async function createSession(
  input: SessionInput,
  ctx: UploadContext,
): Promise<{ session: SessionResult; created: boolean }> {
  const { bucket, now } = ctx;
  // The manifest is parsed as DECLARED and resolved once the target is known: a
  // keep entry's size and content type live in the target's own manifest.
  const { declared, sources } = parseManifest(
    input.manifest,
    ctx.config.policy,
    input.target !== undefined,
  );
  const manifestHash = await sha256Hex(
    canonicalJson({ target: input.target ?? null, manifest: declared, sources }),
  );

  const uploadId =
    input.idempotency_key === undefined
      ? newUploadId(now)
      : await idempotencyHash(ctx.caller.id, input.idempotency_key);

  // An idempotent rerun finds its own session and gets the same drop back,
  // with a fresh view of what is still missing and fresh URLs.
  if (input.idempotency_key !== undefined) {
    const existing = await readSession(bucket, uploadId);
    if (existing !== null) {
      requireOwner(existing, ctx.caller);
      if (existing.manifest_hash !== manifestHash) {
        throw new ApiError(
          "IDEMPOTENCY_MISMATCH",
          "This idempotency_key was used for a different upload.",
        );
      }
      requireLive(existing, now);
      return { session: await describe(existing, ctx, true), created: false };
    }
  }

  let dropId: string;
  let slug: string;
  let baseEtag: string | null = null;
  let manifest: Manifest;
  const expires = new Date(now.getTime() + SESSION_TTL_MS).toISOString();

  if (input.target !== undefined) {
    const loaded = await loadDrop(bucket, input.target);
    if (loaded === null) throw new ApiError("NOT_FOUND", `No drop at ${input.target}.`);
    if (dropState(loaded.meta.expires_at, now) === "expired_final") {
      throw new ApiError("EXPIRED_FINAL", `The drop at ${input.target} is past recovery.`);
    }
    dropId = loaded.dropId;
    slug = loaded.meta.slug;
    baseEtag = loaded.etag;
    // Before the slug or any blob moves: a keep the drop does not hold is the
    // caller's mistake, and it costs nothing to say so now.
    manifest = resolveManifest(declared, loaded.meta.manifest);
  } else {
    manifest = resolveManifest(declared, {});
    dropId = newDropId(now);
    slug = await claimPendingSlug(bucket, dropId, expires);
  }

  const session: UploadSession = {
    id: uploadId,
    key_id: ctx.caller.id,
    drop_id: dropId,
    slug,
    target: input.target ?? null,
    base_etag: baseEtag,
    manifest,
    ...(Object.keys(sources).length === 0 ? {} : { sources }),
    manifest_hash: manifestHash,
    created: second(now),
    expires,
  };

  const claimed = await claimKey(bucket, uploadSessionKey(uploadId), JSON.stringify(session), {
    httpMetadata: { contentType: "application/json" },
  });
  if (!claimed.claimed) {
    // Only an idempotent rerun can race here: two identical calls opened the
    // session at once. The other one's record is the session now.
    const winner = await readSession(bucket, uploadId);
    if (winner === null) throw new ApiError("INTERNAL", "The upload session vanished mid-write.");
    requireOwner(winner, ctx.caller);
    if (winner.manifest_hash !== manifestHash) {
      throw new ApiError("IDEMPOTENCY_MISMATCH", "This idempotency_key was used for a different upload.");
    }
    if (input.target === undefined) await bucket.delete(slugKey(slug));
    return { session: await describe(winner, ctx, true), created: false };
  }

  return { session: await describe(session, ctx, input.target !== undefined), created: true };
}

function parseManifest(
  entries: ManifestInput[],
  policy: ResolvedPolicy,
  hasTarget: boolean,
): { declared: DeclaredEntry[]; sources: Record<string, string> } {
  if (entries.length === 0) throw new ApiError("INVALID_INPUT", "manifest must hold at least one entry.");
  if (entries.length > MAX_FILES_PER_CALL) {
    throw new ApiError(
      "POLICY_VIOLATION",
      `A single upload carries at most ${MAX_FILES_PER_CALL} files; this one has ${entries.length}.`,
    );
  }

  let paths: string[];
  try {
    paths = normalizeManifestPaths(entries.map((entry) => entry.path));
  } catch (error) {
    if (error instanceof PathError) throw new ApiError("INVALID_PATH", error.message);
    throw error;
  }

  const declared: DeclaredEntry[] = [];
  const sources: Record<string, string> = {};
  for (const [index, entry] of entries.entries()) {
    const path = paths[index]!;
    if (!SHA256_HEX.test(entry.sha256)) {
      throw new ApiError("INVALID_INPUT", `manifest.${index}.sha256: must be 64 lowercase hex characters.`);
    }
    // No size = keep what the target already holds. There is nothing to upload
    // and nothing to fetch, so a `url` beside it is two kinds in one entry.
    if (entry.size === undefined) {
      if (!hasTarget) {
        throw new ApiError(
          "INVALID_INPUT",
          `${JSON.stringify(path)} carries only a sha256, which keeps a file the target drop already has. This session creates a drop, and a new drop has no files yet: send its size and upload the bytes.`,
        );
      }
      if (entry.url !== undefined) {
        throw new ApiError(
          "INVALID_INPUT",
          `manifest.${index}: an entry with no size keeps a file the drop already has, so it cannot also name a url.`,
        );
      }
      declared.push({ path, sha256: entry.sha256 });
      continue;
    }
    if (!Number.isInteger(entry.size) || entry.size < 0) {
      throw new ApiError("INVALID_INPUT", `manifest.${index}.size: must be a whole number of bytes.`);
    }
    if (entry.size > policy.max_file_bytes) {
      throw new ApiError(
        "POLICY_VIOLATION",
        `${JSON.stringify(path)} is ${entry.size} bytes; this instance accepts files up to ${policy.max_file_bytes}.`,
      );
    }
    declared.push({ path, sha256: entry.sha256, size: entry.size });
    // The target is validated now, not at commit: a URL this instance will
    // never fetch should fail before the client uploads anything else.
    if (entry.url !== undefined) sources[entry.sha256] = checkPublicUrl(entry.url).href;
  }
  if (Object.keys(sources).length > MAX_URL_ENTRIES) {
    throw new ApiError(
      "INVALID_INPUT",
      `A single upload fetches at most ${MAX_URL_ENTRIES} url entries; this one has ${Object.keys(sources).length}.`,
    );
  }
  return { declared, sources };
}

/**
 * The declared manifest against the drop as it stands: a keep entry takes its
 * size and content type from `current`, exactly the way an inline `update`
 * resolves the same `{path, sha256}` — one function, so the two paths can never
 * disagree about what "keep" means.
 */
function resolveManifest(declared: DeclaredEntry[], current: Manifest): Manifest {
  const manifest: Manifest = {};
  for (const entry of declared) {
    manifest[entry.path] =
      entry.size === undefined
        ? resolveKeep(entry.path, entry.sha256, current)
        : { sha256: entry.sha256, size: entry.size, content_type: contentTypeForPath(entry.path) };
  }
  return manifest;
}

/**
 * Claim `slugs/<slug>` for a drop that does not exist yet. The pointer's body
 * is the drop id — exactly what `publish` writes, so every reader walks it the
 * same way — and its metadata marks it pending with the session's expiry, so
 * the reconcile can tell an abandoned session's pointer from a live drop's.
 */
async function claimPendingSlug(bucket: Bucket, dropId: string, expires: string): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const slug = generateSlug();
    const claimed = await claimKey(bucket, slugKey(slug), dropId, {
      customMetadata: { pending_upload: "1", expires },
    });
    if (claimed.claimed) return slug;
  }
  throw new ApiError("INTERNAL", "Could not find a free slug in five attempts.");
}

/**
 * The session as the caller sees it. For a new drop every blob is missing by
 * construction — the drop id is fresh — so no HEADs are spent; for an update
 * (and a rerun) each distinct digest is checked so unchanged files are never
 * uploaded twice.
 */
async function describe(
  session: UploadSession,
  ctx: UploadContext,
  check: boolean,
): Promise<SessionResult> {
  const digests = [...new Set(Object.values(session.manifest).map((entry) => entry.sha256))];
  const missing: string[] = [];
  for (const digest of digests) {
    // A blob the instance fetches itself is never the client's to upload.
    if (session.sources?.[digest] !== undefined) continue;
    if (check && (await ctx.bucket.head(blobKey(session.drop_id, digest))) !== null) continue;
    missing.push(digest);
  }

  const exp = Math.floor(ctx.now.getTime() / 1000) + PUT_URL_TTL_S;
  const putUrls: Record<string, string> = {};
  for (const digest of missing) {
    const sig = await signUploadUrl(ctx.secret, { uploadId: session.id, sha256: digest, exp });
    putUrls[digest] =
      `${ctx.canonicalUrl.replace(/\/+$/, "")}/_api/v1/uploads/${session.id}/blobs/${digest}?exp=${exp}&sig=${sig}`;
  }

  return {
    upload_id: session.id,
    drop_id: session.drop_id,
    slug: session.slug,
    missing,
    put_urls: putUrls,
    expires: session.expires,
  };
}

async function readSession(bucket: Bucket, uploadId: string): Promise<UploadSession | null> {
  const object = await bucket.get(uploadSessionKey(uploadId));
  if (object === null) return null;
  try {
    return JSON.parse(await object.text()) as UploadSession;
  } catch {
    return null;
  }
}

function expired(): ApiError {
  return new ApiError("UPLOAD_EXPIRED", "This upload session does not exist or has expired.");
}

/** A session past its day, or one that never existed, are the same 410. */
async function requireSession(bucket: Bucket, uploadId: string, now: Date): Promise<UploadSession> {
  const session = await readSession(bucket, uploadId);
  if (session === null) throw expired();
  requireLive(session, now);
  return session;
}

function requireLive(session: UploadSession, now: Date): void {
  if (now.getTime() >= Date.parse(session.expires)) throw expired();
}

function requireOwner(session: UploadSession, caller: Caller): void {
  if (session.key_id !== caller.id) {
    throw new ApiError("FORBIDDEN_SCOPE", "This upload session belongs to another key.");
  }
}

/* ---------------------------------------------------------------------- put */

export type PutInput = {
  id: string;
  sha256: string;
  exp?: string | undefined;
  sig?: string | undefined;
};

export async function putStagedBlob(
  input: PutInput,
  request: Request,
  ctx: UploadContext,
): Promise<{ sha256: string; size: number }> {
  const exp = Number(input.exp);
  const notValid = () => new ApiError("UNAUTHENTICATED", "This upload URL is not valid or has expired.");
  if (!Number.isInteger(exp) || typeof input.sig !== "string") throw notValid();
  if (Math.floor(ctx.now.getTime() / 1000) > exp) throw notValid();
  const genuine = await verifyUploadSignature(
    ctx.secret,
    { uploadId: input.id, sha256: input.sha256, exp },
    input.sig,
  );
  if (!genuine) throw notValid();

  const session = await requireSession(ctx.bucket, input.id, ctx.now);
  const entry = Object.values(session.manifest).find((file) => file.sha256 === input.sha256);
  if (entry === undefined) {
    throw new ApiError("INVALID_INPUT", "This session's manifest does not name that sha256.");
  }

  // The declared length is checked against the manifest BEFORE any bytes move:
  // R2 verifies the digest, but a body of the wrong size is refused for free.
  const declared = Number(request.headers.get("content-length") ?? "");
  if (!Number.isInteger(declared)) {
    throw new ApiError("INVALID_INPUT", "Send the blob with a Content-Length header.");
  }
  if (declared !== entry.size) {
    throw new ApiError(
      "HASH_MISMATCH",
      `The body is ${declared} bytes; the manifest says ${entry.size} for ${input.sha256}.`,
    );
  }
  if (request.body === null) {
    throw new ApiError("INVALID_INPUT", "Send the blob's bytes as the request body.");
  }

  const written = await putBlob(
    ctx.bucket,
    blobKey(session.drop_id, input.sha256),
    request.body,
    input.sha256,
  );
  return { sha256: input.sha256, size: written.size ?? entry.size };
}

/* ------------------------------------------------------------------- commit */

export type CommitResult = { drop: Drop; created: boolean };

export async function commitSession(
  uploadId: string,
  input: CommitInput,
  ctx: UploadContext,
): Promise<CommitResult> {
  const { bucket, config, now } = ctx;

  const session = await requireSession(bucket, uploadId, now);
  requireOwner(session, ctx.caller);
  const isCreate = session.target === null;

  if (typeof input.title === "string") input.title = normalizeTitle(input.title);
  if (input.meta !== undefined) checkMetaSize(input.meta);
  const payloadHash = await sha256Hex(canonicalJson(input));

  // The fence: a claim already written means this commit ran before.
  let claim = await readClaim(bucket, uploadId);
  if (claim !== null) {
    requireSamePayload(claim, payloadHash);
    const replayed = await readResult(bucket, uploadId, ctx.secret);
    if (replayed !== null) return { drop: replayed, created: false };
  }

  // Every blob must be there. `HEAD` per distinct digest, ≤ 500. A digest with
  // a `url` source that is not there yet is fetched now, streamed straight to
  // its final key with R2 verifying the digest — the same write the client's
  // signed PUT would have made.
  const digests = [...new Set(Object.values(session.manifest).map((entry) => entry.sha256))];
  const budget = newFetchBudget();
  const missing: string[] = [];
  for (const digest of digests) {
    if ((await bucket.head(blobKey(session.drop_id, digest))) !== null) continue;
    const source = session.sources?.[digest];
    if (source === undefined) {
      missing.push(digest);
      continue;
    }
    const response = await fetchPublicUrl(source, { budget });
    // The staged manifest always declares the size, so the body streams under a
    // `FixedLengthStream` and never has to be held in the isolate.
    const declared = Object.values(session.manifest).find((e) => e.sha256 === digest)?.size;
    await streamToBlob(response, source, digest, {
      policy: config.policy,
      declaredSize: declared,
      streamBlob: async (sha256, body) =>
        (await putBlob(bucket, blobKey(session.drop_id, sha256), body, sha256)).size,
    });
  }
  if (missing.length > 0) {
    throw new ApiError(
      "INVALID_INPUT",
      `${missing.length} of ${digests.length} blobs are not uploaded yet: ${missing.join(", ")}.`,
    );
  }

  const createdBy: CreatedBy = { id: ctx.caller.id, label: ctx.caller.label };

  // The current record for an update, and the proof that our own earlier
  // attempt already flipped it (a fault after `meta.json`, before `result`).
  let current: { meta: DropMeta; etag: string } | null = null;
  if (!isCreate) {
    const loaded = await loadDrop(bucket, session.slug);
    if (loaded === null) throw new ApiError("NOT_FOUND", `No drop at ${session.slug}.`);
    current = { meta: loaded.meta, etag: loaded.etag };

    if (claim !== null && loaded.etag !== session.base_etag) {
      if ((await stateHash(loaded.meta)) === claim.state_hash) {
        // Our own earlier attempt flipped `meta.json` and died. Steps (5)-(7)
        // are still owed, and the base generation they need is in the claim.
        return {
          drop: await finish(
            bucket,
            ctx,
            uploadId,
            loaded.meta,
            claim.previous ?? null,
            await openPassword(claim, ctx.secret),
          ),
          created: false,
        };
      }
    }

    const state = dropState(loaded.meta.expires_at, now);
    if (state === "expired_final") {
      throw new ApiError("EXPIRED_FINAL", `The drop at ${session.slug} is past recovery.`);
    }
    if (state === "expired_grace" && input.expires === undefined && claim === null) {
      throw new ApiError(
        "EXPIRED_NEEDS_EXPIRES",
        `The drop at ${session.slug} expired at ${loaded.meta.expires_at}; send expires to bring it back.`,
      );
    }
  }

  // The password is decided before any write, so it is inside the state hash
  // the claim fixes. On a create the rule is `publish`'s (policy default and
  // `required` apply); on an update it is `update`'s (an omitted password
  // changes nothing, and re-sending the current one keeps the nonce).
  const change = await resolvePassword(
    isCreate ? undefined : storedPassword(current!.meta.access),
    input.password,
    {
      iterations: config.policy.pbkdf2_iterations,
      required: config.policy.password.required,
      default: config.policy.password.default,
    },
  );
  let access: Record<string, unknown> = isCreate ? {} : current!.meta.access;
  if (change.kind === "set") access = { ...access, password: change.record };
  if (change.kind === "removed") {
    const { password: _removed, ...rest } = access;
    access = rest;
  }
  let password: string | undefined = change.kind === "set" ? change.password : undefined;
  if (claim !== null) {
    access = claim.access;
    password = await openPassword(claim, ctx.secret);
  }

  const build = async (fixed: CommitClaim | null): Promise<DropMeta> => {
    if (isCreate) {
      const noindex = config.policy.noindex.forced
        ? config.policy.noindex.default
        : (input.noindex ?? config.policy.noindex.default);
      return newDropMeta({
        id: session.drop_id,
        slug: session.slug,
        title: input.title ?? null,
        meta: input.meta ?? {},
        manifest: session.manifest,
        expiresAt:
          fixed === null
            ? resolveExpiryOrFail(input.expires ?? config.policy.expiry.default, config.policy, now)
            : fixed.expires_at,
        noindex,
        createdBy,
        access,
        now,
        ...(fixed === null ? {} : { created: fixed.created }),
      });
    }
    return desiredUpdateMeta(current!.meta, input, session.manifest, access, {
      policy: config.policy,
      now,
      expiresAt: fixed === null ? undefined : fixed.expires_at,
    });
  };

  let desired = await build(claim);
  let desiredHash = await stateHash(desired);

  // (1) the claim fixes the desired state — and every clock-derived value in
  // it (#74) — for every retry.
  if (claim === null) {
    const record: CommitClaim = {
      payload_hash: payloadHash,
      state_hash: desiredHash,
      gen: desired.current_gen,
      created: desired.created,
      expires_at: desired.expires_at,
      access: desired.access,
      ...(await sealPassword(ctx.secret, password)),
      ...(current === null
        ? {}
        : {
            previous: {
              manifest: current.meta.manifest,
              expires_at: current.meta.expires_at,
            },
          }),
    };
    const claimed = await claimKey(bucket, uploadCommitKey(uploadId), JSON.stringify(record));
    if (claimed.claimed) {
      claim = record;
    } else {
      claim = await readClaim(bucket, uploadId);
      if (claim === null) throw new ApiError("INTERNAL", "The commit claim vanished mid-write.");
      requireSamePayload(claim, payloadHash);
      const replayed = await readResult(bucket, uploadId, ctx.secret);
      if (replayed !== null) return { drop: replayed, created: false };
      access = claim.access;
      password = await openPassword(claim, ctx.secret);
      desired = await build(claim);
      desiredHash = await stateHash(desired);
    }
  }
  fault(ctx, "claim");

  // (4) the flip.
  let stored: DropMeta = desired;
  let ours = true;
  if (isCreate) {
    const written = await createPut(bucket, metaKey(session.drop_id), JSON.stringify(desired), {
      httpMetadata: { contentType: "application/json" },
    });
    if (!written.ok) {
      const existing = await readMeta(bucket, session.drop_id);
      if (existing === null || (await stateHash(existing)) !== desiredHash) {
        throw new ApiError("UPDATE_CONFLICT", "Another write reached this drop first.");
      }
      stored = existing;
      ours = false;
    }
  } else {
    const written = await casPut(
      bucket,
      metaKey(session.drop_id),
      JSON.stringify(desired),
      session.base_etag ?? "",
      { httpMetadata: { contentType: "application/json" } },
    );
    if (!written.ok) {
      const existing = await readMeta(bucket, session.drop_id);
      if (existing === null || (await stateHash(existing)) !== desiredHash) {
        throw new ApiError("UPDATE_CONFLICT", "Another write reached this drop first.");
      }
      stored = existing;
      ours = false;
    }
  }
  fault(ctx, "meta");

  // The base generation, whoever won the flip: both writers stored the same
  // state, so "referenced" comes from `stored` and the cleanup is the same set.
  const previous = claim?.previous ?? (current === null ? null : current.meta);
  const drop = await finish(bucket, ctx, uploadId, stored, previous, password);
  return { drop, created: isCreate && ours };
}

/**
 * Steps (5)–(7): projections, the sealed result, the orphaned blobs. Every one
 * is safe to repeat, which is what lets a retry that finds `meta.json` already
 * flipped pick up here.
 */
async function finish(
  bucket: Bucket,
  ctx: UploadContext,
  uploadId: string,
  stored: DropMeta,
  previous: { manifest: Manifest; expires_at: string | null } | null,
  password: string | undefined,
): Promise<Drop> {
  await writeProjections(bucket, stored, previous === null ? undefined : previous.expires_at);
  fault(ctx, "projections");

  const drop = toDrop(stored, { canonicalUrl: ctx.config.canonicalUrl, now: ctx.now });
  // "Returned once" — the password rides this response and the sealed result a
  // retry replays, and lives nowhere else a caller can reach.
  if (password !== undefined) drop.password = password;
  await bucket.put(uploadResultKey(uploadId), await encryptResult(ctx.secret, JSON.stringify(drop)), {
    onlyIf: { etagDoesNotMatch: "*" },
  });

  if (previous !== null) {
    const kept = new Set(Object.values(stored.manifest).map((entry) => entry.sha256));
    const orphaned = [...new Set(Object.values(previous.manifest).map((entry) => entry.sha256))]
      .filter((digest) => !kept.has(digest))
      .map((digest) => blobKey(stored.id, digest));
    if (orphaned.length > 0) await bucket.delete(orphaned);
  }
  fault(ctx, "cleanup");
  return drop;
}

async function readMeta(bucket: Bucket, dropId: string): Promise<DropMeta | null> {
  const object = await bucket.get(metaKey(dropId));
  return object === null ? null : parseDropMeta(await object.text());
}

async function readClaim(bucket: Bucket, uploadId: string): Promise<CommitClaim | null> {
  const object = await bucket.get(uploadCommitKey(uploadId));
  if (object === null) return null;
  try {
    return JSON.parse(await object.text()) as CommitClaim;
  } catch {
    return null;
  }
}

async function readResult(bucket: Bucket, uploadId: string, secret: string): Promise<Drop | null> {
  const object = await bucket.get(uploadResultKey(uploadId));
  if (object === null) return null;
  return JSON.parse(await decryptResult(secret, await object.text())) as Drop;
}

function requireSamePayload(claim: CommitClaim, payloadHash: string): void {
  if (claim.payload_hash !== payloadHash) {
    throw new ApiError(
      "IDEMPOTENCY_MISMATCH",
      "This upload session was already committed with different settings.",
    );
  }
}


function fault(ctx: UploadContext, point: FaultPoint): void {
  if (ctx.fault === point) throw new Error(`DEV_FAULT: aborted after ${point}.`);
}
