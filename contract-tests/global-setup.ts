import { createHash, randomBytes } from "node:crypto";
import Cloudflare from "cloudflare";
import type { TestProject } from "vitest/node";
import { BASE_URL, DEV_BUCKET, requireEnv } from "./base-url.js";
import { INITIAL_POLICY } from "../packages/worker/src/policy/defaults.js";

/**
 * Every contract run starts from an empty bucket, a seeded instance config, an
 * admin key and a reachable Worker. The reset uses the same two dev
 * credentials as `npm run deploy:dev`.
 *
 * The config and the admin key are written the way `init` writes them —
 * through the R2 API, before the Worker is asked for anything — so the run
 * exercises the real paths (policy from `system/config.json`, auth from
 * `keyhash/`) and never a fallback.
 *
 * The key is minted fresh for each run and handed to the tests through
 * vitest's `provide`. It is never written into the repo and never printed: a
 * key that lived in a file would be a live credential on a real instance.
 */
export default async function setup(project: TestProject) {
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

  // The admin key, exactly as `init` mints it: a key record, its `keyhash/`
  // pointer and the `users/admin` claim, all before the Worker is asked for
  // anything (AGENTS.md, "Credential before deploy").
  const adminKey = randomBytes(32).toString("hex");
  const adminHash = createHash("sha256").update(adminKey).digest("hex");
  const created = new Date().toISOString();
  const put = (key: string, body: unknown) =>
    client.r2.buckets.objects.upload(key, JSON.stringify(body), {
      account_id: accountId,
      bucket_name: DEV_BUCKET,
    });

  await put("keys/admin.json", {
    id: "admin",
    label: "admin",
    scope: "admin",
    hash: adminHash,
    created,
  });
  await put("keyhash/" + adminHash, { id: "admin" });
  await put("users/admin", { id: "admin" });

  project.provide("adminKey", adminKey);

  try {
    await fetch(`${BASE_URL}/_api/v1/health`, { cache: "no-store" });
  } catch (error) {
    throw new Error(
      `${BASE_URL} is unreachable (${(error as Error).message}) — run \`npm run deploy:dev\` first.`,
    );
  }
}
