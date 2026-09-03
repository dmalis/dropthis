/**
 * The registry entries for the staged-upload path (AGENTS.md, "One call
 * uploads a drop"; decision #93).
 *
 * The session and the commit are tools as well as routes — `dropthis_upload`
 * and `dropthis_commit` — because a browser agent whose sandbox can run curl
 * moves bytes that way instead of typing them as base64. Only the blob PUT
 * stays REST-only: its credential is the HMAC in its own URL, not a key, so
 * it is not something an agent calls with its key.
 */
import { z } from "zod";
import { ApiError } from "../errors.js";
import { parseFaultPoint } from "../operations/publish.js";
import { commitSession, createSession, putStagedBlob } from "../operations/uploads.js";
import type { CommitInput, PutInput, SessionInput, UploadContext } from "../operations/uploads.js";
import {
  EXPIRES_DESCRIPTION,
  IDEMPOTENCY_DESCRIPTION,
  META_DESCRIPTION,
  NOINDEX_DESCRIPTION,
  PASSWORD_DESCRIPTION,
  PATH_DESCRIPTION,
  TITLE_DESCRIPTION,
  describeIssues,
} from "./fields.js";
import type { Operation, OperationContext } from "./types.js";

const manifestEntry = z.strictObject({
  path: z.string().describe(PATH_DESCRIPTION),
  size: z
    .number()
    .describe("The file's length in bytes; the PUT must send exactly this many."),
  sha256: z
    .string()
    .describe(
      "The file's SHA-256 as lowercase hex. R2 verifies it: other bytes are HASH_MISMATCH and " +
        "nothing is stored.",
    ),
  /** A public http(s) URL the instance fetches at commit, instead of a PUT. */
  url: z
    .string()
    .optional()
    .describe(
      "A public http(s) URL this instance fetches at commit instead of you uploading this file.",
    ),
});

export const uploadCreateSchema = z.strictObject({
  target: z
    .string()
    .optional()
    .describe(
      "Update an EXISTING drop instead of making a new one: its URL on this instance, or its " +
        "slug. Omit it for a new drop.",
    ),
  manifest: z
    .array(manifestEntry)
    .describe(
      "Every file the drop will have, each {path, size, sha256}. On an update this REPLACES the " +
        "whole file set.",
    ),
  idempotency_key: z.string().min(1).optional().describe(IDEMPOTENCY_DESCRIPTION),
});

const putSchema = z.strictObject({
  id: z.string(),
  sha256: z.string(),
  exp: z.string().optional(),
  sig: z.string().optional(),
});

/**
 * The commit carries the settings `publish` and `update` take, spelled the same
 * way — `password` included, so a drop too large for one call is not a drop the
 * instance's password policy cannot reach.
 */
export const uploadCommitSchema = z.strictObject({
  id: z.string().describe("The upload_id dropthis_upload returned."),
  title: z.string().nullable().optional().describe(TITLE_DESCRIPTION),
  meta: z.record(z.string(), z.unknown()).optional().describe(META_DESCRIPTION),
  password: z.union([z.string(), z.null()]).optional().describe(PASSWORD_DESCRIPTION),
  expires: z.string().optional().describe(EXPIRES_DESCRIPTION),
  noindex: z.boolean().optional().describe(NOINDEX_DESCRIPTION),
});

function uploadContext(ctx: OperationContext): UploadContext {
  return {
    bucket: ctx.bucket,
    config: ctx.config,
    caller: ctx.caller,
    now: ctx.now,
    secret: ctx.secret(),
    canonicalUrl: ctx.config.canonicalUrl,
    fault: parseFaultPoint(ctx.hooks.fault(ctx.request, ctx.env)),
  };
}

function parseWith<T>(schema: z.ZodType<T>, fields: string): (raw: unknown) => T {
  return (raw) => {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new ApiError("INVALID_INPUT", describeIssues(parsed.error, fields));
    return parsed.data;
  };
}

export const uploadCreate: Operation<SessionInput> = {
  name: "upload.create",
  method: "POST",
  path: "/uploads",
  scope: "user",
  summary: "Open a staged upload: allocate the drop and get a signed PUT URL per missing blob.",
  schema: uploadCreateSchema as unknown as z.ZodType<SessionInput>,
  parse: parseWith(uploadCreateSchema, "target, manifest and idempotency_key"),
  status: 201,
  toolName: "dropthis_upload",
  handler: async (input, ctx) => {
    const result = await createSession(input, uploadContext(ctx));
    return { value: result.session, status: result.created ? 201 : 200 };
  },
};

export const uploadPut: Operation<PutInput> = {
  name: "upload.put",
  method: "PUT",
  path: "/uploads/:id/blobs/:sha256",
  scope: "signed",
  summary: "Stream one blob of a staged upload to its final key; R2 verifies the digest.",
  schema: putSchema,
  params: ["id", "sha256"],
  query: ["exp", "sig"],
  restOnly: true,
  rawBody: true,
  handler: async (input, ctx) => ({
    value: await putStagedBlob(input, ctx.request, uploadContext(ctx)),
  }),
};

type CommitRequest = CommitInput & { id: string };

export const uploadCommit: Operation<CommitRequest> = {
  name: "upload.commit",
  method: "POST",
  path: "/uploads/:id/commit",
  scope: "user",
  summary: "Commit a staged upload with the settings publish takes; replays on repeat.",
  schema: uploadCommitSchema as unknown as z.ZodType<CommitRequest>,
  parse: parseWith(uploadCommitSchema, "title, meta, password, expires and noindex"),
  params: ["id"],
  toolName: "dropthis_commit",
  handler: async (input, ctx) => {
    const { id, ...settings } = input;
    const result = await commitSession(id, settings, uploadContext(ctx));
    return { value: result.drop, status: result.created ? 201 : 200 };
  },
};
