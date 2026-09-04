/**
 * `list` — one R2 `list()` over `list/` per page, and no `meta.json` reads.
 *
 * This is the one operation that cannot compute its keys, so it is the one
 * operation that pays for a `list()` (AGENTS.md, "Files are the database").
 * Everything else about it is arranged to keep that the ONLY cost:
 *
 *   - the pointer key is the inverted creation time, so R2's lexicographic key
 *     order already IS newest-first and its cursor already IS our cursor;
 *   - the pointer's `customMetadata` carries every field of the listing row, so
 *     a page of 100 drops does not become 100 reads of the truth.
 *
 * Nothing else is read. Verifying each row against `drops/<id>/meta.json` would
 * put one R2 operation per row back — measured at ~10 s for a 100-row page —
 * which is the exact cost the projection exists to remove, so an orphaned row
 * is the RECONCILE's (AGENTS.md, "Pruning": orphan pointers and stale
 * projections). `delete` writes the projections away BEFORE `meta.json`, so a
 * crashed delete leaves a live drop missing its row — which the next
 * `get`/`update` repairs — and never a row with nothing behind it (#100).
 *
 * `q` filters WITHIN the page, after the page has been fetched. So a page can
 * come back empty while `has_more` is true, and the skill says so — the
 * alternative is scanning the whole prefix for one query, which is a search
 * index by another name.
 *
 * `expired_final` rows are hidden (docs/spec-v1.md, the state table): past
 * recovery, waiting only for the cron.
 */
import type { Bucket } from "../bindings.js";
import type { Drop } from "../domain/meta.js";
import { dropFromListEntry, slugOfListKey } from "../domain/projections.js";
import { matchesTitleQuery } from "../domain/search.js";
import type { InstanceConfig } from "../instance-config.js";
import type { ListInput } from "../registry/list.js";
import { LIST_PREFIX } from "../storage/keys.js";

export type ListContext = {
  bucket: Bucket;
  config: InstanceConfig;
  now: Date;
};

export type ListPage = {
  drops: Drop[];
  cursor: string | null;
  has_more: boolean;
};

export async function listDrops(input: ListInput, ctx: ListContext): Promise<ListPage> {
  const listing = await ctx.bucket.list({
    prefix: LIST_PREFIX,
    limit: input.limit,
    include: ["customMetadata"],
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
  });

  const drops: Drop[] = [];
  for (const object of listing.objects) {
    if (slugOfListKey(object.key) === null) continue;

    const row = dropFromListEntry(object.key, object.customMetadata, {
      canonicalUrl: ctx.config.canonicalUrl,
      now: ctx.now,
    });

    if (object.customMetadata?.id === undefined) {
      // A pointer this reader cannot interpret — an older Worker's, or one a
      // half-finished write left behind. It is skipped, never deleted: there is
      // no proof its drop is gone, and destroying the row of a live drop is the
      // one mistake a tolerant reader must not make. The next `get`/`update` of
      // that drop rewrites it, and the reconcile owns whatever is left.
      continue;
    }

    if (row.state === "expired_final") continue;
    if (!matchesTitleQuery(row.title, input.q)) continue;
    drops.push(row);
  }

  return {
    drops,
    cursor: listing.truncated ? (listing.cursor ?? null) : null,
    has_more: listing.truncated,
  };
}
