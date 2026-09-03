/**
 * `list?q=` — the whole of dropthis's search (docs/spec-v1.md, "Responses").
 *
 * It is a substring match over `title`, and it is deliberately not more: there
 * is no search index, no ranking and no full-text store, because every one of
 * those is a second copy of the truth that has to be kept in step with
 * `meta.json`.
 *
 * Two strings only compare usefully when both go through the same fold. NFC
 * settles how an accent is spelled; the upper-then-lower pass approximates
 * Unicode full case folding, which plain `toLowerCase` does not do (`ß` stays
 * `ß` under it, but folds to `ss`). Running BOTH sides through the identical
 * pipeline is what makes the result stable — Greek final sigma, for instance,
 * comes out the same from `ΟΔΟΣ` and from `οδος`.
 *
 * `toUpperCase`/`toLowerCase` are the locale-independent forms; the
 * `toLocale*` pair is not, and a Turkish locale would silently change what
 * matches.
 */
export function foldForSearch(text: string): string {
  return text.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");
}

/**
 * Whether a drop's title matches the caller's `q`. A drop with no title never
 * matches a non-empty query — a missing title is not a wildcard — and an empty
 * query matches everything, which is what "no `q` was sent" resolves to.
 */
export function matchesTitleQuery(title: string | null, query: string): boolean {
  const needle = foldForSearch(query);
  if (needle === "") return true;
  if (title === null) return false;
  return foldForSearch(title).includes(needle);
}
