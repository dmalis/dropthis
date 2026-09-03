/**
 * Idempotency results are encrypted at rest (AGENTS.md, "Key layout").
 *
 * The reason is one field: a generated password is returned once, and a retry
 * under the same `idempotency_key` must return it again — so the response has
 * to be stored. Storing it in clear would put a live password in the bucket,
 * readable by anything with R2 access, for seven days. AES-GCM with a key
 * derived from `HMAC_SECRET` keeps the retry working without that.
 *
 * The key is derived, never used raw: HKDF with a fixed `info` string, so a
 * future use of `HMAC_SECRET` (unlock cookies, signed upload URLs) cannot share
 * key material with this one.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const HKDF_INFO = "dropthis:idempotency-result:v1";
const NONCE_BYTES = 12;

async function resultKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: encoder.encode(HKDF_INFO),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** `base64(nonce ‖ ciphertext)` — one opaque string to store under `…/result`. */
export async function encryptResult(secret: string, plaintext: string): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    await resultKey(secret),
    encoder.encode(plaintext),
  );
  const token = new Uint8Array(NONCE_BYTES + sealed.byteLength);
  token.set(nonce, 0);
  token.set(new Uint8Array(sealed), NONCE_BYTES);
  return toBase64(token);
}

export async function decryptResult(secret: string, token: string): Promise<string> {
  const bytes = fromBase64(token);
  if (bytes.length <= NONCE_BYTES) {
    throw new Error("Stored result is too short to be a sealed response.");
  }
  const opened = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.subarray(0, NONCE_BYTES) },
    await resultKey(secret),
    bytes.subarray(NONCE_BYTES),
  );
  return decoder.decode(opened);
}
