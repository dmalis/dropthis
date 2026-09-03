import type Cloudflare from "cloudflare";
import { INITIAL_POLICY } from "../../../worker/src/policy/defaults.js";
import { putObjectJson } from "./r2-objects.js";

export type InstanceIdentity = {
  instanceName: string;
  canonicalUrl: string;
  aliasOrigins: string[];
};

/**
 * Writes `system/config.json`: this instance's identity plus the policy the
 * Worker itself calls initial.
 *
 * The values come from `packages/worker/src/policy/defaults.ts` and are never
 * restated here. Two of them are measured against the Free plan (decision
 * #73), and a second copy in the installer is a copy that goes stale: an
 * instance would then be installed with a policy its own Worker disagrees
 * with, and `doctor`'s `policy_readable` would still call it green.
 */
export async function writeInstanceConfig(
  client: Cloudflare,
  accountId: string,
  bucketName: string,
  identity: InstanceIdentity,
): Promise<void> {
  await putObjectJson(client, accountId, bucketName, "system/config.json", {
    instance_name: identity.instanceName,
    canonical_url: identity.canonicalUrl,
    alias_origins: identity.aliasOrigins,
    ...INITIAL_POLICY,
  });
}
