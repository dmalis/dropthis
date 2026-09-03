/**
 * The registry entries for the staged-upload path. All three are REST-only:
 * the CLI is the only client in v1, and neither an MCP tool nor `/_skill.md`
 * mentions them (AGENTS.md, "One call uploads a drop").
 */
import { z } from "zod";
import { ApiError } from "../errors.js";
import { parseFaultPoint } from "../operations/publish.js";
import { commitSession, createSession, putStagedBlob } from "../operations/uploads.js";
import type { CommitInput, PutInput, SessionInput, UploadContext } from "../operations/uploads.js";
import { describeIssues } from "./fields.js";
import type { Operation, OperationContext } from "./types.js";

const manifestEntry = z.strictObject({
  path: z.string(),
  size: z.number(),
  sha256: z.string(),
  /** A public http(s) URL the instance fetches at commit, instead of a PUT. */
  url: z.string().optional(),
});

export const uploadCreateSchema = z.strictObject({
  target: z.string().optional(),
  manifest: z.array(manifestEntry),
  idempotency_key: z.string().min(1).optional(),
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
  id: z.string(),
  title: z.string().nullable().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
  password: z.union([z.string(), z.null()]).optional(),
  expires: z.string().optional(),
  noindex: z.boolean().optional(),
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
  restOnly: true,
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
  restOnly: true,
  handler: async (input, ctx) => {
    const { id, ...settings } = input;
    const result = await commitSession(id, settings, uploadContext(ctx));
    return { value: result.drop, status: result.created ? 201 : 200 };
  },
};
