/**
 * Writing, repairing and removing the `list/` and `expiring/` pointers.
 *
 * Both are projections of `meta.json`, never truth (AGENTS.md, "Writes and
 * idempotency"). That is what makes them safe to write LAST: losing one costs a
 * listing row for a while, and never a drop. It is also why each one is
 * repairable, and by whom:
 *
 *   `slugs/`     never repaired lazily — it exists before `meta.json` by
 *                construction, so a pointer without a record is a 404 and the
 *                reconcile removes it.
 *   `list/`      repaired both ways. An entry with no `meta.json` is deleted by
 *                whoever reads it; a missing or stale entry (compared on
 *                `updated`) is rewritten by the next `get` or `update`.
 *   `expiring/`  a hint the cron re-checks against `meta.json`, so a stale one
 *                is harmless and only a MISSING one matters. `get` does not pay
 *                a read for it — no read path depends on it — so it is repaired
 *                by `update`, which already knows the previous expiry, and by
 *                the reconcile.
 */
import type { Bucket } from "../bindings.js";
import { expiringMarkerDate } from "../domain/expiry.js";
import type { DropMeta } from "../domain/meta.js";
import { listEntryMetadata } from "../domain/projections.js";
import { expiringKey, listKey, metaKey } from "../storage/keys.js";

/** The listing pointer's key. `created` never changes, so neither does this. */
export function listKeyOf(meta: DropMeta): string {
  return listKey(Date.parse(meta.created), meta.slug);
}

export function expiringKeyOf(meta: DropMeta): string | null {
  return meta.expires_at === null
    ? null
    : expiringKey(expiringMarkerDate(meta.expires_at), meta.id);
}

export async function putListEntry(bucket: Bucket, meta: DropMeta): Promise<void> {
  await bucket.put(listKeyOf(meta), "", { customMetadata: listEntryMetadata(meta) });
}

/**
 * The projections of a drop that has just been committed. `previousExpiresAt`
 * is the value the CAS replaced: when the expiry moved, the marker moves with
 * it, and "never" is spelled by deleting the old marker and writing none.
 */
export async function writeProjections(
  bucket: Bucket,
  meta: DropMeta,
  previousExpiresAt?: string | null,
): Promise<void> {
  await putListEntry(bucket, meta);

  const marker = expiringKeyOf(meta);
  if (marker !== null) await bucket.put(marker, "");

  if (previousExpiresAt !== undefined && previousExpiresAt !== meta.expires_at) {
    const stale =
      previousExpiresAt === null
        ? null
        : expiringKey(expiringMarkerDate(previousExpiresAt), meta.id);
    if (stale !== null && stale !== marker) await bucket.delete(stale);
  }
}

/**
 * Rewrite the listing pointer only when it is missing or behind. `updated` is
 * the comparison the spec names, and reading it costs one `head` — the price of
 * `list` being able to answer from pointers alone.
 */
export async function repairListEntry(bucket: Bucket, meta: DropMeta): Promise<void> {
  const existing = await bucket.head(listKeyOf(meta));
  if (existing !== null && existing.customMetadata?.updated === meta.updated) return;
  await putListEntry(bucket, meta);
}

/** Both pointers of a drop that is going away. Deletes tolerate a missing key. */
export async function deleteProjections(bucket: Bucket, meta: DropMeta): Promise<void> {
  await bucket.delete(listKeyOf(meta));
  const marker = expiringKeyOf(meta);
  if (marker !== null) await bucket.delete(marker);
}

/**
 * A listing pointer whose drop is gone. `list` calls this while it walks a
 * page, which is the "deleted by whoever reads it" half of the repair rule.
 */
export async function dropRecordExists(bucket: Bucket, dropId: string): Promise<boolean> {
  return (await bucket.head(metaKey(dropId))) !== null;
}
