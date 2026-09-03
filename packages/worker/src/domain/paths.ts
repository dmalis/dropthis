/**
 * Drop paths: the rules a file path must satisfy before it can enter a
 * manifest (docs/spec-v1.md, "Upload payload").
 *
 * A drop path is relative, `/`-separated and NFC-normalised. NFC is what makes
 * the manifest a map at all: the viewer normalises the requested path the same
 * way, so "café.txt" typed two ways resolves to one blob, and two spellings of
 * one name inside a single call are a duplicate, not two files.
 *
 * Every rejection is `INVALID_PATH` at the API boundary; here it is a
 * `PathError` carrying a message that names the offending path.
 */

const MAX_SEGMENT_BYTES = 255;
const MAX_PATH_BYTES = 1024;
/** C0, DEL and C1: never legitimate in a file name, and invisible in a URL. */
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/;

const encoder = new TextEncoder();

export class PathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathError";
  }
}

/** The path as it appears in an error message: quoted, escaped, bounded. */
function show(raw: string): string {
  const clipped = raw.length > 120 ? `${raw.slice(0, 120)}…` : raw;
  return JSON.stringify(clipped);
}

export function normalizeDropPath(raw: string): string {
  if (CONTROL_CHARACTERS.test(raw)) {
    throw new PathError(`Path ${show(raw)} contains a control character.`);
  }
  if (raw.includes("\\")) {
    throw new PathError(`Path ${show(raw)} contains a backslash; use forward slashes.`);
  }

  const path = raw.normalize("NFC");
  if (path.length === 0) throw new PathError("Path is empty.");

  for (const segment of path.split("/")) {
    if (segment.length === 0) {
      throw new PathError(
        `Path ${show(raw)} has an empty segment; it must be relative with no repeated or trailing slash.`,
      );
    }
    if (segment === "." || segment === "..") {
      throw new PathError(`Path ${show(raw)} contains a "." or ".." segment.`);
    }
    if (encoder.encode(segment).length > MAX_SEGMENT_BYTES) {
      throw new PathError(`Path ${show(raw)} has a segment over ${MAX_SEGMENT_BYTES} bytes.`);
    }
  }

  if (encoder.encode(path).length > MAX_PATH_BYTES) {
    throw new PathError(`Path ${show(raw)} is over ${MAX_PATH_BYTES} bytes.`);
  }
  return path;
}

/**
 * Normalise every path of one call and prove they name different files.
 * Order is preserved: the manifest is presented in the caller's order and the
 * inline-content budget of `get(files:true)` is spent in that order.
 */
export function normalizeManifestPaths(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const entry of raw) {
    const path = normalizeDropPath(entry);
    if (seen.has(path)) {
      throw new PathError(`Path ${show(entry)} appears twice after NFC normalisation.`);
    }
    seen.add(path);
    paths.push(path);
  }
  return paths;
}
