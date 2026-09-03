/**
 * The `list/` and `expiring/` projections: what they carry, and how a listing
 * row is rebuilt from one without touching `meta.json` (AGENTS.md, "Key
 * layout").
 *
 * `list` is the one operation that cannot compute its keys, so it pays for an
 * R2 `list()`. Paying a second time — one `meta.json` GET per row — would make
 * a page of 100 drops cost 100 reads of the truth, which is exactly what "files
 * are the database, and `list()` is rare" is there to avoid. So the pointer's
 * `customMetadata` carries every field of the `Drop` shape `list` returns, and
 * the round-trip is pinned by a unit test against `toDrop`.
 *
 * Two things are deliberately NOT stored:
 *   - the slug, which is already the second half of the key. Storing it twice
 *     is one more way for a pointer to contradict itself.
 *   - `state`, which is derived from `expires_at` at list time. A stored state
 *     would be wrong the moment a drop crossed into grace.
 *
 * R2 caps `customMetadata` at 8,192 bytes and allows only strings, so booleans
 * travel as "0"/"1" and an absent key means `null`.
 */
import { dropState } from "./expiry.js";
import { isSlug } from "./slug.js";
import type { Drop, DropMeta } from "./meta.js";
import { dropUrl } from "./target.js";

export type ListEntryMetadata = Record<string, string>;

export function listEntryMetadata(meta: DropMeta): ListEntryMetadata {
  const entry: ListEntryMetadata = {
    id: meta.id,
    created: meta.created,
    updated: meta.updated,
    noindex: meta.noindex ? "1" : "0",
    has_password: meta.access.password !== undefined ? "1" : "0",
    created_by_id: meta.created_by.id,
    created_by_label: meta.created_by.label,
  };
  // An absent key is `null`, which is how "never expires" and "no title" are
  // spelled in a store that holds only strings.
  if (meta.expires_at !== null) entry.expires_at = meta.expires_at;
  if (meta.title !== null) entry.title = meta.title;
  return entry;
}

/**
 * The slug half of `list/<inverted-created-ms>-<slug>`, or `null`.
 *
 * The number is fixed-width, so the first dash after it is the separator and a
 * chosen slug's own dashes are never mistaken for it. The shape is checked with
 * `isSlug` rather than a second regex: a key whose slug half this Worker cannot
 * read is skipped by `list` and never destroyed.
 */
export function slugOfListKey(key: string): string | null {
  const match = /^list\/\d{13}-(.+)$/.exec(key);
  if (match === null) return null;
  return isSlug(match[1]!) ? match[1]! : null;
}

export type ProjectionOptions = { canonicalUrl: string; now: Date };

/**
 * One listing row, rebuilt from the pointer alone. A pointer written by an
 * older Worker may be missing a key the current shape has, so every field
 * defaults the way a tolerant reader must — `meta.json` stays the truth, and a
 * row that disagrees with it is repaired by the next `get`/`update` or by the
 * reconcile.
 */
export function dropFromListEntry(
  key: string,
  entry: ListEntryMetadata | undefined,
  options: ProjectionOptions,
): Drop {
  const slug = slugOfListKey(key) ?? "";
  const fields = entry ?? {};
  const expiresAt = fields.expires_at ?? null;
  return {
    url: dropUrl(slug, options.canonicalUrl),
    slug,
    title: fields.title ?? null,
    created_by: { id: fields.created_by_id ?? "", label: fields.created_by_label ?? "" },
    created: fields.created ?? "",
    updated: fields.updated ?? fields.created ?? "",
    expires_at: expiresAt,
    noindex: fields.noindex !== "0",
    has_password: fields.has_password === "1",
    state: dropState(expiresAt, options.now),
  };
}
