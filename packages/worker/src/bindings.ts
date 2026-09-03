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

export type Env = {
  BUCKET: Bucket;
  OAUTH_KV: unknown;
  HMAC_SECRET?: string;
  /** "1" only in the throwaway dev instance; see `src/dev/routes.ts`. */
  DEV_ROUTES?: string;
  /**
   * An RFC 3339 instant the dev build answers as "now", so expiry states can be
   * driven without waiting. Absent in production builds.
   */
  DEV_CLOCK?: string;
};
