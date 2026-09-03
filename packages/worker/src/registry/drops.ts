/**
 * The registry entries for `health` and the drop operations.
 *
 * Each entry is the whole definition of an operation: where it sits on the
 * wire, the scope it needs, the schema its input must satisfy and the handler
 * that does the work. `update`, `list` and `delete` are declared with their
 * frozen route and scope but no handler — issue #5 owns their schemas and
 * their behaviour, and wiring them is one line each.
 */
import { z } from "zod";
import { attribution } from "../auth/caller.js";
import { decodeRequestPath } from "../domain/url-path.js";
import { isSlug } from "../domain/slug.js";
import { ApiError } from "../errors.js";
import { getDrop, loadDrop } from "../operations/get.js";
import { publish } from "../operations/publish.js";
import { serveBlob } from "../serve.js";
import { blobKey } from "../storage/keys.js";
import { boolParam } from "./params.js";
import { parsePublishInput, publishSchema } from "./publish.js";
import type { PublishInput } from "./publish.js";
import type { Operation } from "./types.js";

/** Declared but not implemented here; issue #5 supplies schema and handler. */
const PENDING = z.unknown();

const slugParam = z.string();

const getSchema = z.strictObject({
  slug: slugParam,
  files: boolParam.optional(),
});

const downloadSchema = z.strictObject({
  slug: slugParam,
  download: z.union([z.literal("1"), z.literal("0")]).optional(),
});

function requireSlug(slug: string): string {
  if (!isSlug(slug)) throw new ApiError("NOT_FOUND", `No drop at ${slug}.`);
  return slug;
}

export const health: Operation<Record<string, never>> = {
  name: "health",
  method: "GET",
  path: "/health",
  scope: "public",
  summary: "Answer whether this instance is alive.",
  schema: z.strictObject({}) as unknown as z.ZodType<Record<string, never>>,
  handler: async () => ({ value: { ok: true } }),
};

export const publishOp: Operation<PublishInput> = {
  name: "publish",
  method: "POST",
  path: "/drops",
  scope: "user",
  summary: "Publish files as a new drop and return its permanent URL.",
  schema: publishSchema,
  parse: parsePublishInput,
  handler: async (input, ctx) => {
    const result = await publish(input, {
      bucket: ctx.bucket,
      config: ctx.config,
      caller: attribution(ctx.caller),
      now: ctx.now,
      secret: ctx.secret(),
      fault: ctx.hooks.faultPoint(ctx.request, ctx.env),
    });
    return { value: result.drop, status: result.created ? 201 : 200 };
  },
};

export const updateOp: Operation<unknown> = {
  name: "update",
  method: "PATCH",
  path: "/drops/:slug",
  scope: "user",
  summary: "Change only the fields given; files replace the whole set.",
  schema: PENDING,
  params: ["slug"],
};

export const getOp: Operation<z.infer<typeof getSchema>> = {
  name: "get",
  method: "GET",
  path: "/drops/:slug",
  scope: "user",
  summary: "Read a drop; with files, its text content comes back inline.",
  schema: getSchema,
  params: ["slug"],
  query: ["files"],
  handler: async (input, ctx) => ({
    value: await getDrop(requireSlug(input.slug), {
      bucket: ctx.bucket,
      config: ctx.config,
      now: ctx.now,
      files: input.files === true,
    }),
  }),
};

export const listOp: Operation<unknown> = {
  name: "list",
  method: "GET",
  path: "/drops",
  scope: "user",
  summary: "One page of this instance's drops, newest first.",
  schema: PENDING,
  query: ["cursor", "limit", "q"],
};

export const deleteOp: Operation<unknown> = {
  name: "delete",
  method: "DELETE",
  path: "/drops/:slug",
  scope: "user",
  summary: "Delete a drop and its files immediately.",
  schema: PENDING,
  params: ["slug"],
  status: 204,
};

export const fileDownload: Operation<z.infer<typeof downloadSchema>> = {
  name: "file_download",
  method: "GET",
  path: "/drops/:slug/files/*",
  scope: "user",
  summary: "Fetch one file of a drop, with Range support.",
  schema: downloadSchema,
  params: ["slug"],
  query: ["download"],
  restOnly: true,
  handler: async (input, ctx) => {
    const slug = requireSlug(input.slug);

    // The wildcard segment is the file path, and it is the one input the
    // router cannot fold in: Hono does not name a `*` parameter, and the path
    // must be decoded exactly once, from the raw URL.
    const encoded =
      new URL(ctx.request.url).pathname.split(`/_api/v1/drops/${slug}/files/`)[1] ?? "";
    const path = decodeRequestPath(encoded);
    if (path === null) throw new ApiError("NOT_FOUND", "No such file in this drop.");

    const loaded = await loadDrop(ctx.bucket, slug);
    if (loaded === null) throw new ApiError("NOT_FOUND", `No drop at ${slug}.`);

    const entry = loaded.meta.manifest[path];
    if (entry === undefined) throw new ApiError("NOT_FOUND", "No such file in this drop.");

    const range = ctx.request.headers.get("Range");
    return serveBlob(ctx.bucket, blobKey(loaded.dropId, entry.sha256), entry, {
      ...(range === null ? {} : { range }),
      disposition: input.download === "1" ? "attachment" : "inline",
      filename: path.slice(path.lastIndexOf("/") + 1),
    });
  },
};
