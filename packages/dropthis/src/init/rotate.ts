/**
 * `init --rotate-admin-key` — replace the admin credential without ever
 * leaving the instance without one, and without ever leaving a usable key
 * nothing knows about (AGENTS.md, "Installer principles").
 *
 * There is no transaction across four objects and, unlike the Worker's R2
 * binding, the Cloudflare R2 management API this installer writes through has
 * no conditional write: `If-Match` on its object-upload endpoint is IGNORED
 * (measured against real R2, 2026-09-04: a put with a bogus etag answered 200
 * and replaced the object). So the safety comes from the ORDER plus a written
 * intent, not from a compare-and-swap:
 *
 *   1. write `users/admin` = {id: old, pending: new}   (the intent — nothing changed yet)
 *   2. write the NEW record and its `keyhash/`         (new key works; old still works)
 *   3. write `users/admin` = {id: new, previous: old}  (the switch, and the repair note)
 *   4. delete the OLD `keyhash/`                       (the revocation — old key stops working)
 *   5. delete the OLD record
 *   6. write `users/admin` = {id: new}                 (the rotation is finished)
 *
 * Every crash leaves state a later run can finish, and `users/admin` names
 * every key that can open the instance at every instant: `pending` names one
 * about to become usable, `previous` names one still to remove. A rerun does
 * both repairs BEFORE minting anything, so a chain of interrupted rotations
 * cannot leave two live keys. The two orders that are never allowed are
 * minting before the intent (a usable key nothing names) and deleting before
 * writing (a window in which nobody can administer the instance).
 *
 * Steps 1, 3 and 6 write one key three times in a run. AGENTS.md's measured
 * R2 rule is about writes IN FLIGHT at once ("five writes issued one after
 * another at full speed all succeed"), and these are strictly sequential; if
 * one is refused anyway, the marker simply stays and the next run clears it,
 * which is the same repair the crash path uses.
 */
import { createHash, randomBytes } from "node:crypto";
import type Cloudflare from "cloudflare";
import { deleteObject, getObjectJson, putObjectJson } from "./r2-objects.js";

export type RotateResult = { id: string; key: string; previousId: string };

export type RotateOptions = {
  /**
   * Fault injection: stop mid-rotation so a test can prove each repair path.
   * `intent` = after the note and before the key exists; `mint` = after the
   * new key works and before it is named; `claim` = after the switch.
   */
  stopAfter?: "intent" | "mint" | "claim";
};

type KeyRecord = { id: string; label: string; scope: string; hash: string; created: string };
type UserPointer = { id: string; previous?: string; pending?: string };

export async function rotateAdminKey(
  client: Cloudflare,
  accountId: string,
  bucket: string,
  options: RotateOptions = {},
): Promise<RotateResult> {
  const pointer = await getObjectJson<UserPointer>(client, accountId, bucket, "users/admin");
  if (pointer === undefined || typeof pointer.id !== "string") {
    throw new Error(
      "users/admin does not name an admin key, so there is nothing to rotate. Run `dropthis init` for this instance first.",
    );
  }

  // A rerun finishes the previous rotation before starting one of its own.
  const previousId = await finishRotation(client, accountId, bucket, pointer);

  const id = `admin-${randomBytes(8).toString("hex")}`;
  const key = randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(key).digest("hex");
  const result: RotateResult = { id, key, previousId };

  // The intent, before the key can open anything: a crash from here on always
  // leaves the new id written down, so a rerun can revoke it.
  await putObjectJson(client, accountId, bucket, "users/admin", { id: previousId, pending: id });
  if (options.stopAfter === "intent") return result;

  await putObjectJson(client, accountId, bucket, `keys/${id}.json`, {
    id,
    label: "admin",
    scope: "admin",
    hash,
    created: new Date().toISOString(),
  } satisfies KeyRecord);
  await putObjectJson(client, accountId, bucket, `keyhash/${hash}`, { id });
  if (options.stopAfter === "mint") return result;

  await putObjectJson(client, accountId, bucket, "users/admin", { id, previous: previousId });
  if (options.stopAfter === "claim") return result;

  await revoke(client, accountId, bucket, previousId);
  await putObjectJson(client, accountId, bucket, "users/admin", { id });

  return result;
}

/**
 * Clear whatever a crashed run left behind and return the id that is actually
 * the admin key now. `pending` is revoked (it was never switched to, so the
 * pointer's own id is still the admin); `previous` is revoked (the switch
 * happened, so the pointer's id is the admin). Both revokes tolerate a key
 * that was never written — `pending` names an intent, not a fact.
 */
async function finishRotation(
  client: Cloudflare,
  accountId: string,
  bucket: string,
  pointer: UserPointer,
): Promise<string> {
  const stale = [pointer.pending, pointer.previous].filter(
    (id): id is string => typeof id === "string" && id.length > 0 && id !== pointer.id,
  );
  if (stale.length === 0) return pointer.id;

  for (const id of stale) await revoke(client, accountId, bucket, id);
  await putObjectJson(client, accountId, bucket, "users/admin", { id: pointer.id });
  return pointer.id;
}

/** Revocation first (`keyhash/`), then the record: the reverse leaves a live key. */
async function revoke(client: Cloudflare, accountId: string, bucket: string, id: string): Promise<void> {
  const record = await getObjectJson<KeyRecord>(client, accountId, bucket, `keys/${id}.json`);
  if (record !== undefined && typeof record.hash === "string") {
    await deleteObject(client, accountId, bucket, `keyhash/${record.hash}`);
  }
  await deleteObject(client, accountId, bucket, `keys/${id}.json`);
}
