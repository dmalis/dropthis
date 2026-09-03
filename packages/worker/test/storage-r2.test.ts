import { describe, expect, it } from "vitest";
import {
  StorageError,
  casPut,
  claimKey,
  createPut,
  putBlob,
  type R2BucketLike,
  type R2WriteOptions,
  type R2WriteResult,
} from "../src/storage/r2.js";

/**
 * A hand-written stand-in with the R2 binding's shape. It records the options
 * it was called with and answers the way the binding documents a failed
 * precondition: `put` resolves to `null`. These tests assert the RESULT MAPPING
 * only. What remote R2 actually does with these preconditions is proven by the
 * contract tests against the deployed dev Worker, never here.
 */
function fakeBucket(
  behaviour: {
    put?: (key: string, value: unknown, options?: R2WriteOptions) => Promise<R2WriteResult | null>;
  } = {},
) {
  const calls: Array<{ key: string; value: unknown; options: R2WriteOptions | undefined }> = [];
  const bucket: R2BucketLike = {
    put: async (key, value, options) => {
      calls.push({ key, value, options });
      return behaviour.put ? behaviour.put(key, value, options) : { etag: "etag-1" };
    },
  };
  return { calls, bucket };
}

const throwing = (error: unknown): R2BucketLike => ({
  put: async () => {
    throw error;
  },
});

describe("claimKey", () => {
  it("sends If-None-Match: * and reports the claim with its etag", async () => {
    const { bucket, calls } = fakeBucket({ put: async () => ({ etag: "abc123" }) });

    const result = await claimKey(bucket, "slugs/pinkelephan", "drop-1");

    expect(result).toEqual({ claimed: true, etag: "abc123" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.key).toBe("slugs/pinkelephan");
    expect(calls[0]!.value).toBe("drop-1");
    expect(calls[0]!.options?.onlyIf).toEqual({ etagDoesNotMatch: "*" });
  });

  it("reports no claim when the precondition failed (put resolved null)", async () => {
    const { bucket } = fakeBucket({ put: async () => null });

    expect(await claimKey(bucket, "users/admin", "key-1")).toEqual({ claimed: false });
  });
});

describe("createPut", () => {
  it("creates with If-None-Match: * and reports the new etag", async () => {
    const { bucket, calls } = fakeBucket({ put: async () => ({ etag: "meta-1" }) });

    expect(await createPut(bucket, "drops/d1/meta.json", "{}")).toEqual({
      ok: true,
      etag: "meta-1",
    });
    expect(calls[0]!.options?.onlyIf).toEqual({ etagDoesNotMatch: "*" });
  });

  it("reports a conflict when the object already exists", async () => {
    const { bucket } = fakeBucket({ put: async () => null });

    expect(await createPut(bucket, "drops/d1/meta.json", "{}")).toEqual({
      ok: false,
      conflict: true,
    });
  });
});

describe("casPut", () => {
  it("sends If-Match with the base etag and reports the new one", async () => {
    const { bucket, calls } = fakeBucket({ put: async () => ({ etag: "meta-2" }) });

    expect(await casPut(bucket, "drops/d1/meta.json", "{}", "meta-1")).toEqual({
      ok: true,
      etag: "meta-2",
    });
    expect(calls[0]!.options?.onlyIf).toEqual({ etagMatches: "meta-1" });
  });

  it("reports a conflict when the stored etag moved on", async () => {
    const { bucket } = fakeBucket({ put: async () => null });

    expect(await casPut(bucket, "drops/d1/meta.json", "{}", "meta-1")).toEqual({
      ok: false,
      conflict: true,
    });
  });
});

describe("putBlob", () => {
  it("hands R2 the digest and the size so R2 verifies the body", async () => {
    const { bucket, calls } = fakeBucket({ put: async () => ({ etag: "blob-1", size: 3 }) });
    const sha = "a".repeat(64);

    expect(await putBlob(bucket, "drops/d1/blobs/" + sha, "abc", sha)).toEqual({
      etag: "blob-1",
      size: 3,
    });
    expect(calls[0]!.options?.sha256).toBe(sha);
  });

  it("turns R2's digest rejection into HASH_MISMATCH", async () => {
    const bucket = throwing(
      new Error("put: The SHA-256 checksum you specified did not match what we received."),
    );

    await expect(putBlob(bucket, "drops/d1/blobs/x", "abc", "b".repeat(64))).rejects.toMatchObject({
      name: "StorageError",
      code: "HASH_MISMATCH",
    });
  });
});

describe("write-rate mapping", () => {
  // The message remote R2 actually sends, captured from the deployed dev Worker
  // on 2026-09-03 and recorded in
  // docs/research/2026-09-03-free-plan-measurements.md. Every writer maps this
  // refusal to the same retryable code, never to a silent in-Worker retry.
  const rateLimited = new Error(
    "put: Reduce your concurrent request rate for the same object. (10058)",
  );

  it("maps it to R2_RATE_LIMIT with Retry-After 1 on a claim", async () => {
    await expect(claimKey(throwing(rateLimited), "slugs/x", "d1")).rejects.toMatchObject({
      code: "R2_RATE_LIMIT",
      retryAfterSeconds: 1,
    });
  });

  it("maps it on a CAS write too", async () => {
    await expect(
      casPut(throwing(rateLimited), "drops/d1/meta.json", "{}", "e1"),
    ).rejects.toMatchObject({ code: "R2_RATE_LIMIT", retryAfterSeconds: 1 });
  });

  it("maps R2's documented per-key write-rate wording too", async () => {
    const older = new Error("put: Reduce the rate at which you are writing to this object. (10029)");

    await expect(claimKey(throwing(older), "slugs/x", "d1")).rejects.toMatchObject({
      code: "R2_RATE_LIMIT",
      retryAfterSeconds: 1,
    });
  });

  it("leaves an unrecognised failure as INTERNAL", async () => {
    const error = await claimKey(throwing(new Error("socket hang up")), "slugs/x", "d1").catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(StorageError);
    expect((error as StorageError).code).toBe("INTERNAL");
    expect((error as StorageError).retryAfterSeconds).toBeUndefined();
  });
});
