import { describe, expect, it } from "vitest";
import { ApiError } from "../src/errors.js";
import {
  GENERATED_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  derivePassword,
  generatePassword,
  resolvePassword,
  verifyPassword,
} from "../src/domain/password.js";
import type { PasswordRecord } from "../src/domain/password.js";

const ITERATIONS = 1_000;
const policy = { iterations: ITERATIONS, required: false, default: null as string | null };

async function record(password: string): Promise<PasswordRecord> {
  return derivePassword(password, ITERATIONS);
}

describe("a generated password", () => {
  it("is 16 characters of unmixed-case-safe letters and digits", () => {
    for (let i = 0; i < 50; i += 1) {
      const password = generatePassword();
      expect(password).toHaveLength(GENERATED_PASSWORD_LENGTH);
      expect(password).toMatch(/^[A-Za-z0-9]{16}$/);
    }
  });

  it("is different every time", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generatePassword()));
    expect(seen.size).toBe(200);
  });
});

describe("the stored form", () => {
  it("is the shape docs/spec-v1.md froze", async () => {
    const stored = await record("correct horse battery");
    expect(Object.keys(stored).sort()).toEqual([
      "algorithm",
      "hash",
      "iterations",
      "nonce",
      "salt",
      "version",
    ]);
    expect(stored.algorithm).toBe("pbkdf2-sha256");
    expect(stored.iterations).toBe(ITERATIONS);
    expect(stored.version).toBe(1);
    expect(stored.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(stored.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.nonce).toMatch(/^[0-9a-f]{32}$/);
  });

  it("never repeats a salt, so two equal passwords store differently", async () => {
    const a = await record("the same password");
    const b = await record("the same password");
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });

  it("verifies the password it was made from and nothing else", async () => {
    const stored = await record("open sesame");
    expect(await verifyPassword(stored, "open sesame")).toBe(true);
    expect(await verifyPassword(stored, "open sesam")).toBe(false);
    expect(await verifyPassword(stored, "")).toBe(false);
  });

  it("refuses a record whose algorithm it does not know", async () => {
    const stored = { ...(await record("open sesame")), algorithm: "argon2id" } as PasswordRecord;
    expect(await verifyPassword(stored, "open sesame")).toBe(false);
  });
});

describe("resolving what a call asked for", () => {
  it("leaves the drop alone when the call says nothing", async () => {
    const current = await record("kept");
    expect(await resolvePassword(current, undefined, policy)).toEqual({ kind: "unchanged" });
  });

  it("applies the instance default only when the call says nothing on a create", async () => {
    const change = await resolvePassword(undefined, undefined, {
      ...policy,
      default: "generate",
    });
    expect(change.kind).toBe("set");
    if (change.kind !== "set") throw new Error("unreachable");
    expect(change.generated).toBe(true);
    expect(change.password).toMatch(/^[A-Za-z0-9]{16}$/);
  });

  it("generates on demand and hands the plaintext back exactly once", async () => {
    const change = await resolvePassword(undefined, "generate", policy);
    if (change.kind !== "set") throw new Error("unreachable");
    expect(change.generated).toBe(true);
    expect(await verifyPassword(change.record, change.password)).toBe(true);
  });

  it("stores a chosen password and reports it as chosen", async () => {
    const change = await resolvePassword(undefined, "hunter2hunter2", policy);
    if (change.kind !== "set") throw new Error("unreachable");
    expect(change.generated).toBe(false);
    expect(change.password).toBe("hunter2hunter2");
    expect(await verifyPassword(change.record, "hunter2hunter2")).toBe(true);
  });

  it("refuses a chosen password under the minimum", async () => {
    await expect(resolvePassword(undefined, "short7!", policy)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(MIN_PASSWORD_LENGTH).toBe(8);
  });

  it("counts characters, not bytes, so a short multi-byte password is refused", async () => {
    await expect(resolvePassword(undefined, "pässwör", policy)).rejects.toBeInstanceOf(ApiError);
  });

  it("removes the password when the call sends null", async () => {
    const current = await record("going away");
    expect(await resolvePassword(current, null, policy)).toEqual({ kind: "removed" });
  });

  it("treats removing a password that is not there as nothing to do", async () => {
    expect(await resolvePassword(undefined, null, policy)).toEqual({ kind: "unchanged" });
  });

  it("refuses to leave a drop open when the instance requires a password", async () => {
    const current = await record("required here");
    await expect(
      resolvePassword(current, null, { ...policy, required: true }),
    ).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    await expect(
      resolvePassword(undefined, undefined, { ...policy, required: true, default: null }),
    ).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
  });
});

/**
 * The nonce is what the unlock cookie is signed over, so rotating it is
 * revocation. It must move on every real change and stay put on a call that
 * changes nothing — otherwise re-sending the current password logs every
 * visitor out for no reason.
 */
describe("nonce rotation", () => {
  it("keeps the nonce when the chosen password is the one already stored", async () => {
    const current = await record("unchanged password");
    const change = await resolvePassword(current, "unchanged password", policy);
    expect(change).toEqual({ kind: "unchanged" });
  });

  it("rotates the nonce when the chosen password is a different one", async () => {
    const current = await record("old password");
    const change = await resolvePassword(current, "new password", policy);
    if (change.kind !== "set") throw new Error("unreachable");
    expect(change.record.nonce).not.toBe(current.nonce);
  });

  it("rotates the nonce when a new password is generated over an old one", async () => {
    const current = await record("old password");
    const change = await resolvePassword(current, "generate", policy);
    if (change.kind !== "set") throw new Error("unreachable");
    expect(change.record.nonce).not.toBe(current.nonce);
  });

  it("re-derives at the instance's current iteration count on a real change", async () => {
    const current = await derivePassword("old password", 1_000);
    const change = await resolvePassword(current, "new password", { ...policy, iterations: 2_000 });
    if (change.kind !== "set") throw new Error("unreachable");
    expect(change.record.iterations).toBe(2_000);
  });
});
