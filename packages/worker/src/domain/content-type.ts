/**
 * The frozen extension → content type table (docs/spec-v1.md, "Content type").
 *
 * Frozen means exactly that: the bytes a visitor receives for `report.pdf` must
 * not change with a library upgrade, so dropthis never sniffs content and never
 * consults a mime database. An unknown extension is `application/octet-stream`,
 * which downloads rather than executes — the safe answer for a shared origin.
 */

const EXTENSION_TYPES: Readonly<Record<string, string>> = {
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  json: "application/json",
  map: "application/json",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  xml: "application/xml",
  svg: "image/svg+xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
};

export const DEFAULT_CONTENT_TYPE = "application/octet-stream";

/** The extension of the last segment, lower-cased; `null` for a dotfile or none. */
function extensionOf(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return name.slice(dot + 1).toLowerCase();
}

export function contentTypeForPath(path: string): string {
  const extension = extensionOf(path);
  if (extension === null) return DEFAULT_CONTENT_TYPE;
  return EXTENSION_TYPES[extension] ?? DEFAULT_CONTENT_TYPE;
}

/**
 * Whether `get(files: true)` may inline this file's bytes as a string, and the
 * viewer may treat them as text: `text/*`, JSON, JavaScript, XML, SVG and any
 * `+json` / `+xml` structured suffix.
 */
export function isTextTyped(contentType: string): boolean {
  const type = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (type.startsWith("text/")) return true;
  if (type.endsWith("+json") || type.endsWith("+xml")) return true;
  return (
    type === "application/json" ||
    type === "application/javascript" ||
    type === "application/xml" ||
    type === "image/svg+xml"
  );
}

/**
 * The content type of a `{path, text}` entry, or `null` when the extension
 * names a binary type — sending bytes as text for a `.png` is a mistake the
 * caller must see (`INVALID_INPUT`), not something to guess around.
 */
export function textEntryContentType(path: string): string | null {
  const extension = extensionOf(path);
  if (extension === null) return "text/plain";
  const declared = EXTENSION_TYPES[extension];
  if (declared === undefined) return "text/plain";
  return isTextTyped(declared) ? declared : null;
}

/**
 * The `Content-Type` header for a stored file's bytes.
 *
 * The manifest holds the bare type from the frozen table, because that value is
 * hashed into the drop's state and handed back in `Drop.files[]`. The charset
 * is a serving decision and lives here: dropthis assumes UTF-8 (AGENTS.md,
 * "Non-goals" — no charset detection), and a browser given `text/html` with no
 * charset falls back to a legacy encoding and renders `·` as `Â·`.
 *
 * Only text-typed files get it — the same set `get(files: true)` will inline as
 * a string, so "what dropthis treats as UTF-8 text" is one answer, not two. A
 * type that already carries a `charset` parameter is left exactly as it is.
 */
export function servedContentType(contentType: string): string {
  if (/;\s*charset=/i.test(contentType)) return contentType;
  return isTextTyped(contentType) ? `${contentType}; charset=utf-8` : contentType;
}
