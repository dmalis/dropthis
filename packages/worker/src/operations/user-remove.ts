/**
 * `user remove` — end a person's access in one call (docs/spec-v1.md, story
 * 53).
 *
 * Delete order is the reverse of `user add`, and it is the order that makes an
 * interrupted removal safe:
 *
 *   1  `keyhash/<hash>`   ACCESS ENDS HERE. Every request resolves through this
 *                         pointer, so the very next call from that key is 401 —
 *                         including every OAuth session behind it, because a
 *                         token resolves to a key id and is re-checked.
 *   2  `keys/<id>.json`   the record.
 *   3  `users/<label>`    the claim, freeing the label for a new person.
 *
 * Every step tolerates a missing key, so a rerun finishes what a crash left —
 * and a rerun of a removal that is already complete is a 204, not a 404. The
 * label is normalized the same way `user add` normalized it: "Anna Maria"
 * removes the person added as "anna-maria".
 */
import { parseKeyRecord } from "../auth/caller.js";
import type { Bucket } from "../bindings.js";
import { normalizeLabel, LabelError } from "../domain/label.js";
import { ApiError } from "../errors.js";
import { keyHashKey, keyRecordKey, userKey } from "../storage/keys.js";

/** The one label a `user remove` may never take away. */
export const ADMIN_LABEL = "admin";

export async function removeUser(rawLabel: string, bucket: Bucket): Promise<void> {
  let label: string;
  try {
    label = normalizeLabel(rawLabel);
  } catch (error) {
    if (error instanceof LabelError) throw new ApiError("INVALID_INPUT", error.message);
    throw error;
  }

  if (label === ADMIN_LABEL) {
    throw new ApiError(
      "INVALID_INPUT",
      "The admin key cannot be removed; rotate it with `init --rotate-admin-key` instead.",
    );
  }

  const pointer = await bucket.get(userKey(label));
  const id = pointer === null ? null : idOf(await pointer.text());

  const record =
    id === null ? null : await bucket.get(keyRecordKey(id)).then((object) => object?.text() ?? null);
  const parsed = record === null ? null : parseKeyRecord(record);

  // Nothing at all is SUCCESS, not a 404: a removal that already happened has
  // nothing left to finish, and after the fact "already removed" and "never
  // existed" are the same bucket state. DELETE is idempotent everywhere else in
  // this product, and the tool text has always promised it here (issue #24,
  // finding 16).
  if (parsed !== null) await bucket.delete(keyHashKey(parsed.hash));
  if (id !== null) await bucket.delete(keyRecordKey(id));
  await bucket.delete(userKey(label));
}

function idOf(body: string): string | null {
  const text = body.trim();
  if (text.length === 0) return null;
  if (!text.startsWith("{")) return text;
  try {
    const parsed = JSON.parse(text) as { id?: unknown };
    return typeof parsed.id === "string" && parsed.id.length > 0 ? parsed.id : null;
  } catch {
    return null;
  }
}
