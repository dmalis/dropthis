import type Cloudflare from "cloudflare";

/** Cloudflare's own page size for these list endpoints. */
const R2_PAGE_SIZE = 100;
const KV_PAGE_SIZE = 100;

export type ReconcileOptions = { dryRun: boolean };
export type ReconcileStatus = "ok" | "created" | "would_create";
export type BucketReconcileResult = { status: ReconcileStatus; name: string };
export type NamespaceReconcileResult = { status: ReconcileStatus; id: string | undefined };

async function findBucket(client: Cloudflare, accountId: string, name: string) {
  let startAfter: string | undefined;
  for (;;) {
    const params: Parameters<typeof client.r2.buckets.list>[0] = {
      account_id: accountId,
      per_page: R2_PAGE_SIZE,
      order: "name",
      direction: "asc",
      ...(startAfter !== undefined ? { start_after: startAfter } : {}),
    };
    const page = await client.r2.buckets.list(params);
    const buckets = page.buckets ?? [];
    if (buckets.length === 0) return undefined;
    const hit = buckets.find((bucket) => bucket.name === name);
    if (hit) return hit;
    startAfter = buckets[buckets.length - 1]!.name;
  }
}

async function findNamespace(client: Cloudflare, accountId: string, title: string) {
  for await (const namespace of client.kv.namespaces.list({
    account_id: accountId,
    per_page: KV_PAGE_SIZE,
  })) {
    if (namespace.title === title) return namespace;
  }
  return undefined;
}

/** Reconciles the R2 bucket by NAME: reuse if present, else create (unless dry-run). */
export async function reconcileBucket(
  client: Cloudflare,
  accountId: string,
  name: string,
  options: ReconcileOptions,
): Promise<BucketReconcileResult> {
  const existing = await findBucket(client, accountId, name);
  if (existing) return { status: "ok", name };
  if (options.dryRun) return { status: "would_create", name };
  await client.r2.buckets.create({ account_id: accountId, name });
  return { status: "created", name };
}

/** Reconciles the KV namespace by TITLE: reuse if present, else create (unless dry-run). */
export async function reconcileNamespace(
  client: Cloudflare,
  accountId: string,
  title: string,
  options: ReconcileOptions,
): Promise<NamespaceReconcileResult> {
  const existing = await findNamespace(client, accountId, title);
  if (existing) return { status: "ok", id: existing.id };
  if (options.dryRun) return { status: "would_create", id: undefined };
  const namespace = await client.kv.namespaces.create({ account_id: accountId, title });
  return { status: "created", id: namespace.id };
}
