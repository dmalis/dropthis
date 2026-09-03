import type Cloudflare from "cloudflare";

/**
 * Thin R2-object helpers over the Cloudflare management API's object
 * upload/get endpoints (never the S3 API, never a Worker binding — the
 * installer runs before any Worker is deployed). JSON in, JSON out.
 */

export async function putObjectJson(
  client: Cloudflare,
  accountId: string,
  bucketName: string,
  key: string,
  value: unknown,
): Promise<void> {
  const body = new TextEncoder().encode(JSON.stringify(value));
  await client.r2.buckets.objects.upload(key, body, {
    account_id: accountId,
    bucket_name: bucketName,
  });
}

export async function getObjectJson<T>(
  client: Cloudflare,
  accountId: string,
  bucketName: string,
  key: string,
): Promise<T | undefined> {
  try {
    const response = await client.r2.buckets.objects.get(key, {
      account_id: accountId,
      bucket_name: bucketName,
    });
    const text = await response.text();
    return JSON.parse(text) as T;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

/** Delete tolerates a missing key: every caller here is a resumable repair. */
export async function deleteObject(
  client: Cloudflare,
  accountId: string,
  bucketName: string,
  key: string,
): Promise<void> {
  try {
    await client.r2.buckets.objects.delete(key, { account_id: accountId, bucket_name: bucketName });
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status?: number }).status === 404
  );
}
