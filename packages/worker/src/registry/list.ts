/**
 * `list` — one page of drops, newest first (docs/spec-v1.md, "Responses").
 *
 * The query is three values and no more: where to continue, how many, and a
 * substring of the title. There is no filter language and no sort option,
 * because R2 key order IS the sort and a second ordering would need a second
 * index — the one thing "files are the database" refuses to keep.
 *
 * The three arrive as strings over REST and as themselves over MCP, so the
 * schema takes both (`registry/params.ts`) and the operation sees one shape.
 */
import { z } from "zod";
import { ApiError } from "../errors.js";
import { describeIssues } from "./fields.js";
import { intParam } from "./params.js";

/** What a caller gets when it says nothing. */
export const DEFAULT_LIST_LIMIT = 100;
/** R2's own `list()` page maximum, and therefore ours. */
export const MAX_LIST_LIMIT = 1000;

const FIELDS = "cursor, limit and q";

export const listSchema = z.strictObject({
  limit: intParam
    .default(DEFAULT_LIST_LIMIT)
    .describe(`Rows per page, 1 to ${MAX_LIST_LIMIT} (default ${DEFAULT_LIST_LIMIT}).`),
  cursor: z.string().optional().describe("The cursor of the previous page, to continue from it."),
  q: z
    .string()
    .default("")
    .describe("A case-insensitive substring of the title, matched within the page."),
});

export type ListInput = z.infer<typeof listSchema>;

/**
 * A bad `limit` is refused rather than clamped. Silently serving 100 rows to a
 * caller that asked for 5,000 would make its paging arithmetic wrong in a way
 * nothing reports. An empty `cursor` is "no cursor": a client that echoes back
 * the `null` of the last page must not be told its own answer is invalid.
 */
export function parseListInput(raw: unknown): ListInput {
  const given = (raw ?? {}) as Record<string, unknown>;

  const parsed = listSchema.safeParse(raw);
  if (!parsed.success) {
    // Only `limit` gets a bespoke sentence: it is the one value with a range,
    // and an agent that got it wrong needs the bounds, not zod's wording.
    if (parsed.error.issues[0]?.path[0] === "limit") throw badLimit(given.limit);
    throw new ApiError("INVALID_INPUT", describeIssues(parsed.error, FIELDS));
  }

  const input = parsed.data;
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_LIST_LIMIT) {
    throw badLimit(given.limit);
  }

  return { ...input, ...(input.cursor === "" ? { cursor: undefined } : {}) };
}

function badLimit(value: unknown): ApiError {
  return new ApiError(
    "INVALID_INPUT",
    `limit must be a whole number between 1 and ${MAX_LIST_LIMIT}; got ${JSON.stringify(value)}.`,
  );
}
