/**
 * The drop's unlock rule: `access.password` (docs/spec-v1.md, "The drop model").
 *
 * Two decisions are worth stating, because both are the opposite of the
 * obvious one.
 *
 * **A password IS stretched, unlike a key.** An instance key is 32 random
 * bytes and a plain SHA-256 is enough for it; a password is whatever a human
 * typed, so it gets PBKDF2-SHA256 at the instance's `pbkdf2_iterations` —
 * 25,000 by default, the highest count measured inside the 8 ms unlock budget
 * on the Free plan.
 *
 * **The nonce rotates only on an EFFECTIVE change.** The unlock cookie is an
 * HMAC over `{slug, nonce, expires_at}`, so moving the nonce logs every visitor
 * out. That is exactly what a new, generated or removed password should do —
 * and exactly what re-sending the password a drop already has should not.
 * `resolvePassword` is where that distinction lives, and it is the only place
 * allowed to decide it.
 *
 * `"generate"` is a reserved word, not a password: a caller cannot set the
 * literal password `generate`, and the contract says so rather than adding an
 * escape nobody would find.
 */
import { sameHash } from "../auth/key.js";
import { ApiError } from "../errors.js";
import { MIN_PASSWORD_LENGTH } from "../policy/defaults.js";

export { MIN_PASSWORD_LENGTH };

/** The caller's word for "make one up", and so not a password a caller can set. */
export const GENERATE = "generate";

/**
 * 16 characters is ~95 bits over this alphabet — far past guessing, and still
 * short enough that a human retypes it from a chat message without complaint.
 */
export const GENERATED_PASSWORD_LENGTH = 16;

/**
 * Letters and digits only. A generated password is read off a screen and typed
 * into a phone, so punctuation buys entropy nobody needs and costs a support
 * message; the length carries the strength instead.
 */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

const SALT_BYTES = 16;
const NONCE_BYTES = 16;
const DERIVED_BITS = 256;

/** The only algorithm this version writes, and the only one it verifies. */
export const PASSWORD_ALGORITHM = "pbkdf2-sha256";
export const PASSWORD_VERSION = 1;

export type PasswordRecord = {
  algorithm: string;
  iterations: number;
  /** Lowercase hex, like every other digest in this codebase. */
  salt: string;
  hash: string;
  version: number;
  /** Rotated on an effective change; the unlock cookie is signed over it. */
  nonce: string;
};

const encoder = new TextEncoder();

function hex(bytes: Uint8Array | ArrayBuffer): string {
  const view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  return [...view].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomHex(byteLength: number): string {
  return hex(crypto.getRandomValues(new Uint8Array(byteLength)));
}

function fromHex(value: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * A fresh password, from the CSPRNG and with no modulo bias: 62 does not
 * divide 256, so a byte at or above the largest whole multiple is discarded
 * rather than folded, which would make the first few characters likelier.
 */
export function generatePassword(): string {
  const limit = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
  let password = "";
  while (password.length < GENERATED_PASSWORD_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(GENERATED_PASSWORD_LENGTH))) {
      if (byte >= limit) continue;
      password += ALPHABET[byte % ALPHABET.length];
      if (password.length === GENERATED_PASSWORD_LENGTH) break;
    }
  }
  return password;
}

async function pbkdf2(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number) {
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material,
    DERIVED_BITS,
  );
}

export type DeriveOptions = { salt?: string; nonce?: string };

/** The stored form of a password: a fresh salt and a fresh nonce unless given. */
export async function derivePassword(
  password: string,
  iterations: number,
  options: DeriveOptions = {},
): Promise<PasswordRecord> {
  const salt = options.salt ?? randomHex(SALT_BYTES);
  return {
    algorithm: PASSWORD_ALGORITHM,
    iterations,
    salt,
    hash: hex(await pbkdf2(password, fromHex(salt), iterations)),
    version: PASSWORD_VERSION,
    nonce: options.nonce ?? randomHex(NONCE_BYTES),
  };
}

/**
 * Whether a typed password opens this drop. It re-derives at the RECORD's
 * iteration count, not the instance's: raising `pbkdf2_iterations` must not
 * lock out every drop published before the change.
 */
export async function verifyPassword(
  record: PasswordRecord,
  password: string,
): Promise<boolean> {
  if (record.algorithm !== PASSWORD_ALGORITHM) return false;
  if (!/^[0-9a-f]+$/.test(record.salt) || record.salt.length % 2 !== 0) return false;
  if (!Number.isInteger(record.iterations) || record.iterations <= 0) return false;
  const derived = hex(await pbkdf2(password, fromHex(record.salt), record.iterations));
  return sameHash(derived, record.hash);
}

/** The password half of the instance policy, resolved for one call. */
export type PasswordPolicy = {
  iterations: number;
  required: boolean;
  /** What a `publish` that says nothing gets: `"generate"`, a string, or none. */
  default: string | null;
};

export type PasswordChange =
  | { kind: "unchanged" }
  | { kind: "removed" }
  | {
      kind: "set";
      record: PasswordRecord;
      /** Returned to the caller once, in this response only. */
      password: string;
      /** True when dropthis chose it, so the agent knows to relay it. */
      generated: boolean;
    };

/**
 * What a call's `password` field means for this drop.
 *
 * `undefined` is "the caller said nothing": on a create the instance default
 * fills it, on an update it changes nothing (policy defaults never apply to an
 * update — docs/spec-v1.md, "`update` semantics"), which is why `current` being
 * present is what tells the two apart.
 */
export async function resolvePassword(
  current: PasswordRecord | undefined,
  input: string | null | undefined,
  policy: PasswordPolicy,
): Promise<PasswordChange> {
  const asked = input === undefined && current === undefined ? policy.default : input;

  if (asked === undefined) {
    // An update that says nothing keeps whatever the drop has, including none:
    // an existing drop is grandfathered until the caller next sets the field.
    return { kind: "unchanged" };
  }

  if (asked === null) {
    if (policy.required) {
      throw new ApiError(
        "POLICY_VIOLATION",
        "This instance requires every drop to have a password.",
      );
    }
    return current === undefined ? { kind: "unchanged" } : { kind: "removed" };
  }

  if (asked === GENERATE) {
    const password = generatePassword();
    return { kind: "set", record: await derivePassword(password, policy.iterations), password, generated: true };
  }

  if ([...asked].length < MIN_PASSWORD_LENGTH) {
    throw new ApiError(
      "INVALID_INPUT",
      `password must be at least ${MIN_PASSWORD_LENGTH} characters, or "generate".`,
    );
  }

  // Re-sending the password a drop already has is a no-op, nonce included.
  // Anything else is a real change and revokes every unlock cookie.
  if (current !== undefined && (await verifyPassword(current, asked))) {
    return { kind: "unchanged" };
  }

  return {
    kind: "set",
    record: await derivePassword(asked, policy.iterations),
    password: asked,
    generated: false,
  };
}

/** `meta.json` stores `access` as an open object; this is the password half. */
export function storedPassword(access: Record<string, unknown>): PasswordRecord | undefined {
  const value = access.password;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Partial<PasswordRecord>;
  if (typeof record.hash !== "string" || typeof record.salt !== "string") return undefined;
  if (typeof record.nonce !== "string" || typeof record.iterations !== "number") return undefined;
  return record as PasswordRecord;
}
