import { describe, expect, it } from "vitest";
import { attribution, requireScope, resolveCaller } from "../src/auth/caller.js";
import { hashKey } from "../src/auth/key.js";
import type { ApiError } from "../src/errors.js";
import { keyHashKey, keyRecordKey } from "../src/storage/keys.js";
import { memoryBucket } from "./memory-bucket.js";
import type { MemoryBucket } from "./memory-bucket.js";

/**
 * Bearer auth is two computed GETs and one constant-time compare: the header's
 * key hashes to `keyhash/<hash>`, which names a key id, whose record carries
 * the label and the scope (AGENTS.md, "Auth"). No `list()`, no index, and no
 * way to enumerate keys from outside.
 */
async function withKey(scope: "admin" | "user", label: string): Promise<{
  bucket: MemoryBucket;
  key: string;
  id: string;
}> {
  const bucket = memoryBucket();
  const key = "k".repeat(64);
  const id = `id-${label}`;
  const hash = await hashKey(key);
  bucket.seed(keyHashKey(hash), JSON.stringify({ id }));
  bucket.seed(
    keyRecordKey(id),
    JSON.stringify({ id, label, scope, hash, created: "2026-09-03T00:00:00Z" }),
  );
  return { bucket, key, id };
}

const request = (header?: string) =>
  new Request("https://example.test/_api/v1/drops", {
    headers: header === undefined ? {} : { authorization: header },
  });

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "no error";
  } catch (error) {
    return (error as ApiError).code;
  }
}

describe("resolveCaller", () => {
  it("resolves a valid bearer key to its id, label and scope", async () => {
    const { bucket, key, id } = await withKey("user", "anna");
    const caller = await resolveCaller(request(`Bearer ${key}`), bucket);
    expect(caller).toEqual({ id, label: "anna", scope: "user" });
  });

  it("accepts the scheme case-insensitively, as RFC 7235 requires", async () => {
    const { bucket, key } = await withKey("admin", "admin");
    expect((await resolveCaller(request(`bearer ${key}`), bucket)).label).toBe("admin");
  });

  it("refuses a missing header", async () => {
    const { bucket } = await withKey("user", "anna");
    expect(await codeOf(resolveCaller(request(), bucket))).toBe("UNAUTHENTICATED");
  });

  it("refuses another scheme", async () => {
    const { bucket, key } = await withKey("user", "anna");
    expect(await codeOf(resolveCaller(request(`Basic ${key}`), bucket))).toBe("UNAUTHENTICATED");
  });

  it("refuses a bearer with no credential", async () => {
    const { bucket } = await withKey("user", "anna");
    expect(await codeOf(resolveCaller(request("Bearer "), bucket))).toBe("UNAUTHENTICATED");
  });

  it("refuses a key that hashes to no pointer", async () => {
    const { bucket } = await withKey("user", "anna");
    expect(await codeOf(resolveCaller(request("Bearer nope"), bucket))).toBe("UNAUTHENTICATED");
  });

  it("refuses a revoked key: the pointer is gone even though the record is not", async () => {
    const { bucket, key } = await withKey("user", "anna");
    await bucket.delete(keyHashKey(await hashKey(key)));
    expect(await codeOf(resolveCaller(request(`Bearer ${key}`), bucket))).toBe("UNAUTHENTICATED");
  });

  it("refuses a pointer whose key record is gone", async () => {
    const { bucket, key, id } = await withKey("user", "anna");
    await bucket.delete(keyRecordKey(id));
    expect(await codeOf(resolveCaller(request(`Bearer ${key}`), bucket))).toBe("UNAUTHENTICATED");
  });

  it("refuses when the record's hash disagrees with the key", async () => {
    const { bucket, key, id } = await withKey("user", "anna");
    bucket.seed(
      keyRecordKey(id),
      JSON.stringify({ id, label: "anna", scope: "user", hash: "00", created: "x" }),
    );
    expect(await codeOf(resolveCaller(request(`Bearer ${key}`), bucket))).toBe("UNAUTHENTICATED");
  });

  it("refuses a record with an unknown scope rather than guessing one", async () => {
    const { bucket, key, id } = await withKey("user", "anna");
    const hash = await hashKey(key);
    bucket.seed(
      keyRecordKey(id),
      JSON.stringify({ id, label: "anna", scope: "root", hash, created: "x" }),
    );
    expect(await codeOf(resolveCaller(request(`Bearer ${key}`), bucket))).toBe("UNAUTHENTICATED");
  });

  it("reads a `keyhash/` pointer written as bare text, as well as JSON", async () => {
    const bucket = memoryBucket();
    const key = "b".repeat(64);
    const hash = await hashKey(key);
    bucket.seed(keyHashKey(hash), "plain-id");
    bucket.seed(
      keyRecordKey("plain-id"),
      JSON.stringify({ id: "plain-id", label: "bo", scope: "user", hash, created: "x" }),
    );
    expect((await resolveCaller(request(`Bearer ${key}`), bucket)).id).toBe("plain-id");
  });

  it("costs exactly two reads", async () => {
    const { bucket, key } = await withKey("admin", "admin");
    bucket.log.length = 0;
    await resolveCaller(request(`Bearer ${key}`), bucket);
    expect(bucket.log.filter((entry) => entry.startsWith("get "))).toHaveLength(2);
    expect(bucket.log.some((entry) => entry.startsWith("list"))).toBe(false);
  });
});

describe("requireScope", () => {
  const admin = { id: "a", label: "admin", scope: "admin" as const };
  const user = { id: "u", label: "anna", scope: "user" as const };

  it("lets an admin key reach an admin operation", () => {
    expect(() => requireScope(admin, "admin")).not.toThrow();
  });

  it("lets an admin key reach a user operation", () => {
    expect(() => requireScope(admin, "user")).not.toThrow();
  });

  it("lets a user key reach a user operation", () => {
    expect(() => requireScope(user, "user")).not.toThrow();
  });

  it("refuses a user key on an admin operation", () => {
    expect(() => requireScope(user, "admin")).toThrow(/admin/);
    try {
      requireScope(user, "admin");
    } catch (error) {
      expect((error as ApiError).code).toBe("FORBIDDEN_SCOPE");
    }
  });
});

describe("attribution", () => {
  it("snapshots the id and the label, never the scope", () => {
    expect(attribution({ id: "u", label: "anna", scope: "user" })).toEqual({
      id: "u",
      label: "anna",
    });
  });
});
