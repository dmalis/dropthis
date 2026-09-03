/**
 * The slug: the drop's identity and its URL (docs/spec-v1.md, "Slug").
 *
 * Ten characters of `a-z0-9` — 36^10 ≈ 3.7e15, so a collision is a curiosity,
 * not a design concern, and the claim on `slugs/<slug>` catches it anyway. The
 * alphabet excludes `_`, which is why a generated slug can never shadow a
 * reserved control-plane prefix.
 *
 * Bytes in the biased tail are discarded rather than folded: 256 is not a
 * multiple of 36, so `byte % 36` would hand out `a`–`d` more often than the
 * rest. Rejection sampling costs nothing here and keeps the entropy honest.
 */

export const SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
export const SLUG_LENGTH = 10;

/** The largest multiple of the alphabet size that fits in a byte. */
const UNBIASED_LIMIT = 256 - (256 % SLUG_ALPHABET.length);

const SLUG_PATTERN = new RegExp(`^[${SLUG_ALPHABET}]{${SLUG_LENGTH}}$`);

export type RandomBytes = (buffer: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>;

const webcryptoRandom: RandomBytes = (buffer) => crypto.getRandomValues(buffer);

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
  return SLUG_PATTERN.test(value);
}
