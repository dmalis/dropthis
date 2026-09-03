/**
 * The URL form of a drop path (docs/spec-v1.md, "URL form").
 *
 * A manifest path is text; a URL path is bytes with a grammar. The rule that
 * keeps the two in step is: encode per segment, decode per segment, exactly
 * once. An encoded separator (`%2F`) is therefore never a way to smuggle a
 * second segment past validation — it is simply not found.
 */
import { normalizeDropPath, PathError } from "./paths.js";

/** The path as it appears in a generated URL: separators intact, names escaped. */
export function encodePathForUrl(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment).replace(/[!'()*]/g, hexEscape))
    .join("/");
}

function hexEscape(character: string): string {
  return `%${character.charCodeAt(0).toString(16).toUpperCase()}`;
}

/**
 * The manifest path a request is asking for, or `null` when the request cannot
 * name one — a malformed escape, invalid UTF-8, an encoded separator, or a
 * path a manifest could never hold. `null` is a 404: the viewer never explains
 * which of those it was.
 */
export function decodeRequestPath(encoded: string): string | null {
  const segments: string[] = [];
  for (const segment of encoded.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (decoded.includes("/")) return null;
    segments.push(decoded);
  }

  try {
    return normalizeDropPath(segments.join("/"));
  } catch (error) {
    if (error instanceof PathError) return null;
    throw error;
  }
}
