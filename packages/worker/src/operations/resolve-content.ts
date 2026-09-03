/**
 * Step 0 of the write order: turn the caller's inline entries into bytes, a
 * digest per file, and the manifest (AGENTS.md, "Writes and idempotency").
 *
 * Content is resolved BEFORE anything is written, so a payload that cannot be
 * decoded costs no R2 write and leaves no half-made drop. Blobs are
 * content-addressed, so two paths holding the same bytes are one blob.
 *
 * Base64 is decoded with `Uint8Array.fromBase64` where the runtime has it. That
 * is not a micro-optimisation: the measured 4 MiB inline ceiling
 * (docs/research/2026-09-03-free-plan-measurements.md) holds only with the
 * native decode — the portable `atob` loop passed the same size 2 times in 10.
 */
import { contentTypeForPath, textEntryContentType } from "../domain/content-type.js";
import { sha256Hex } from "../domain/meta.js";
import type { Manifest } from "../domain/meta.js";
import { normalizeManifestPaths, PathError } from "../domain/paths.js";
import { ApiError } from "../errors.js";
import type { PublishFile } from "../registry/publish.js";

export type ResolvedFile = {
  path: string;
  bytes: Uint8Array<ArrayBuffer>;
  sha256: string;
  contentType: string;
};

export type ResolvedContent = {
  files: ResolvedFile[];
  /** One entry per distinct digest: exactly the blobs that must be written. */
  blobs: Map<string, Uint8Array<ArrayBuffer>>;
  manifest: Manifest;
};

const encoder = new TextEncoder();

type Base64Api = { fromBase64?: (text: string) => Uint8Array<ArrayBufferLike> };

function decodeBase64(text: string, path: string): Uint8Array<ArrayBuffer> {
  try {
    const native = (Uint8Array as unknown as Base64Api).fromBase64;
    if (native !== undefined) {
      const decoded = native(text);
      return new Uint8Array(decoded.buffer as ArrayBuffer, decoded.byteOffset, decoded.byteLength);
    }
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    throw new ApiError("INVALID_INPUT", `The base64 of ${JSON.stringify(path)} is not valid base64.`);
  }
}

export async function resolveInlineFiles(entries: readonly PublishFile[]): Promise<ResolvedContent> {
  let paths: string[];
  try {
    paths = normalizeManifestPaths(entries.map((entry) => entry.path));
  } catch (error) {
    if (error instanceof PathError) throw new ApiError("INVALID_PATH", error.message);
    throw error;
  }

  const files: ResolvedFile[] = [];
  const blobs = new Map<string, Uint8Array<ArrayBuffer>>();
  const manifest: Manifest = {};

  for (const [index, entry] of entries.entries()) {
    const path = paths[index]!;
    let bytes: Uint8Array<ArrayBuffer>;
    let contentType: string;

    if ("text" in entry) {
      const declared = textEntryContentType(path);
      if (declared === null) {
        throw new ApiError(
          "INVALID_INPUT",
          `${JSON.stringify(path)} names a binary type, so its bytes must be sent as base64, not text.`,
        );
      }
      bytes = encoder.encode(entry.text);
      contentType = declared;
    } else {
      bytes = decodeBase64(entry.base64, path);
      contentType = contentTypeForPath(path);
    }

    const digest = await sha256Hex(bytes);
    if ("sha256" in entry && entry.sha256 !== undefined && entry.sha256 !== digest) {
      throw new ApiError(
        "HASH_MISMATCH",
        `The bytes of ${JSON.stringify(path)} hash to ${digest}, not the sha256 sent with them.`,
      );
    }
    files.push({ path, bytes, sha256: digest, contentType });
    blobs.set(digest, bytes);
    manifest[path] = { sha256: digest, size: bytes.length, content_type: contentType };
  }

  return { files, blobs, manifest };
}
