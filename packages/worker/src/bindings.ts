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

export type R2Listing = {
  objects: Array<R2WriteResult & { key: string }>;
  truncated: boolean;
  cursor?: string;
};

export type Bucket = R2BucketLike & {
  get(key: string, options?: { range?: R2Range }): Promise<R2ObjectBody | null>;
  head(key: string): Promise<(R2WriteResult & { key: string }) | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options?: {
    prefix?: string;
    cursor?: string;
    limit?: number;
    /** Exclusive: listing starts at the first key AFTER this one. */
    startAfter?: string;
  }): Promise<R2Listing>;
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
