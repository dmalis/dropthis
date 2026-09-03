import Cloudflare from "cloudflare";
import { BASE_URL, DEV_BUCKET, requireEnv } from "./base-url.js";
import { INITIAL_POLICY } from "../packages/worker/src/policy/defaults.js";

/**
 * Every contract run starts from an empty bucket, a seeded instance config and
 * a reachable Worker. The reset uses the same two dev credentials as
 * `npm run deploy:dev`.
 *
 * The config is written the way `init` writes it — through the R2 API, before
 * the Worker is asked for anything — so the run exercises the real
 * "policy comes from `system/config.json`" path rather than a fallback.
 */
export default async function setup() {
  const accountId = requireEnv("CLOUDFLARE_ACCOUNT_ID");
  const client = new Cloudflare({ apiToken: requireEnv("CLOUDFLARE_API_TOKEN") });

  const keys: string[] = [];
  for await (const object of client.r2.buckets.objects.list(DEV_BUCKET, {
    account_id: accountId,
  })) {
    if (typeof object.key === "string") keys.push(object.key);
  }
  for (const key of keys) {
    await client.r2.buckets.objects.delete(key, {
      account_id: accountId,
      bucket_name: DEV_BUCKET,
    });
  }

  await client.r2.buckets.objects.upload(
    "system/config.json",
    JSON.stringify({
      ...INITIAL_POLICY,
      canonical_url: BASE_URL,
      alias_origins: [],
      instance_name: "dev",
    }),
    { account_id: accountId, bucket_name: DEV_BUCKET },
  );

  try {
    await fetch(`${BASE_URL}/_api/v1/health`, { cache: "no-store" });
  } catch (error) {
    throw new Error(
      `${BASE_URL} is unreachable (${(error as Error).message}) — run \`npm run deploy:dev\` first.`,
    );
  }
}
