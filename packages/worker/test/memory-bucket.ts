/**
 * An in-memory stand-in for the R2 binding, for unit tests only.
 *
 * It exists to exercise OUR logic — the order of writes in `user add`, what
 * `user remove` tolerates, what `config set` refuses — not to prove anything
 * about R2. R2's own behaviour (conditional writes, per-key contention, digest
 * verification) is proven only against remote R2 in `contract-tests/`, because
 * emulators have shipped reversed condition logic (AGENTS.md, "R2 facts").
 *
 * The conditional semantics below are therefore a convenience, deliberately
 * simple: `etagDoesNotMatch: "*"` means "must not exist", `etagMatches` means
 * "must be exactly this version".
 */
import type { Bucket, R2Listing, R2ObjectBody } from "../src/bindings.js";
import type { R2WriteOptions, R2WriteResult } from "../src/storage/r2.js";

type Stored = {
  bytes: Uint8Array;
  etag: string;
  customMetadata: Record<string, string> | undefined;
  contentType?: string | undefined;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function toBytes(
  value: ArrayBuffer | ArrayBufferView | string | ReadableStream | null,
): Promise<Uint8Array> {
  if (value === null) return new Uint8Array(0);
  if (typeof value === "string") return encoder.encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  const chunks: Uint8Array[] = [];
  const reader = (value as ReadableStream<Uint8Array>).getReader();
  for (;;) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
    chunks.push(chunk);
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

export type MemoryBucket = Bucket & {
  /** Every key, in R2's lexicographic order — what a test asserts against. */
  keys(prefix?: string): string[];
  /** The stored body of a key, as text. */
  read(key: string): string | null;
  /** Seed a key without going through the conditional-write path. */
  seed(key: string, body: string, customMetadata?: Record<string, string>): void;
  /** Every operation, in order, so a test can pin the write ORDER. */
  log: string[];
  /** Make the next write to `key` throw, to prove a crash converges. */
  failNext(key: string, error: Error): void;
};

export function memoryBucket(): MemoryBucket {
  const store = new Map<string, Stored>();
  const log: string[] = [];
  const failures = new Map<string, Error>();
  let version = 0;

  const objectFor = (key: string, stored: Stored): R2ObjectBody => ({
    key,
    etag: stored.etag,
    size: stored.bytes.length,
    ...(stored.customMetadata === undefined ? {} : { customMetadata: stored.customMetadata }),
    // A fresh stream per read, so the viewer can pipe the bytes to a response.
    body: new Blob([stored.bytes as Uint8Array<ArrayBuffer>]).stream(),
    text: async () => decoder.decode(stored.bytes),
    arrayBuffer: async () =>
      stored.bytes.buffer.slice(
        stored.bytes.byteOffset,
        stored.bytes.byteOffset + stored.bytes.byteLength,
      ) as ArrayBuffer,
  });

  const bucket: MemoryBucket = {
    log,

    async put(key, value, options?: R2WriteOptions): Promise<R2WriteResult | null> {
      log.push(`put ${key}`);
      const failure = failures.get(key);
      if (failure !== undefined) {
        failures.delete(key);
        throw failure;
      }
      const existing = store.get(key);
      if (options?.onlyIf?.etagDoesNotMatch === "*" && existing !== undefined) return null;
      if (options?.onlyIf?.etagMatches !== undefined) {
        if (existing === undefined || existing.etag !== options.onlyIf.etagMatches) return null;
      }
      version += 1;
      const bytes = await toBytes(value);
      const stored: Stored = {
        bytes,
        etag: `etag-${version}`,
        customMetadata: options?.customMetadata,
        contentType: options?.httpMetadata?.contentType,
      };
      store.set(key, stored);
      return { etag: stored.etag, size: bytes.length };
    },

    async get(key) {
      log.push(`get ${key}`);
      const stored = store.get(key);
      return stored === undefined ? null : objectFor(key, stored);
    },

    async head(key) {
      log.push(`head ${key}`);
      const stored = store.get(key);
      return stored === undefined
        ? null
        : { key, etag: stored.etag, size: stored.bytes.length };
    },

    async delete(keys) {
      for (const key of typeof keys === "string" ? [keys] : keys) {
        log.push(`delete ${key}`);
        store.delete(key);
      }
    },

    async list(options = {}): Promise<R2Listing> {
      log.push(`list ${options.prefix ?? ""}`);
      const prefix = options.prefix ?? "";
      const after = options.startAfter;
      const all = [...store.keys()]
        .filter((key) => key.startsWith(prefix) && (after === undefined || key > after))
        .sort();
      const start = options.cursor === undefined ? 0 : Number(options.cursor);
      const limit = options.limit ?? 1000;
      const page = all.slice(start, start + limit);
      const truncated = start + limit < all.length;
      return {
        objects: page.map((key) => {
          const stored = store.get(key)!;
          return {
            key,
            etag: stored.etag,
            size: stored.bytes.length,
            customMetadata: stored.customMetadata,
          } as R2Listing["objects"][number];
        }),
        truncated,
        ...(truncated ? { cursor: String(start + limit) } : {}),
      };
    },

    keys(prefix = "") {
      return [...store.keys()].filter((key) => key.startsWith(prefix)).sort();
    },

    read(key) {
      const stored = store.get(key);
      return stored === undefined ? null : decoder.decode(stored.bytes);
    },

    seed(key, body, customMetadata) {
      version += 1;
      store.set(key, { bytes: encoder.encode(body), etag: `etag-${version}`, customMetadata });
    },

    failNext(key, error) {
      failures.set(key, error);
    },
  };

  return bucket;
}
