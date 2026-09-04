import { createHash, randomBytes } from "node:crypto";
import type Cloudflare from "cloudflare";
import { getObjectJson, putObjectJson } from "./r2-objects.js";

/**
 * Mints the admin key and writes its three records into the bucket, BEFORE
 * any deploy (AGENTS.md "Bootstrap invariants" / "Credential before deploy").
 * The admin key uses the deterministic id "admin" — there is only ever one —
 * so a crashed prior run is detectable and repairable without a scan.
 *
 * Order (matches spec-v1.md `user add`): keys/<id>.json -> keyhash/<hash> ->
 * users/<label> (the claim). A `keys/admin.json` with no `users/admin` means a
 * prior run crashed mid-way; since the plaintext from that run is gone, this
 * reruns from scratch (fresh key, overwriting the orphan record).
 *
 * `users/admin` existing is NOT on its own proof that the instance has an
 * administrator. The pointer is one of three objects, and the whole chain
 * decides:
 *
 *   users/admin -> keys/<id>.json -> keyhash/<sha256(key)>
 *
 *   - keyhash missing        the record still holds the hash, so the pointer
 *                            is rewritten from it: a safe repair, no key
 *                            changes hands  ->  `repaired`
 *   - key record missing,    nothing here can re-derive a key from a hash that
 *     or naming another id,  is gone, and minting one silently would be a
 *     or not admin scope     rotation nobody asked for. AGENTS.md: "A missing
 *                            key file fails loudly; rotation is explicit."
 *                            ->  `broken`, and `init` stops before the deploy
 */
export type AdminBootstrapResult =
  | { status: "created"; key: string }
  | { status: "existing" | "repaired"; key?: undefined }
  | { status: "broken"; detail: string; remediation: string; key?: undefined };

type KeyRecord = { id?: unknown; label?: unknown; scope?: unknown; hash?: unknown };

/** The one command that is allowed to replace an admin key. */
const ROTATE = "Run `dropthis init --rotate-admin-key` for this instance: it mints a new admin key and revokes whatever is left of the old one.";

export async function bootstrapAdminKey(
  client: Cloudflare,
  accountId: string,
  bucketName: string,
): Promise<AdminBootstrapResult> {
  const existingUser = await getObjectJson<{ id?: unknown }>(client, accountId, bucketName, "users/admin");
  if (existingUser !== undefined) {
    return await checkChain(client, accountId, bucketName, existingUser);
  }

  const key = randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(key).digest("hex");
  const created = new Date().toISOString();

  await putObjectJson(client, accountId, bucketName, "keys/admin.json", {
    id: "admin",
    label: "admin",
    scope: "admin",
    hash,
    created,
  });
  await putObjectJson(client, accountId, bucketName, `keyhash/${hash}`, { id: "admin" });
  await putObjectJson(client, accountId, bucketName, "users/admin", { id: "admin" });

  return { status: "created", key };
}

async function checkChain(
  client: Cloudflare,
  accountId: string,
  bucketName: string,
  pointer: { id?: unknown },
): Promise<AdminBootstrapResult> {
  const id = pointer.id;
  if (typeof id !== "string" || id.length === 0) {
    return broken("users/admin does not name a key id, so this instance has no admin credential on record.");
  }

  const recordKey = `keys/${id}.json`;
  const record = await getObjectJson<KeyRecord>(client, accountId, bucketName, recordKey);
  if (record === undefined) {
    return broken(`users/admin names the key ${id}, but ${recordKey} does not exist, so no key can open this instance.`);
  }
  if (record.id !== id) {
    return broken(`${recordKey} names the key id ${JSON.stringify(record.id)}, not ${id}.`);
  }
  if (record.scope !== "admin") {
    return broken(`${recordKey} has scope ${JSON.stringify(record.scope)}, not "admin".`);
  }
  if (typeof record.hash !== "string" || record.hash.length === 0) {
    return broken(`${recordKey} carries no key hash, so no key can be matched against it.`);
  }

  const hashKey = `keyhash/${record.hash}`;
  const hashPointer = await getObjectJson<{ id?: unknown }>(client, accountId, bucketName, hashKey);
  if (hashPointer === undefined) {
    // The only gap this can close without changing a credential: the record
    // holds the hash, so the lookup pointer is rewritten exactly as it was.
    await putObjectJson(client, accountId, bucketName, hashKey, { id });
    return { status: "repaired" };
  }
  if (hashPointer.id !== id) {
    return broken(`${hashKey} points at the key id ${JSON.stringify(hashPointer.id)}, not ${id}.`);
  }

  return { status: "existing" };
}

const broken = (detail: string): AdminBootstrapResult => ({
  status: "broken",
  detail,
  remediation: ROTATE,
});
