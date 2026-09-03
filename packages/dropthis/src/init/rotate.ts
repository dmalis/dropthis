/**
 * `init --rotate-admin-key` — replace the admin credential without ever
 * leaving the instance without one (AGENTS.md, "Installer principles").
 *
 * The order is the whole design, because there is no transaction across four
 * objects:
 *
 *   1. write the NEW record and its `keyhash/` pointer   (new key works; old still works)
 *   2. write `users/admin` = {id: new, previous: old}    (the switch, and the repair note)
 *   3. delete the OLD `keyhash/` pointer                 (the revocation — old key stops working)
 *   4. delete the OLD record
 *   5. write `users/admin` = {id: new}                   (the rotation is finished)
 *
 * A crash anywhere leaves state a later run can finish: `previous` names the
 * records still to remove, and a rerun does the deletes BEFORE minting
 * anything, so a chain of interrupted rotations cannot leave two live keys.
 * The one order that is never allowed is deleting before writing — that is the
 * window in which nobody can administer the instance.
 *
 * Step 5 is a second write of one key in the same run. AGENTS.md's measured
 * R2 rule is about writes IN FLIGHT at once ("five writes issued one after
 * another at full speed all succeed"), and these are strictly sequential; if
 * it is refused anyway, `previous` simply stays and the next run clears it,
 * which is the same repair the crash path uses.
 */
import { createHash, randomBytes } from "node:crypto";
import type Cloudflare from "cloudflare";
import { deleteObject, getObjectJson, putObjectJson } from "./r2-objects.js";

export type RotateResult = { id: string; key: string; previousId: string };

export type RotateOptions = {
  /** Fault injection: stop mid-rotation so a test can prove the repair path. */
  stopAfter?: "claim";
};

type KeyRecord = { id: string; label: string; scope: string; hash: string; created: string };
type UserPointer = { id: string; previous?: string };

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
  if (typeof pointer.previous === "string" && pointer.previous.length > 0) {
    await revoke(client, accountId, bucket, pointer.previous);
    await putObjectJson(client, accountId, bucket, "users/admin", { id: pointer.id });
  }

  const previousId = pointer.id;
  const id = `admin-${randomBytes(8).toString("hex")}`;
  const key = randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(key).digest("hex");

  await putObjectJson(client, accountId, bucket, `keys/${id}.json`, {
    id,
    label: "admin",
    scope: "admin",
    hash,
    created: new Date().toISOString(),
  } satisfies KeyRecord);
  await putObjectJson(client, accountId, bucket, `keyhash/${hash}`, { id });

  await putObjectJson(client, accountId, bucket, "users/admin", { id, previous: previousId });
  if (options.stopAfter === "claim") return { id, key, previousId };

  await revoke(client, accountId, bucket, previousId);
  await putObjectJson(client, accountId, bucket, "users/admin", { id });

  return { id, key, previousId };
}

/** Revocation first (`keyhash/`), then the record: the reverse leaves a live key. */
async function revoke(client: Cloudflare, accountId: string, bucket: string, id: string): Promise<void> {
  const record = await getObjectJson<KeyRecord>(client, accountId, bucket, `keys/${id}.json`);
  if (record !== undefined && typeof record.hash === "string") {
    await deleteObject(client, accountId, bucket, `keyhash/${record.hash}`);
  }
  await deleteObject(client, accountId, bucket, `keys/${id}.json`);
}
