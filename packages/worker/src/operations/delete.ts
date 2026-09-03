/**
 * `delete` — immediate and rerun-safe (docs/spec-v1.md, "Expiry lifecycle").
 *
 * The order is the mirror of the write order, and for the same reason: the
 * drop must never be half-gone in a way a visitor can see.
 *
 *   1  `meta.json`   the drop stops existing everywhere, in one write
 *   2  `list/`, `expiring/`   projections of a record that is gone
 *   3  `slugs/<slug>`         the pointer, now dangling
 *   4  the blobs, one batched delete
 *
 * `meta.json` goes FIRST because every read path resolves through it: the
 * instant it is gone the viewer, `get`, `update` and the download route all
 * answer 404 together. Deleting the blobs first would leave a served drop whose
 * files 404 one by one, which is exactly the half-state the write order exists
 * to prevent. A crash anywhere after step 1 leaves orphans — a listing row the
 * lister removes, a pointer and blobs the reconcile removes — and never a
 * broken drop.
 *
 * Every step tolerates a missing key, so a rerun finishes an interrupted delete
 * and a delete of nothing is still `204`. That is what makes it safe for an
 * agent to retry a call whose response it never saw.
 */
import type { Bucket } from "../bindings.js";
import { blobKey, metaKey, slugKey } from "../storage/keys.js";
import { loadDrop } from "./get.js";
import { deleteProjections } from "./projections.js";

export async function deleteDrop(bucket: Bucket, slug: string): Promise<void> {
  const loaded = await loadDrop(bucket, slug);
  if (loaded === null) {
    // Either it never existed or a previous run got past `meta.json`. Remove
    // the pointer if one is still there and leave the rest to the reconcile,
    // which is the component that owns orphans.
    await bucket.delete(slugKey(slug));
    return;
  }

  const { dropId, meta } = loaded;

  await bucket.delete(metaKey(dropId));
  await deleteProjections(bucket, meta);
  await bucket.delete(slugKey(slug));

  const blobs = [...new Set(Object.values(meta.manifest).map((entry) => entry.sha256))].map(
    (digest) => blobKey(dropId, digest),
  );
  if (blobs.length > 0) await bucket.delete(blobs);
}
