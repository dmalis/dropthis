/**
 * The slug: the drop's identity and its URL (docs/spec-v1.md, "Slug").
 *
 * A slug is generated unless the caller chose one. A generated slug is ten
 * characters of `a-z0-9` — 36^10 ≈ 3.7e15, so a collision is a curiosity, not a
 * design concern, and the claim on `slugs/<slug>` catches it anyway. A chosen
 * (vanity) slug is 3–40 characters of `a-z0-9-` starting with a letter or
 * digit, which is what a campaign link needs: `/tan-dash` in a newsletter
 * beats `/9ul4jschtk` (decision #94).
 *
 * There is ONE predicate — `isSlug` — because nothing in the product ever has
 * to tell the two apart: routing, the viewer and `resolveTarget` all ask the
 * same question, "could a drop live at this path segment?". The generated form
 * is a subset of the vanity form.
 *
 * Neither form can spell a reserved control-plane prefix: the alphabet
 * excludes `_` and `.`, and `isSlug` refuses a reserved prefix outright so a
 * prefix added later cannot be shadowed by an old rule.
 *
 * Bytes in the biased tail are discarded rather than folded: 256 is not a
 * multiple of 36, so `byte % 36` would hand out `a`–`d` more often than the
 * rest. Rejection sampling costs nothing here and keeps the entropy honest.
 */
import { isReservedPath } from "../reserved.js";

export const SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
export const SLUG_LENGTH = 10;

/** The chosen form's bounds: long enough to read, short enough for a URL. */
export const VANITY_MIN_LENGTH = 3;
export const VANITY_MAX_LENGTH = 40;

/** The largest multiple of the alphabet size that fits in a byte. */
const UNBIASED_LIMIT = 256 - (256 % SLUG_ALPHABET.length);

/**
 * Every shape a slug may have. The leading character is alphanumeric, so a
 * slug can never begin with `-` (nor with `_`, which is not in the set at all).
 */
const SLUG_PATTERN = new RegExp(
  `^[a-z0-9][a-z0-9-]{${VANITY_MIN_LENGTH - 1},${VANITY_MAX_LENGTH - 1}}$`,
);

export type RandomBytes = (buffer: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>;

const webcryptoRandom: RandomBytes = (buffer) => crypto.getRandomValues(buffer);

export class SlugError extends Error {
  readonly code = "INVALID_INPUT" as const;

  constructor(message: string) {
    super(message);
    this.name = "SlugError";
  }
}

export function generateSlug(random: RandomBytes = webcryptoRandom): string {
  let slug = "";
  while (slug.length < SLUG_LENGTH) {
    const block = random(new Uint8Array(SLUG_LENGTH));
    for (const byte of block) {
      if (byte >= UNBIASED_LIMIT) continue;
      slug += SLUG_ALPHABET[byte % SLUG_ALPHABET.length];
      if (slug.length === SLUG_LENGTH) break;
    }
  }
  return slug;
}

export function isSlug(value: string): boolean {
  return SLUG_PATTERN.test(value) && !isReservedPath(`/${value}`);
}

/**
 * The caller's chosen slug, normalized and checked.
 *
 * NFC then lowercase then trim, in that order, and only then validated: the
 * slug is the URL, so `"TAN-Dash "` and `"tan-dash"` must be one link and not
 * two claims on `slugs/`. Anything that does not survive as `[a-z0-9-]` is
 * `INVALID_INPUT` rather than silently transliterated — a slug the caller did
 * not type is a link they cannot predict.
 */
export function normalizeVanitySlug(raw: string): string {
  const normalized = raw.normalize("NFC").toLowerCase().trim();

  if (isReservedPath(`/${normalized}`)) {
    throw new SlugError(`slug ${JSON.stringify(normalized)} is a reserved path on this instance.`);
  }
  if (!SLUG_PATTERN.test(normalized)) {
    throw new SlugError(
      `slug must be ${VANITY_MIN_LENGTH}-${VANITY_MAX_LENGTH} characters of a-z 0-9 and -, ` +
        `starting with a letter or digit; ${JSON.stringify(raw)} normalizes to ` +
        `${JSON.stringify(normalized)}.`,
    );
  }
  return normalized;
}
