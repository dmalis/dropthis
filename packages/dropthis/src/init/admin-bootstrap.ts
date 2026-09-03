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
 * users/<label> (the claim). `users/admin` existing means bootstrap already
 * completed: the key is never re-derivable from its hash, so a rerun reports
 * `existing` and returns no key. A `keys/admin.json` with no `users/admin`
 * means a prior run crashed mid-way; since the plaintext from that run is
 * gone, this reruns from scratch (fresh key, overwriting the orphan record).
 */
export type AdminBootstrapResult =
  | { status: "created"; key: string }
  | { status: "existing"; key?: undefined };

export async function bootstrapAdminKey(
  client: Cloudflare,
  accountId: string,
  bucketName: string,
): Promise<AdminBootstrapResult> {
  const existingUser = await getObjectJson<{ id: string }>(client, accountId, bucketName, "users/admin");
  if (existingUser) return { status: "existing" };

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
