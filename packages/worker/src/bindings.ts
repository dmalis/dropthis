/**
 * The Worker's environment: one bucket, one KV namespace, one secret
 * (AGENTS.md, "Architecture"). The bucket type is the subset of the R2 binding
 * dropthis actually uses — the write surface lives in `storage/r2.ts`, and this
 * adds the reads and deletes the rest of the product needs.
 */
import type { R2BucketLike, R2WriteResult } from "./storage/r2.js";

export type R2ObjectBody = R2WriteResult & {
  key: string;
  uploaded?: Date;
  customMetadata?: Record<string, string>;
  /** The bytes, unread — the viewer pipes this straight to the response. */
  body: ReadableStream | null;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
};

/** A byte range, in the shape the R2 binding takes it. */
export type R2Range =
  | { offset: number; length?: number }
  | { offset?: number; length: number }
  | { suffix: number };

/** What `list()` returns per object; `customMetadata` only when asked for. */
export type R2ListedObject = R2WriteResult & {
  key: string;
  uploaded?: Date;
  customMetadata?: Record<string, string>;
};

export type R2Listing = {
  objects: R2ListedObject[];
  truncated: boolean;
  cursor?: string;
};

/**
 * `list()` returns keys only unless `include` asks for more. `list` needs
 * `customMetadata` on every row, because that is what lets a page cost one
 * `list()` instead of one `meta.json` read per drop.
 */
export type R2ListOptions = {
  prefix?: string;
  cursor?: string;
  limit?: number;
  /** Exclusive: listing starts at the first key AFTER this one. */
  startAfter?: string;
  include?: Array<"httpMetadata" | "customMetadata">;
};

export type Bucket = R2BucketLike & {
  get(key: string, options?: { range?: R2Range }): Promise<R2ObjectBody | null>;
  head(key: string): Promise<R2ListedObject | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options?: R2ListOptions): Promise<R2Listing>;
};

/**
 * The KV binding, as `@cloudflare/workers-oauth-provider` uses it. dropthis
 * itself never reads or writes `OAUTH_KV`; the provider owns every key in it.
 */
export type KvNamespaceLike = {
  get(key: string, options?: { type?: string } | string): Promise<unknown>;
  put(key: string, value: string, options?: Record<string, unknown>): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<unknown>;
};

export type Env = {
  BUCKET: Bucket;
  OAUTH_KV: KvNamespaceLike;
  HMAC_SECRET?: string;
  /** "1" only in the throwaway dev instance; see `src/dev/routes.ts`. */
  DEV_ROUTES?: string;
  /**
   * An RFC 3339 instant the dev build answers as "now", so expiry states can be
   * driven without waiting. Absent in production builds.
   */
  DEV_CLOCK?: string;
};

/**
 * The Hono context variables the app carries. One so far: whether the response
 * being built belongs to a drop whose `noindex` is OFF, which is the only case
 * in which `X-Robots-Tag` is not sent (docs/spec-v1.md, story 45).
 */
export type AppVariables = {
  indexable?: boolean;
};

export type AppEnv = { Bindings: Env; Variables: AppVariables };
