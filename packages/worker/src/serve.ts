/**
 * Serving one file's bytes, on both read paths — the viewer and the
 * authenticated `download_url`.
 *
 * Every header is rebuilt from the manifest and the request; nothing is taken
 * from the stored object. The manifest is the truth about a file's type and
 * size, so a byte range is validated against it before R2 is asked for
 * anything.
 *
 * `Cache-Control: no-cache, must-revalidate` is not a performance oversight: an
 * update or an expiry has to be visible on the visitor's very next request.
 */
import type { Bucket } from "./bindings.js";
import { servedContentType } from "./domain/content-type.js";
import type { ManifestEntry } from "./domain/meta.js";

export const VIEWER_CACHE_CONTROL = "no-cache, must-revalidate";

export type ServeOptions = {
  range?: string | undefined;
  disposition: "inline" | "attachment";
  filename: string;
};

type ParsedRange = { offset: number; length: number } | "unsatisfiable" | null;

/**
 * A single `bytes=` range, the only form worth supporting: multipart ranges
 * would mean building a multipart body in the Worker for no real client.
 * Anything else is ignored and the whole file is sent, which is legal.
 */
export function parseRange(header: string | undefined, size: number): ParsedRange {
  if (header === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return null;

  const [, startText, endText] = match;
  if (startText === "" && endText === "") return null;

  if (startText === "") {
    const suffix = Number(endText);
    if (suffix === 0) return "unsatisfiable";
    const offset = Math.max(0, size - suffix);
    return { offset, length: size - offset };
  }

  const offset = Number(startText);
  if (offset >= size) return "unsatisfiable";
  const end = endText === "" ? size - 1 : Math.min(Number(endText), size - 1);
  if (end < offset) return "unsatisfiable";
  return { offset, length: end - offset + 1 };
}

export async function serveBlob(
  bucket: Bucket,
  key: string,
  entry: ManifestEntry,
  options: ServeOptions,
): Promise<Response> {
  const range = parseRange(options.range, entry.size);

  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: {
        "Content-Range": `bytes */${entry.size}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": VIEWER_CACHE_CONTROL,
      },
    });
  }

  const object = await bucket.get(key, range === null ? {} : { range });
  if (object === null) {
    // The manifest names a blob that is not there. That is a broken drop, not a
    // missing file, and the reconcile is what fixes it.
    return new Response(null, { status: 404, headers: { "Cache-Control": VIEWER_CACHE_CONTROL } });
  }

  const headers = new Headers({
    // UTF-8 is declared here, not stored in the manifest: the manifest type is
    // hashed into the drop's state and returned in `Drop.files[]`.
    "Content-Type": servedContentType(entry.content_type),
    "Content-Disposition": `${options.disposition}; filename="${sanitizeFilename(options.filename)}"`,
    "Cache-Control": VIEWER_CACHE_CONTROL,
    "Accept-Ranges": "bytes",
  });

  if (range === null) {
    headers.set("Content-Length", String(entry.size));
    return new Response(object.body, { status: 200, headers });
  }

  headers.set("Content-Length", String(range.length));
  headers.set(
    "Content-Range",
    `bytes ${range.offset}-${range.offset + range.length - 1}/${entry.size}`,
  );
  return new Response(object.body, { status: 206, headers });
}

/** A quoted filename cannot carry a quote, a backslash or a line break. */
function sanitizeFilename(name: string): string {
  return name.replace(/[\\"\u0000-\u001F\u007F]/g, "_");
}
