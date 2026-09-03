/**
 * The signature on a staged-upload PUT URL (docs/spec-v1.md, "Staged upload
 * path"): an HMAC over `{upload_id, sha256, exp}` with a key derived from
 * `HMAC_SECRET`, valid one hour. It is the PUT's only credential — the CLI
 * can hand the URLs to a plain uploader without handing it the instance key,
 * and a URL leaks at most one blob slot of one session for one hour.
 *
 * The key is derived, never `HMAC_SECRET` raw, with its own `info` string so
 * it can never share material with the idempotency-result cipher or the
 * unlock cookie.
 */
import { sameHash } from "../auth/key.js";

const encoder = new TextEncoder();
const HKDF_INFO = "dropthis:upload-url:v1";

export type SignedParts = { uploadId: string; sha256: string; exp: number };

async function signingKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode(HKDF_INFO) },
    material,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
}

/** The three parts, newline-joined: none of them can contain a newline. */
function message(parts: SignedParts): Uint8Array<ArrayBuffer> {
  return encoder.encode(`${parts.uploadId}\n${parts.sha256}\n${parts.exp}`);
}

export async function signUploadUrl(secret: string, parts: SignedParts): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", await signingKey(secret), message(parts));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Constant-time: the signature is recomputed and compared with `sameHash`,
 * never with `===`, and expiry is checked by the caller against its own clock.
 */
export async function verifyUploadSignature(
  secret: string,
  parts: SignedParts,
  signature: string,
): Promise<boolean> {
  return sameHash(await signUploadUrl(secret, parts), signature);
}
