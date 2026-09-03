/**
 * `publish` — the operation registry's first entry. One zod schema defines the
 * input, and REST validation, the MCP tool schema and the CLI parser all read
 * it, so the three surfaces cannot drift (AGENTS.md, "Operation registry").
 *
 * The schema is the contract in the strict sense: an unknown field is
 * `INVALID_INPUT`, never ignored. An agent that sends `password` today gets
 * told the field is not there, instead of silently publishing an unprotected
 * drop and believing otherwise.
 *
 * `url` entries and the staged upload path are issue #9; this slice takes
 * `{path, text}` and `{path, base64}` only.
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

export {
  MAX_FILES_PER_CALL,
  MAX_URL_ENTRIES,
  MAX_META_BYTES,
  MAX_TITLE_BYTES,
  type PublishFile,
} from "./fields.js";

const FIELDS = "files, title, meta, password, expires, noindex and idempotency_key";

export const publishSchema = z.strictObject({
  files: z.array(fileEntry).describe(FILES_DESCRIPTION),
  title: z.string().optional().describe(TITLE_DESCRIPTION),
  meta: z.record(z.string(), z.unknown()).optional().describe(META_DESCRIPTION),
  /**
   * `null` is a value the caller sends, not an absent field, so the schema
   * takes the union rather than making it optional-and-nullable.
   */
  password: z.union([z.string(), z.null()]).optional().describe(PASSWORD_DESCRIPTION),
  expires: z.string().optional().describe(EXPIRES_DESCRIPTION),
  noindex: z.boolean().optional().describe(NOINDEX_DESCRIPTION),
  idempotency_key: z.string().min(1).optional().describe(IDEMPOTENCY_DESCRIPTION),
});

export type PublishInput = z.infer<typeof publishSchema>;

export function parsePublishInput(body: unknown): PublishInput {
  const parsed = publishSchema.safeParse(body);
  if (!parsed.success) throw new ApiError("INVALID_INPUT", describeIssues(parsed.error, FIELDS));
  const input = parsed.data;

  checkFiles(input.files);
  if (input.title !== undefined) input.title = normalizeTitle(input.title);
  if (input.meta !== undefined) checkMetaSize(input.meta);

  return input;
}
