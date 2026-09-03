/**
 * The credential itself: mint, hash, compare (docs/spec-v1.md, "Auth").
 *
 * 32 random bytes is already far past guessing, so the stored form is a plain
 * SHA-256 and not a slow KDF: a password needs stretching because a human
 * chose it; a 256-bit random key does not, and the Free plan's CPU budget per
 * request is small enough that stretching every call would be felt.
 *
 * The key is shown exactly once, at `user add`. Nothing in the product can
 * recover it afterwards — a lost key is replaced, never recovered.
 */
import { sha256Hex } from "../domain/meta.js";

/** The scopes, and the only two there will be (AGENTS.md, "Team model"). */
export type Scope = "admin" | "user";

/** `keys/<id>.json` — the record every credential, admin included, has. */
export type KeyRecord = {
  id: string;
  label: string;
  scope: Scope;
  /** `sha256(key)`, lowercase hex. The key itself is never stored. */
  hash: string;
  created: string;
};

/** A fresh key: 32 random bytes as 64 lowercase hex characters. */
export function mintKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The stored form of a key, and the `keyhash/` pointer's name. */
export function hashKey(key: string): Promise<string> {
  return sha256Hex(key);
}

type TimingSafe = { timingSafeEqual?: (a: ArrayBufferView, b: ArrayBufferView) => boolean };

/**
 * Constant-time comparison of two hex digests.
 *
 * workerd provides `crypto.subtle.timingSafeEqual`, and that is what runs in
 * production. Node's WebCrypto does not, so the fallback below does the same
 * work in JavaScript — it is there for the unit tests, and it is still
 * constant time over equal-length inputs.
 *
 * A length or shape mismatch is answered `false` immediately: the length of a
 * digest is not a secret, and a mismatched buffer would make the primitive
 * throw.
 */
export function sameHash(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  const left = fromHex(a);
  const right = fromHex(b);
  if (left === null || right === null) return false;

  const native = (crypto.subtle as unknown as TimingSafe).timingSafeEqual;
  if (typeof native === "function") return native.call(crypto.subtle, left, right);

  let difference = 0;
  for (let i = 0; i < left.length; i += 1) difference |= left[i]! ^ right[i]!;
  return difference === 0;
}

function fromHex(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
