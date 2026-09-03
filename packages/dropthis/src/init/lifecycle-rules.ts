import type Cloudflare from "cloudflare";

const DAY_SECONDS = 86_400;

/**
 * The three lifecycle rules AGENTS.md "Pruning" requires (abandoned uploads
 * are R2 lifecycle rules, never a human): `uploads/` metadata expires after
 * 1 day, `requests/` idempotency records after 7 days, and any incomplete
 * multipart upload anywhere in the bucket is aborted after 1 day. `update`
 * replaces the whole rule set, so calling this again is a no-op.
 */
export async function applyLifecycleRules(
  client: Cloudflare,
  accountId: string,
  bucketName: string,
): Promise<void> {
  await client.r2.buckets.lifecycle.update(bucketName, {
    account_id: accountId,
    rules: [
      {
        id: "uploads-expire-1d",
        enabled: true,
        conditions: { prefix: "uploads/" },
        deleteObjectsTransition: { condition: { type: "Age", maxAge: DAY_SECONDS } },
      },
      {
        id: "requests-expire-7d",
        enabled: true,
        conditions: { prefix: "requests/" },
        deleteObjectsTransition: { condition: { type: "Age", maxAge: 7 * DAY_SECONDS } },
      },
      {
        id: "abort-incomplete-multipart-1d",
        enabled: true,
        conditions: { prefix: "" },
        abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: DAY_SECONDS } },
      },
    ],
  });
}
