import type Cloudflare from "cloudflare";
import { putObjectJson } from "./r2-objects.js";

/** spec-v1.md "Instance policy": frozen initial values, safe on the Free plan. */
const FROZEN_DEFAULTS = {
  expiry: { default: "30d", max: "365d", allow_never: true },
  password: { default: null, required: false },
  noindex: { default: true, forced: false },
  max_file_bytes: 104_857_600,
  max_request_bytes: 2_097_152,
  auto_index: "list",
  pbkdf2_iterations: 5000,
  cron_ops_budget: 40,
} as const;

export type InstanceIdentity = {
  instanceName: string;
  canonicalUrl: string;
  aliasOrigins: string[];
};

/** Writes `system/config.json`: the frozen defaults plus this instance's identity. */
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
    ...FROZEN_DEFAULTS,
  });
}
