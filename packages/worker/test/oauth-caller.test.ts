import { describe, expect, it } from "vitest";
import { hashKey } from "../src/auth/key.js";
import { resolveOAuthCaller } from "../src/oauth/caller.js";
import type { ApiError } from "../src/errors.js";
import { keyHashKey, keyRecordKey } from "../src/storage/keys.js";
import { memoryBucket } from "./memory-bucket.js";

/**
 * An OAuth token is an alias for a key, never a second identity (AGENTS.md,
 * "Auth"). The grant stores the key ID and nothing else; every request that
 * bears a token re-reads the key record and its `keyhash/` pointer, so a
 * revoked key stops every session behind it on the very next request — the
 * same instant the bearer path loses it, because `user remove` deletes the
 * pointer first.
 */
async function seeded(scope: "admin" | "user" = "user") {
  const bucket = memoryBucket();
  const key = "k".repeat(64);
  const hash = await hashKey(key);
  bucket.seed(keyHashKey(hash), JSON.stringify({ id: "id-anna" }));
  bucket.seed(
    keyRecordKey("id-anna"),
    JSON.stringify({ id: "id-anna", label: "anna", scope, hash, created: "2026-09-03T00:00:00Z" }),
  );
  return { bucket, hash };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "no error";
  } catch (error) {
    return (error as ApiError).code;
  }
}

describe("resolveOAuthCaller", () => {
  it("turns a key id into the caller, scope read from the record now", async () => {
    const { bucket } = await seeded("admin");
    expect(await resolveOAuthCaller(bucket, { keyId: "id-anna" })).toEqual({
      id: "id-anna",
      label: "anna",
      scope: "admin",
    });
  });

  it("refuses once the record is gone", async () => {
    const { bucket } = await seeded();
    await bucket.delete(keyRecordKey("id-anna"));
    expect(await codeOf(resolveOAuthCaller(bucket, { keyId: "id-anna" }))).toBe("UNAUTHENTICATED");
  });

  it("refuses once the keyhash pointer is gone — the first write of user remove", async () => {
    const { bucket, hash } = await seeded();
    await bucket.delete(keyHashKey(hash));
    expect(await codeOf(resolveOAuthCaller(bucket, { keyId: "id-anna" }))).toBe("UNAUTHENTICATED");
  });

  it("refuses a pointer that names another id", async () => {
    const { bucket, hash } = await seeded();
    bucket.seed(keyHashKey(hash), JSON.stringify({ id: "id-someone-else" }));
    expect(await codeOf(resolveOAuthCaller(bucket, { keyId: "id-anna" }))).toBe("UNAUTHENTICATED");
  });

  it("refuses props that carry no key id", async () => {
    const { bucket } = await seeded();
    expect(await codeOf(resolveOAuthCaller(bucket, {}))).toBe("UNAUTHENTICATED");
    expect(await codeOf(resolveOAuthCaller(bucket, null))).toBe("UNAUTHENTICATED");
  });
});
