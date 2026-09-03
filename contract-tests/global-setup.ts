import Cloudflare from "cloudflare";
import { BASE_URL, DEV_BUCKET, requireEnv } from "./base-url.js";

/**
 * Every contract run starts from an empty bucket and a reachable Worker.
 * The reset uses the same two dev credentials as `npm run deploy:dev`.
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

  try {
    await fetch(`${BASE_URL}/_api/v1/health`, { cache: "no-store" });
  } catch (error) {
    throw new Error(
      `${BASE_URL} is unreachable (${(error as Error).message}) — run \`npm run deploy:dev\` first.`,
    );
  }
}
