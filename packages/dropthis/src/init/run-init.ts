import { bootstrapAdminKey } from "./admin-bootstrap.js";
import { makeClient, type CloudflareCreds } from "./cloudflare-client.js";
import { writeInstanceConfig } from "./config-write.js";
import { applyLifecycleRules } from "./lifecycle-rules.js";
import { renderWranglerConfig, type RenderedWranglerConfig } from "./plan-render.js";
import { checkPermissions, checkR2Subscription, checkToken, pinAccount } from "./preflight.js";
import { reconcileBucket, reconcileNamespace } from "./reconcile.js";
import { getObjectJson } from "./r2-objects.js";
import { generateHmacSecret, secretsFilePayload } from "./secrets.js";

export type InitStepStatus = "ok" | "created" | "would_create" | "skip" | "error";
export type InitStep = { id: string; status: InitStepStatus; detail?: string };

export type RunInitOptions = {
  /** apiToken required; accountId is optional — pinAccount resolves it when absent. */
  creds: CloudflareCreds;
  /** Explicit --account-id: required when the token sees more than one account. */
  accountId?: string;
  name?: string;
  dryRun: boolean;
  deploy: (config: RenderedWranglerConfig, secrets: Record<string, string>) => Promise<void>;
};

export type RunInitResult = {
  ok: boolean;
  name: string;
  worker: string;
  bucket: string;
  kvNamespace: string;
  canonicalUrl?: string;
  steps: InitStep[];
  adminKeyStatus?: "created" | "existing";
  /** present ONLY when freshly minted this run */
  adminKey?: string;
};

/**
 * The init engine's account layer (issue #10, slice 10a): preflight, reconcile
 * bucket + KV by name, admin-key bootstrap before any deploy, lifecycle rules,
 * config write, render, then the injected (thin) deploy step. Domain attach,
 * `doctor` and `connect` are slice 10b.
 */
export async function runInit(options: RunInitOptions): Promise<RunInitResult> {
  const steps: InitStep[] = [];
  const instanceName = options.name ?? "main";
  const worker = `dropthis-${instanceName}`;
  const bucket = `dropthis-${instanceName}-drops`;
  const kvNamespace = `dropthis-${instanceName}-oauth`;
  const failure = (): RunInitResult => ({
    ok: false,
    name: instanceName,
    worker,
    bucket,
    kvNamespace,
    steps,
  });

  const client = makeClient(options.creds);

  const token = await checkToken(client);
  if (!token.ok) {
    steps.push({ id: "token", status: "error", detail: `token status: ${token.status}` });
    return failure();
  }
  steps.push({ id: "token", status: "ok" });

  const pinned = await pinAccount(client, options.accountId ?? options.creds.accountId);
  if (!pinned.ok) {
    steps.push({ id: "account", status: "error", detail: pinned.code });
    return failure();
  }
  const accountId = pinned.accountId;
  steps.push({ id: "account", status: "ok", detail: accountId });

  const r2Sub = await checkR2Subscription(client, accountId);
  if (!r2Sub.ok) {
    steps.push({ id: "r2_subscription", status: "error", detail: r2Sub.dashboardUrl });
    return failure();
  }
  steps.push({ id: "r2_subscription", status: "ok" });

  const permissions = await checkPermissions(client, accountId);
  if (!permissions.ok) {
    steps.push({
      id: "permissions",
      status: "error",
      detail: permissions.missing.map((m) => m.permission).join(", "),
    });
    return failure();
  }
  steps.push({ id: "permissions", status: "ok" });

  const bucketResult = await reconcileBucket(client, accountId, bucket, { dryRun: options.dryRun });
  if (bucketResult.status === "ok") {
    // Pre-existing bucket: only a real rerun of THIS instance if it already
    // carries our config. Otherwise the derived name collided with something
    // dropthis never provisioned (spec-v1.md "Instance resource names").
    const existingConfig = await getObjectJson(client, accountId, bucket, "system/config.json");
    if (!existingConfig) {
      steps.push({ id: "bucket", status: "error", detail: "NAME_TAKEN: bucket exists, not a dropthis instance" });
      return failure();
    }
  }
  steps.push({ id: "bucket", status: bucketResult.status });

  const kvResult = await reconcileNamespace(client, accountId, kvNamespace, { dryRun: options.dryRun });
  steps.push({ id: "kv_namespace", status: kvResult.status });

  if (options.dryRun) {
    steps.push({ id: "deploy", status: "skip", detail: "dry-run" });
    return { ok: true, name: instanceName, worker, bucket, kvNamespace, steps };
  }

  const bootstrap = await bootstrapAdminKey(client, accountId, bucket);
  steps.push({ id: "admin_key", status: bootstrap.status === "created" ? "created" : "ok" });

  await applyLifecycleRules(client, accountId, bucket);
  steps.push({ id: "lifecycle_rules", status: "ok" });

  const { subdomain } = await client.workers.subdomains.get({ account_id: accountId });
  const canonicalUrl = `https://${worker}.${subdomain}.workers.dev`;

  await writeInstanceConfig(client, accountId, bucket, {
    instanceName,
    canonicalUrl,
    aliasOrigins: [],
  });
  steps.push({ id: "config", status: "ok" });

  const kvId = kvResult.id;
  if (kvId === undefined) throw new Error("KV namespace id missing after a non-dry-run reconcile");
  const renderedConfig = await renderWranglerConfig(instanceName, bucket, kvId);
  steps.push({ id: "render", status: "ok" });

  const hmacSecret = generateHmacSecret();
  await options.deploy(renderedConfig, secretsFilePayload(hmacSecret));
  steps.push({ id: "deploy", status: "ok" });

  return {
    ok: true,
    name: instanceName,
    worker,
    bucket,
    kvNamespace,
    canonicalUrl,
    steps,
    adminKeyStatus: bootstrap.status,
    ...(bootstrap.status === "created" ? { adminKey: bootstrap.key } : {}),
  };
}
