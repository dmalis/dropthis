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

/** Derived from the Free subrequest budget: ~507 internal calls at 500 files. */
export const MAX_FILES_PER_CALL = 500;
/** The `title` limit everywhere it appears, including the `list/` pointer. */
export const MAX_TITLE_BYTES = 200;
/** The agent's own notes on the drop; large enough for real provenance. */
export const MAX_META_BYTES = 16 * 1024;

const encoder = new TextEncoder();

const textEntry = z.strictObject({ path: z.string(), text: z.string() });
const base64Entry = z.strictObject({ path: z.string(), base64: z.string() });

/**
 * A union of strict objects, which is how "exactly one of `text` and `base64`"
 * is expressed: an entry with both matches neither branch, and so does an entry
 * with neither.
 */
const fileEntry = z.union([textEntry, base64Entry]);

export type PublishFile = z.infer<typeof fileEntry>;

export const publishSchema = z.strictObject({
  files: z.array(fileEntry),
  title: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
  /**
   * `"generate"`, a chosen password of at least 8 characters, or `null` for
   * none. `null` is a value the caller sends, not an absent field, so the
   * schema takes the union rather than making it optional-and-nullable.
   */
  password: z.union([z.string(), z.null()]).optional(),
  expires: z.string().optional(),
  noindex: z.boolean().optional(),
  idempotency_key: z.string().min(1).optional(),
});

export type PublishInput = z.infer<typeof publishSchema>;

/** zod's first issue, as one sentence naming the field an agent must fix. */
function describe(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return "The request body is not valid.";
  const where = issue.path.length > 0 ? issue.path.join(".") : "the request body";
  if (issue.code === "unrecognized_keys") {
    return `Unknown field${issue.keys.length > 1 ? "s" : ""} ${issue.keys.join(", ")}: this operation takes files, title, meta, password, expires, noindex and idempotency_key.`;
  }
  if (issue.code === "invalid_union") {
    return `Each entry of ${where} needs a path and exactly one of text or base64.`;
  }
  return `${where}: ${issue.message}`;
}

export function parsePublishInput(body: unknown): PublishInput {
  const parsed = publishSchema.safeParse(body);
  if (!parsed.success) throw new ApiError("INVALID_INPUT", describe(parsed.error));
  const input = parsed.data;

  if (input.files.length === 0) {
    throw new ApiError("INVALID_INPUT", "files must hold at least one entry.");
  }
  if (input.files.length > MAX_FILES_PER_CALL) {
    throw new ApiError(
      "POLICY_VIOLATION",
      `A single call carries at most ${MAX_FILES_PER_CALL} files; this one has ${input.files.length}.`,
    );
  }

  if (input.title !== undefined) {
    // NFC now, because the title is hashed into the drop's state and compared
    // byte for byte on an idempotent retry.
    input.title = input.title.normalize("NFC");
    const bytes = encoder.encode(input.title).length;
    if (bytes > MAX_TITLE_BYTES) {
      throw new ApiError(
        "INVALID_INPUT",
        `title is ${bytes} bytes; the limit is ${MAX_TITLE_BYTES} bytes of UTF-8.`,
      );
    }
  }

  if (input.meta !== undefined) {
    const bytes = encoder.encode(JSON.stringify(input.meta)).length;
    if (bytes > MAX_META_BYTES) {
      throw new ApiError(
        "INVALID_INPUT",
        `meta is ${bytes} bytes; the limit is ${MAX_META_BYTES} bytes of JSON.`,
      );
    }
  }

  return input;
}
