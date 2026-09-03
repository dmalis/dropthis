/**
 * `list` — one page of drops, newest first (docs/spec-v1.md, "Responses").
 *
 * The query is three values and no more: where to continue, how many, and a
 * substring of the title. There is no filter language and no sort option,
 * because R2 key order IS the sort and a second ordering would need a second
 * index — the one thing "files are the database" refuses to keep.
 */
import { ApiError } from "../errors.js";

/** What a caller gets when it says nothing. */
export const DEFAULT_LIST_LIMIT = 100;
/** R2's own `list()` page maximum, and therefore ours. */
export const MAX_LIST_LIMIT = 1000;

export type ListInput = {
  limit: number;
  cursor: string | undefined;
  q: string;
};

/**
 * A bad `limit` is refused rather than clamped. Silently serving 100 rows to a
 * caller that asked for 5,000 would make its paging arithmetic wrong in a way
 * nothing reports.
 */
export function parseListInput(query: URLSearchParams): ListInput {
  const raw = query.get("limit");
  let limit = DEFAULT_LIST_LIMIT;
  if (raw !== null) {
    limit = Number(raw);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
      throw new ApiError(
        "INVALID_INPUT",
        `limit must be a whole number between 1 and ${MAX_LIST_LIMIT}; got ${JSON.stringify(raw)}.`,
      );
    }
  }

  const cursor = query.get("cursor");
  return {
    limit,
    cursor: cursor === null || cursor === "" ? undefined : cursor,
    q: query.get("q") ?? "",
  };
}
