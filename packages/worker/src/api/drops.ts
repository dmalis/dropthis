/**
 * The REST surface of the drop operations (docs/spec-v1.md, "REST route
 * table"). Success responses are the object itself, `201` on create.
 *
 * The routes are thin on purpose: read the body, resolve the caller and the
 * config, call the operation, serialise. Every rule lives below this file, so
 * the CLI and the MCP tools reach the same behaviour without going through HTTP.
 */
import { Hono } from "hono";
import type { Env } from "../bindings.js";
import { decodeRequestPath } from "../domain/url-path.js";
import { isSlug } from "../domain/slug.js";
import { ApiError } from "../errors.js";
import { loadInstanceConfig } from "../instance-config.js";
import { attribution, resolveCaller } from "../auth/caller.js";
import { getDrop, loadDrop } from "../operations/get.js";
import { publish } from "../operations/publish.js";
import { parsePublishInput } from "../registry/publish.js";
import { blobKey } from "../storage/keys.js";
import { errorResponse } from "./errors.js";
import type { DevHooks } from "../dev/hooks.js";
import { serveBlob } from "../serve.js";

export function dropRoutes(hooks: DevHooks) {
  const routes = new Hono<{ Bindings: Env }>();

  routes.onError((error, c) => errorResponse(c, error));

  routes.post("/drops", async (c) => {
    const config = await loadInstanceConfig(c.env.BUCKET, c.req.url);
    const body = await readJsonBody(c.req.raw, config.policy.max_request_bytes);

    const result = await publish(parsePublishInput(body), {
      bucket: c.env.BUCKET,
      config,
      caller: attribution(resolveCaller(c.req.raw, c.env)),
      now: hooks.now(c.env),
      secret: requireSecret(c.env),
      fault: hooks.faultPoint(c.req.raw, c.env),
    });

    return c.json(result.drop, result.created ? 201 : 200);
  });

  routes.get("/drops/:slug", async (c) => {
    const slug = c.req.param("slug");
    if (!isSlug(slug)) throw new ApiError("NOT_FOUND", `No drop at ${slug}.`);

    const drop = await getDrop(slug, {
      bucket: c.env.BUCKET,
      config: await loadInstanceConfig(c.env.BUCKET, c.req.url),
      now: hooks.now(c.env),
      files: c.req.query("files") === "true",
    });
    return c.json(drop);
  });

  // The `download_url` of a binary or over-budget file. Range is supported so a
  // large file can be fetched in pieces by an ordinary HTTP client.
  routes.get("/drops/:slug/files/*", async (c) => {
    const slug = c.req.param("slug");
    if (!isSlug(slug)) throw new ApiError("NOT_FOUND", `No drop at ${slug}.`);

    const encoded = new URL(c.req.url).pathname.split(`/_api/v1/drops/${slug}/files/`)[1] ?? "";
    const path = decodeRequestPath(encoded);
    if (path === null) throw new ApiError("NOT_FOUND", "No such file in this drop.");

    const loaded = await loadDrop(c.env.BUCKET, slug);
    if (loaded === null) throw new ApiError("NOT_FOUND", `No drop at ${slug}.`);

    const entry = loaded.meta.manifest[path];
    if (entry === undefined) throw new ApiError("NOT_FOUND", "No such file in this drop.");

    return serveBlob(c.env.BUCKET, blobKey(loaded.dropId, entry.sha256), entry, {
      range: c.req.header("Range"),
      disposition: c.req.query("download") === "1" ? "attachment" : "inline",
      filename: path.slice(path.lastIndexOf("/") + 1),
    });
  });

  return routes;
}

function requireSecret(env: Env): string {
  if (typeof env.HMAC_SECRET !== "string" || env.HMAC_SECRET.length === 0) {
    throw new ApiError("INTERNAL", "This instance has no HMAC_SECRET; redeploy it.");
  }
  return env.HMAC_SECRET;
}

/**
 * The body, refused before it is parsed when it is over the instance's
 * `max_request_bytes`. The declared length is checked first so an oversized
 * call costs nothing; the read is then bounded anyway, because a client may
 * lie or stream without a length.
 */
async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ApiError(
      "PAYLOAD_TOO_LARGE",
      `The request body is ${declared} bytes; this instance accepts ${maxBytes}.`,
    );
  }

  const raw = await request.text();
  if (raw.length > maxBytes) {
    throw new ApiError(
      "PAYLOAD_TOO_LARGE",
      `The request body is ${raw.length} bytes; this instance accepts ${maxBytes}.`,
    );
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ApiError("INVALID_INPUT", "The request body is not valid JSON.");
  }
}
