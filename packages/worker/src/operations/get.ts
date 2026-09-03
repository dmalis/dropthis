/**
 * `get` — read a drop by slug, optionally with its text inline.
 *
 * Two reads, both of keys computed from the slug: the pointer, then
 * `meta.json`. Neither is cached and neither is a `list()`. A pointer whose
 * `meta.json` is gone is a 404 — the pointer is never repaired lazily, because
 * by construction it is written before `meta.json` ever exists.
 *
 * `files: true` exists so an agent can pull, edit and update with no local
 * state. It inlines text-typed files in manifest order until the 1 MB budget is
 * spent; everything else carries a `download_url` instead, so the response has
 * a bound no matter what was published.
 */
import type { Bucket } from "../bindings.js";
import { isTextTyped } from "../domain/content-type.js";
import { dropState } from "../domain/expiry.js";
import type { Drop, DropFile, DropMeta } from "../domain/meta.js";
import { toDrop } from "../domain/meta.js";
import { encodePathForUrl } from "../domain/url-path.js";
import { ApiError } from "../errors.js";
import type { InstanceConfig } from "../instance-config.js";
import { blobKey, metaKey, slugKey } from "../storage/keys.js";
import { repairListEntry } from "./projections.js";

/** The total bytes `get(files: true)` will inline across all files. */
export const INLINE_CONTENT_BUDGET = 1024 * 1024;

/**
 * `etag` is the CAS token `update` compares against: the drop was read at this
 * version, and the flip only lands if nothing moved since.
 */
export type LoadedDrop = { dropId: string; meta: DropMeta; etag: string };

/** The slug → pointer → `meta.json` walk every read path starts with. */
export async function loadDrop(bucket: Bucket, slug: string): Promise<LoadedDrop | null> {
  const pointer = await bucket.get(slugKey(slug));
  if (pointer === null) return null;
  const dropId = (await pointer.text()).trim();
  if (dropId.length === 0) return null;

  const record = await bucket.get(metaKey(dropId));
  if (record === null) return null;
  return { dropId, meta: JSON.parse(await record.text()) as DropMeta, etag: record.etag };
}

export type GetOptions = {
  bucket: Bucket;
  config: InstanceConfig;
  now: Date;
  files: boolean;
};

export type DropFileWithContent = DropFile & { content?: string; download_url?: string };

export async function getDrop(slug: string, options: GetOptions): Promise<Drop> {
  const loaded = await loadDrop(options.bucket, slug);
  if (loaded === null) throw new ApiError("NOT_FOUND", `No drop at ${slug}.`);

  if (dropState(loaded.meta.expires_at, options.now) === "expired_final") {
    throw new ApiError("EXPIRED_FINAL", `The drop at ${slug} is past recovery.`);
  }

  // "A `meta.json` whose `list/` entry is missing or stale is repaired by the
  // next `get`" (AGENTS.md). It costs one `head`, and it is the only reason a
  // listing can be answered from pointers alone.
  await repairListEntry(options.bucket, loaded.meta);

  const drop = toDrop(loaded.meta, { canonicalUrl: options.config.canonicalUrl, now: options.now });
  if (!options.files) return drop;

  drop.files = await withContent(loaded, options);
  return drop;
}

async function withContent(
  loaded: LoadedDrop,
  options: GetOptions,
): Promise<DropFileWithContent[]> {
  const decoder = new TextDecoder();
  let remaining = INLINE_CONTENT_BUDGET;
  const files: DropFileWithContent[] = [];

  for (const [path, entry] of Object.entries(loaded.meta.manifest)) {
    const file: DropFileWithContent = {
      path,
      size: entry.size,
      sha256: entry.sha256,
      content_type: entry.content_type,
    };
    if (isTextTyped(entry.content_type) && entry.size <= remaining) {
      const body = await options.bucket.get(blobKey(loaded.dropId, entry.sha256));
      if (body !== null) {
        file.content = decoder.decode(await body.arrayBuffer());
        remaining -= entry.size;
        files.push(file);
        continue;
      }
    }
    file.download_url = downloadUrl(options.config.canonicalUrl, loaded.meta.slug, path);
    files.push(file);
  }
  return files;
}

export function downloadUrl(canonicalUrl: string, slug: string, path: string): string {
  return `${canonicalUrl.replace(/\/+$/, "")}/_api/v1/drops/${slug}/files/${encodePathForUrl(path)}`;
}
