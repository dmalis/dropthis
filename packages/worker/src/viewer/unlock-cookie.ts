/**
 * The unlock cookie: proof that this browser typed the drop's password.
 *
 * It is a signed value, not a session id, because dropthis has no session
 * store and does not want one — "files are the database" and a KV write per
 * visitor would be a moving part with nothing to show for it. The signature
 * covers three things, and each is there for a reason:
 *
 *   `slug`        so a cookie for one drop cannot open another. The origin is
 *                 shared (decision #28), so the path scope alone is a
 *                 convenience, not a boundary.
 *   `nonce`       the revocation lever. A new, generated or removed password
 *                 rotates it in `meta.json`, and every cookie signed over the
 *                 old one stops verifying on the very next request.
 *   `expiresAt`   so an unlock ends. It is INSIDE the signature, so a visitor
 *                 editing the cookie to extend it invalidates it instead.
 *
 * The key is derived from `HMAC_SECRET` with HKDF and its own `info` string,
 * so this signature shares no key material with the idempotency-result cipher
 * or with any later use of the same secret.
 */

const encoder = new TextEncoder();

export const UNLOCK_COOKIE = "dropthis_unlock";

const HKDF_INFO = "dropthis:unlock-cookie:v1";
const SIGNATURE_PREFIX = "dropthis:unlock:v1";

/** How long one unlock lasts, unless the drop dies first. */
export const UNLOCK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

async function signingKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode(HKDF_INFO) },
    material,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function payload(slug: string, nonce: string, expiresMs: number): Uint8Array<ArrayBuffer> {
  // Newline-separated and prefixed: no field can be shifted into another, and
  // a signature from a future cookie version cannot be replayed as this one.
  return encoder.encode(`${SIGNATURE_PREFIX}\n${slug}\n${nonce}\n${expiresMs}`);
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type UnlockClaim = { slug: string; nonce: string; expiresAt: Date };

/** `<expires-ms>.<hmac-hex>` — the whole cookie value. */
export async function signUnlock(secret: string, claim: UnlockClaim): Promise<string> {
  const expiresMs = claim.expiresAt.getTime();
  const mac = await crypto.subtle.sign(
    "HMAC",
    await signingKey(secret),
    payload(claim.slug, claim.nonce, expiresMs),
  );
  return `${expiresMs}.${hex(mac)}`;
}

export type UnlockCheck = { slug: string; nonce: string; now: Date };

/**
 * Whether this cookie opens this drop right now. Every refusal answers the
 * same `false`: a visitor learns that the cookie did not work, never why.
 */
export async function verifyUnlock(
  secret: string,
  token: string,
  check: UnlockCheck,
): Promise<boolean> {
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const expiresText = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!/^\d+$/.test(expiresText) || !/^[0-9a-f]{64}$/.test(mac)) return false;

  const expiresMs = Number(expiresText);
  if (check.now.getTime() >= expiresMs) return false;

  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) bytes[i] = Number.parseInt(mac.slice(i * 2, i * 2 + 2), 16);

  return crypto.subtle.verify(
    "HMAC",
    await signingKey(secret),
    bytes,
    payload(check.slug, check.nonce, expiresMs),
  );
}

/** A week, or the drop's own end if that comes first. */
export function cookieExpiry(now: Date, dropExpiresAt: string | null): Date {
  const week = now.getTime() + UNLOCK_MAX_AGE_MS;
  if (dropExpiresAt === null) return new Date(week);
  const drop = Date.parse(dropExpiresAt);
  return new Date(Number.isNaN(drop) ? week : Math.min(week, drop));
}

/**
 * Host-only (no `Domain`), `Secure`, `HttpOnly`, `SameSite=Lax`, scoped to the
 * one drop — the attributes docs/spec-v1.md froze, in that order.
 */
export function setCookieHeader(slug: string, token: string, expiresAt: Date): string {
  return [
    `${UNLOCK_COOKIE}=${token}`,
    `Path=/${slug}/`,
    `Expires=${expiresAt.toUTCString()}`,
    "Secure",
    "HttpOnly",
    "SameSite=Lax",
  ].join("; ");
}

/** One cookie's value out of a `Cookie` header, or `null`. */
export function readCookie(header: string | null | undefined, name: string): string | null {
  if (typeof header !== "string") return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return part.slice(eq + 1).trim();
  }
  return null;
}
