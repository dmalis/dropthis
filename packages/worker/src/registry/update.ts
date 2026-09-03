/**
 * `update` — change only what is given (docs/spec-v1.md, "`update` semantics").
 *
 * Every field is optional and an empty body is legal: an `update` that asks for
 * nothing changes nothing, and the no-op rule already has to answer that case.
 * `files` replaces the WHOLE set, so there is one verb for "new content" and no
 * second verb an agent has to choose between.
 *
 * `title: null` removes the title. `meta`'s `null` values are kept here on
 * purpose — the merge is what deletes them, and the parser must not throw away
 * the difference between "absent" and "explicitly null".
 *
 * `password` takes the same three spellings as `publish` — `"generate"`, a
 * chosen one of at least 8 characters, or `null` to remove it — and re-sending
 * the password the drop already has is the no-op the schema cannot see but
 * the operation honours. `url` entries are the staged path of issue #9 and are
 * refused by name rather than ignored.
 */
import { z } from "zod";
import { ApiError } from "../errors.js";
import {
  EXPIRES_DESCRIPTION,
  FILES_DESCRIPTION,
  IDEMPOTENCY_DESCRIPTION,
  META_DESCRIPTION,
  NOINDEX_DESCRIPTION,
  PASSWORD_DESCRIPTION,
  TITLE_DESCRIPTION,
  checkFiles,
  checkMetaSize,
  describeIssues,
  fileEntry,
  normalizeTitle,
} from "./fields.js";

const FIELDS = "files, title, meta, password, expires, noindex and idempotency_key";

export const updateSchema = z.strictObject({
  files: z.array(fileEntry).optional().describe(FILES_DESCRIPTION),
  title: z.string().nullable().optional().describe(`${TITLE_DESCRIPTION} null removes it.`),
  meta: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(`${META_DESCRIPTION} Merged at the top level; a key set to null is removed.`),
  password: z
    .union([z.string(), z.null()])
    .optional()
    .describe(`${PASSWORD_DESCRIPTION} null removes it; re-sending the current one changes nothing.`),
  expires: z.string().optional().describe(EXPIRES_DESCRIPTION),
  noindex: z.boolean().optional().describe(NOINDEX_DESCRIPTION),
  idempotency_key: z.string().min(1).optional().describe(IDEMPOTENCY_DESCRIPTION),
});

export type UpdateInput = z.infer<typeof updateSchema>;

export function parseUpdateInput(body: unknown): UpdateInput {
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) throw new ApiError("INVALID_INPUT", describeIssues(parsed.error, FIELDS));
  const input = parsed.data;

  if (input.files !== undefined) checkFiles(input.files);
  if (typeof input.title === "string") input.title = normalizeTitle(input.title);
  if (input.meta !== undefined) checkMetaSize(input.meta, "the meta patch");

  return input;
}
