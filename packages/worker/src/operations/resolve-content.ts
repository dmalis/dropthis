/**
 * Step 0 of the write order: turn the caller's entries into bytes, a digest
 * per file, and the manifest (AGENTS.md, "Writes and idempotency").
 *
 * Content is resolved BEFORE anything reachable is written, so a payload that
 * cannot be decoded — or a URL that cannot be fetched — costs no `meta.json`
 * and leaves no half-made drop. Blobs are content-addressed, so two paths
 * holding the same bytes are one blob.
 *
 * Three entry kinds, never guessed from the bytes:
 *
 *   {path, text}            decoded here, typed from the extension table
 *   {path, base64, sha256?} decoded here; a digest the caller sent is checked
 *   {path, url, sha256?}    FETCHED here. With a digest the body streams
 *                           straight to R2 and R2 verifies it, so the Worker
 *                           spends no CPU on the bytes; without one the Worker
 *                           must hash in-stream and refuses above
 *                           `max_unhashed_bytes`.
 *   {path, sha256}          KEEP: the blob this drop already holds under that
 *                           digest. Nothing is sent, fetched or written — the
 *                           new manifest points at what is already there
 *                           (decision #95). `update` only; `publish` refuses
 *                           the kind before it reaches this file.
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
import { StorageError } from "../storage/r2.js";
import { INITIAL_POLICY } from "../policy/defaults.js";
import type { ResolvedPolicy } from "../instance-config.js";
import type { PublishFile } from "../registry/publish.js";
import { fetchPublicUrl, newFetchBudget } from "./fetch-url.js";
import type { FetchBudget } from "./fetch-url.js";

export type ResolvedFile = {
  path: string;
  /** Absent for a body streamed to R2: those bytes never sit in the isolate. */
  bytes?: Uint8Array<ArrayBuffer>;
  sha256: string;
  contentType: string;
};

export type ResolvedContent = {
  files: ResolvedFile[];
  /** One entry per distinct digest the CALLER must still write from memory. */
  blobs: Map<string, Uint8Array<ArrayBuffer>>;
  manifest: Manifest;
};

/**
 * `streamBlob` is how a fetched body reaches its final key without being
 * buffered: the caller owns the drop id, so it owns the key. `held` names the
 * digests the drop already stores — those are neither fetched nor written
 * again, which is what makes "one file changed in a ten-image drop" cost one
 * fetch. `current` is the drop's manifest as it stands, which is what a keep
 * entry resolves against: same path and same digest means the recorded size
 * and content type carry over exactly, so a kept file is served the way it was.
 */
export type ResolveOptions = {
  policy?: ResolvedPolicy;
  held?: ReadonlyMap<string, number>;
  current?: Manifest | undefined;
  streamBlob?: (
    sha256: string,
    body: ReadableStream<Uint8Array> | Uint8Array<ArrayBuffer>,
  ) => Promise<number | undefined>;
  fetchImpl?: typeof fetch;
  budget?: FetchBudget;
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

export async function resolveFiles(
  entries: readonly PublishFile[],
  options: ResolveOptions = {},
): Promise<ResolvedContent> {
  const policy = options.policy ?? (INITIAL_POLICY as unknown as ResolvedPolicy);
  const budget = options.budget ?? newFetchBudget();
  const current = options.current ?? {};
  const held =
    options.held ??
    new Map<string, number>(
      Object.values(current).map((entry) => [entry.sha256, entry.size] as const),
    );

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

    if ("url" in entry) {
      const file = await resolveUrlEntry(entry, path, { policy, budget, held, ...options });
      if (file.bytes !== undefined) blobs.set(file.sha256, file.bytes);
      files.push(file);
      manifest[path] = { sha256: file.sha256, size: file.size, content_type: file.contentType };
      continue;
    }

    if (!("text" in entry) && !("base64" in entry)) {
      const file = keepEntry(entry, path, current, held);
      files.push(file);
      manifest[path] = { sha256: file.sha256, size: file.size, content_type: file.contentType };
      continue;
    }

    let bytes: Uint8Array<ArrayBuffer>;
    let contentType: string;
    if ("text" in entry) {
      const declared = textEntryContentType(path);
      if (declared === null) {
        throw new ApiError(
          "INVALID_INPUT",
          `${JSON.stringify(path)} names a binary type, so its bytes must be sent as base64 or fetched from a url, not text.`,
        );
      }
      bytes = encoder.encode(entry.text);
      contentType = declared;
    } else {
      bytes = decodeBase64(entry.base64, path);
      contentType = contentTypeForPath(path);
    }

    const digest = await sha256Hex(bytes);
    const sent = "sha256" in entry ? entry.sha256 : undefined;
    if (sent !== undefined && sent !== digest) {
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

/**
 * A keep entry. The drop is the scope: blobs are content-addressed PER drop, so
 * a digest another drop holds is not held here, and the refusal names both the
 * path and the hash — an agent that sent a stale `get` has to see which file.
 *
 * Same path, same digest → the recorded size AND content type carry over. A
 * kept blob under a NEW path is typed from the extension table, exactly as any
 * other entry at that path would be.
 */
function keepEntry(
  entry: { path: string; sha256: string },
  path: string,
  current: Manifest,
  held: ReadonlyMap<string, number>,
): ResolvedFile & { size: number } {
  const at = current[path];
  if (at !== undefined && at.sha256 === entry.sha256) {
    return { path, sha256: at.sha256, contentType: at.content_type, size: at.size };
  }
  const size = held.get(entry.sha256);
  if (size === undefined) {
    throw new ApiError(
      "INVALID_INPUT",
      `This drop holds no file with sha256 ${entry.sha256}, so ${JSON.stringify(path)} cannot be kept. Send its bytes, or read the current digests with get.`,
    );
  }
  return { path, sha256: entry.sha256, contentType: contentTypeForPath(path), size };
}

type UrlEntry = Extract<PublishFile, { url: string }>;
type UrlContext = Required<Pick<ResolveOptions, "policy" | "budget" | "held">> & ResolveOptions;

async function resolveUrlEntry(
  entry: UrlEntry,
  path: string,
  ctx: UrlContext,
): Promise<ResolvedFile & { size: number }> {
  const contentType = contentTypeForPath(path);
  const { policy } = ctx;

  // A digest the drop already holds is the whole point of content addressing:
  // nothing is fetched, nothing is written, and the manifest is unchanged.
  if (entry.sha256 !== undefined) {
    const size = ctx.held.get(entry.sha256);
    if (size !== undefined) {
      return { path, sha256: entry.sha256, contentType, size };
    }
  }

  const response = await fetchPublicUrl(entry.url, {
    budget: ctx.budget,
    ...(ctx.fetchImpl === undefined ? {} : { fetchImpl: ctx.fetchImpl }),
  });

  const declared = contentLength(response);
  if (declared !== undefined) tooLarge(entry.url, declared, policy.max_file_bytes);
  if (response.body === null) {
    throw new ApiError("FETCH_FAILED", `${entry.url} answered with no body.`);
  }

  // With a digest and a writer, the bytes go straight to their final key and
  // R2 verifies them — the Worker never sees them.
  if (entry.sha256 !== undefined && ctx.streamBlob !== undefined) {
    const size = await streamToBlob(response, entry.url, entry.sha256, {
      policy,
      streamBlob: ctx.streamBlob,
      declaredSize: entry.size,
    });
    return { path, sha256: entry.sha256, contentType, size };
  }

  // Otherwise the Worker holds the bytes: capped at `max_unhashed_bytes` when
  // it must hash them itself, at `max_file_bytes` when it only carries them.
  const cap = entry.sha256 === undefined ? policy.max_unhashed_bytes : policy.max_file_bytes;
  const bytes = await readCapped(response.body as ReadableStream<Uint8Array>, cap, entry.url, {
    unhashed: entry.sha256 === undefined,
  });
  const digest = await sha256Hex(bytes);
  if (entry.sha256 !== undefined && entry.sha256 !== digest) {
    throw new ApiError(
      "HASH_MISMATCH",
      `${entry.url} hashes to ${digest}, not the sha256 sent with it.`,
    );
  }
  return { path, bytes, sha256: digest, contentType, size: bytes.length };
}

/**
 * Send a fetched body to its final blob key, letting R2 verify the digest.
 *
 * R2 refuses a stream whose length it does not know — "Provided readable stream
 * must have a known length (request/response body or readable half of
 * FixedLengthStream)", measured against remote R2 on 2026-09-03 — and a drop's
 * own viewer does not always send `Content-Length`. So there are three ways to
 * give R2 a length, in this order:
 *
 *   1. the caller's `size`, wrapped in a `FixedLengthStream`. A body that turns
 *      out shorter or longer errors that stream, the put fails and the key
 *      stays absent: `HASH_MISMATCH`, the same answer a wrong digest gets;
 *   2. the response's own `Content-Length`, streamed through untouched;
 *   3. nothing — the Worker buffers, and `max_unhashed_bytes` is the cap,
 *      because holding those bytes is exactly what that limit bounds.
 *
 * Shared by `publish`/`update` and the staged commit, which fetches a `url`
 * manifest entry the client never uploaded.
 */
function contentLength(response: Response): number | undefined {
  const raw = response.headers.get("content-length");
  if (raw === null || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

export async function streamToBlob(
  response: Response,
  url: string,
  sha256: string,
  ctx: {
    policy: ResolvedPolicy;
    streamBlob: (
      sha256: string,
      body: ReadableStream<Uint8Array> | Uint8Array<ArrayBuffer>,
    ) => Promise<number | undefined>;
    declaredSize?: number | undefined;
  },
): Promise<number> {
  if (response.body === null) throw new ApiError("FETCH_FAILED", `${url} answered with no body.`);
  const body = response.body as ReadableStream<Uint8Array>;

  if (ctx.declaredSize !== undefined) {
    tooLarge(url, ctx.declaredSize, ctx.policy.max_file_bytes);
    const fixed = fixedLength(ctx.declaredSize);
    if (fixed !== null) {
      // The pipe is NOT awaited before the put: R2 reads the readable half as
      // the body arrives, so awaiting here would deadlock. Its rejection is
      // absorbed — the put fails with the same error, and that is the one the
      // caller sees.
      void body.pipeTo(fixed.writable).catch(() => {});
      const written = await asHashMismatch(url, ctx.declaredSize, () =>
        ctx.streamBlob(sha256, fixed.readable),
      );
      return written ?? ctx.declaredSize;
    }
    // No `FixedLengthStream` (Node, under the unit tests): buffer and check the
    // length ourselves, so the same call answers the same way.
    const bytes = await readCapped(body, ctx.policy.max_file_bytes, url, { unhashed: false });
    if (bytes.length !== ctx.declaredSize) {
      throw new ApiError(
        "HASH_MISMATCH",
        `${url} answered ${bytes.length} bytes, not the ${ctx.declaredSize} sent with it.`,
      );
    }
    return (await ctx.streamBlob(sha256, bytes)) ?? bytes.length;
  }

  // `Number("")` is 0, so an ABSENT header must be told from a zero-length one:
  // a body of unknown length is exactly what R2 refuses.
  const header = contentLength(response);
  if (header !== undefined) {
    tooLarge(url, header, ctx.policy.max_file_bytes);
    return (await ctx.streamBlob(sha256, body)) ?? header;
  }

  const bytes = await readCapped(body, ctx.policy.max_unhashed_bytes, url, { unhashed: true });
  return (await ctx.streamBlob(sha256, bytes)) ?? bytes.length;
}

function tooLarge(url: string, size: number, max: number): void {
  if (size > max) {
    throw new ApiError(
      "PAYLOAD_TOO_LARGE",
      `${url} is ${size} bytes; this instance accepts files up to ${max}.`,
    );
  }
}

/**
 * A body that does not deliver exactly the declared length errors the stream,
 * and workerd words that failure its own way. The caller's mistake is the same
 * one either way — the bytes are not what they said — so it gets the same code.
 * A throttle is still a throttle.
 */
async function asHashMismatch<T>(url: string, size: number, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof StorageError && error.code === "R2_RATE_LIMIT") throw error;
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      "HASH_MISMATCH",
      `${url} did not deliver ${size} bytes matching the sha256 sent with it.`,
    );
  }
}

type FixedLength = { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };

/** workerd's `FixedLengthStream`, or `null` where the runtime has none. */
function fixedLength(size: number): FixedLength | null {
  const ctor = (globalThis as { FixedLengthStream?: new (size: number) => FixedLength })
    .FixedLengthStream;
  return ctor === undefined ? null : new ctor(size);
}

async function readCapped(
  body: ReadableStream<Uint8Array>,
  max: number,
  url: string,
  what: { unhashed: boolean },
): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new ApiError(
        "PAYLOAD_TOO_LARGE",
        what.unhashed
          ? `${url} is over ${max} bytes and carries no sha256, so this instance must hash it itself; send sha256 with the entry, or a smaller file.`
          : `${url} is over ${max} bytes, this instance's max_file_bytes.`,
      );
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}
