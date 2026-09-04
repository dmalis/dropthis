import type Cloudflare from "cloudflare";
import { INITIAL_POLICY } from "../../../worker/src/policy/defaults.js";
import { getObjectJson, putObjectJson } from "./r2-objects.js";

export type InstanceIdentity = {
  instanceName: string;
  canonicalUrl: string;
  aliasOrigins: string[];
};

/** The keys `writeInstanceConfig` owns; everything else in the file survives. */
type StoredConfig = Record<string, unknown>;

/**
 * `system/config.json` is also the proof that a bucket with a derived name is
 * OURS: `run-init` answers `NAME_TAKEN` for a bucket that has no config, so a
 * run that created the bucket and then died would otherwise be unrepairable
 * (the rerun sees a stranger's bucket). This writes the ownership marker in
 * the same breath as the create, before anything else can fail — the instance
 * name and the initial policy, and none of the identity the run has not
 * resolved yet.
 *
 * It never overwrites an existing config: on that path the bucket was already
 * ours and its policy is the operator's.
 */
export async function claimBucketForInstance(
  client: Cloudflare,
  accountId: string,
  bucketName: string,
  instanceName: string,
): Promise<void> {
  const existing = await getObjectJson<StoredConfig>(client, accountId, bucketName, "system/config.json");
  if (existing !== undefined) return;
  await putObjectJson(client, accountId, bucketName, "system/config.json", {
    instance_name: instanceName,
    ...INITIAL_POLICY,
  });
}

/**
 * Writes `system/config.json`: this instance's identity plus, on a NEW config,
 * the policy the Worker itself calls initial.
 *
 * The values come from `packages/worker/src/policy/defaults.ts` and are never
 * restated here. Two of them are measured against the Free plan (decision
 * #73), and a second copy in the installer is a copy that goes stale: an
 * instance would then be installed with a policy its own Worker disagrees
 * with, and `doctor`'s `policy_readable` would still call it green.
 *
 * On a RERUN the stored policy wins. Policy is the operator's: `config set`
 * changes what future calls resolve to (AGENTS.md, "Instance policy"), and an
 * `init` rerun is a reconcile of resources, not an operator changing their
 * mind. Only the identity — name, canonical origin, aliases — is rewritten,
 * because only this run knows it. A field the stored config is missing is
 * filled from the initial policy, so a config written by an older installer
 * gains new keys instead of leaving the Worker to default them.
 */
export async function writeInstanceConfig(
  client: Cloudflare,
  accountId: string,
  bucketName: string,
  identity: InstanceIdentity,
): Promise<void> {
  const existing =
    (await getObjectJson<StoredConfig>(client, accountId, bucketName, "system/config.json")) ?? {};
  await putObjectJson(client, accountId, bucketName, "system/config.json", {
    ...INITIAL_POLICY,
    ...existing,
    instance_name: identity.instanceName,
    canonical_url: identity.canonicalUrl,
    alias_origins: identity.aliasOrigins,
  });
}
