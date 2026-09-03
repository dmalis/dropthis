/**
 * The registry entries for `health` and the drop operations.
 *
 * Each entry is the whole definition of an operation: where it sits on the
 * wire, the scope it needs, the schema its input must satisfy and the handler
 * that does the work. The five drop operations of AGENTS.md's operation table
 * are all here; the router mounts them and nothing else.
 *
 * A path parameter is folded into the same input object as the body, so the
 * schemas that read one declare it (`slug`). It is validated FIRST, before the
 * body: a call aimed at a slug that cannot exist is `NOT_FOUND` whatever it
 * carries.
 */
import { z } from "zod";
import { attribution } from "../auth/caller.js";
import { decodeRequestPath } from "../domain/url-path.js";
import { isSlug } from "../domain/slug.js";
import { ApiError } from "../errors.js";
import { deleteDrop } from "../operations/delete.js";
import { getDrop, loadDrop } from "../operations/get.js";
import { listDrops } from "../operations/list.js";
import { parseFaultPoint, publish } from "../operations/publish.js";
import { updateDrop } from "../operations/update.js";
import { serveBlob } from "../serve.js";
import { blobKey } from "../storage/keys.js";
import { listSchema, parseListInput } from "./list.js";
import type { ListInput } from "./list.js";
import { boolParam } from "./params.js";
import { parsePublishInput, publishSchema } from "./publish.js";
import type { PublishInput } from "./publish.js";
import { parseUpdateInput, updateSchema } from "./update.js";
import type { Operation } from "./types.js";

const slugParam = z.string();

const updateRequestSchema = updateSchema.extend({ slug: slugParam });

type UpdateRequest = z.infer<typeof updateRequestSchema>;

const deleteSchema = z.strictObject({ slug: slugParam });

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
      fault: parseFaultPoint(ctx.hooks.fault(ctx.request, ctx.env)),
    });
    return { value: result.drop, status: result.created ? 201 : 200 };
  },
};

export const updateOp: Operation<UpdateRequest> = {
  name: "update",
  method: "PATCH",
  path: "/drops/:slug",
  scope: "user",
  summary: "Change only the fields given; files replace the whole set.",
  schema: updateRequestSchema,
  parse: (raw) => {
    const { slug, ...body } = (raw ?? {}) as Record<string, unknown>;
    return { slug: requireSlug(typeof slug === "string" ? slug : ""), ...parseUpdateInput(body) };
  },
  params: ["slug"],
  handler: async (input, ctx) => {
    const { slug, ...body } = input;
    return {
      value: await updateDrop(slug, body, {
        bucket: ctx.bucket,
        config: ctx.config,
        caller: attribution(ctx.caller),
        now: ctx.now,
        secret: ctx.secret(),
        fault: parseFaultPoint(ctx.hooks.fault(ctx.request, ctx.env)),
      }),
    };
  },
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

export const listOp: Operation<ListInput> = {
  name: "list",
  method: "GET",
  path: "/drops",
  scope: "user",
  summary: "One page of this instance's drops, newest first.",
  schema: listSchema,
  parse: parseListInput,
  query: ["cursor", "limit", "q"],
  handler: async (input, ctx) => ({
    value: await listDrops(input, { bucket: ctx.bucket, config: ctx.config, now: ctx.now }),
  }),
};

export const deleteOp: Operation<z.infer<typeof deleteSchema>> = {
  name: "delete",
  method: "DELETE",
  path: "/drops/:slug",
  scope: "user",
  summary: "Delete a drop and its files immediately.",
  schema: deleteSchema,
  params: ["slug"],
  status: 204,
  // `204` whether or not the drop was there, and whether or not the target
  // could ever have been a slug: an agent that never saw the first response
  // must be able to send the call again without telling "gone" from
  // "was never here".
  handler: async (input, ctx) => {
    if (isSlug(input.slug)) await deleteDrop(ctx.bucket, input.slug);
    return { value: null };
  },
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
