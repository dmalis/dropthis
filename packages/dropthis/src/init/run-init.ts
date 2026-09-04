import { bootstrapAdminKey } from "./admin-bootstrap.js";
import { makeClient, type CloudflareCreds } from "./cloudflare-client.js";
import { claimBucketForInstance, writeInstanceConfig } from "./config-write.js";
import { attachDomain, matchZone } from "./domain.js";
import { saveInstance } from "./instances-file.js";
import { applyLifecycleRules } from "./lifecycle-rules.js";
import { renderWranglerConfig, type RenderedWranglerConfig } from "./plan-render.js";
import {
  checkDomainPermissions,
  checkPermissions,
  checkR2Subscription,
  checkToken,
  pinAccount,
} from "./preflight.js";
import { pollHealth, runRemoteDoctor, type PollOptions } from "./probe.js";
import { reconcileBucket, reconcileNamespace } from "./reconcile.js";
import { getObjectJson } from "./r2-objects.js";
import { rotateAdminKey } from "./rotate.js";
import { normalizeInstanceName } from "./instance-name.js";
import { generateHmacSecret, secretsFilePayload } from "./secrets.js";
import { workerSecretNames } from "./worker-secrets.js";
import type { Env } from "../cli/credentials.js";
import type { DoctorReport } from "../../../worker/src/operations/doctor.js";

export type InitStepStatus = "ok" | "created" | "would_create" | "skip" | "error";
export type InitStep = { id: string; status: InitStepStatus; detail?: string };

/**
 * What a deploy tells the installer. A real deploy knows nothing wrangler did
 * not already put in the account, so it returns nothing and the URL comes from
 * the account's own workers.dev subdomain — wrangler's stdout is never parsed
 * (AGENTS.md, "Installer principles"). A test's deploy returns the localhost
 * URL of the instance it started, so health and doctor probe the real Worker.
 */
export type DeployOutcome = { url?: string } | void;

/**
 * What the deploy is told about the run it belongs to. `accountId` is the one
 * preflight PINNED, not the one the caller happened to have: with a token that
 * sees exactly one account the caller has none, and a deploy that inherits an
 * empty `CLOUDFLARE_ACCOUNT_ID` lets wrangler choose an account for itself —
 * the one thing AGENTS.md's "never guess the account" rule forbids.
 */
export type DeployContext = { accountId: string };

/** Something only a person with a browser can clear. */
export type InitWall = { id: "r2_subscription"; url: string };

export type RunInitOptions = {
  /** apiToken required; accountId is optional — pinAccount resolves it when absent. */
  creds: CloudflareCreds;
  /** Explicit --account-id: required when the token sees more than one account. */
  accountId?: string;
  name?: string;
  dryRun: boolean;
  /** `--domain <hostname>`: validated before any deploy, attached after one. */
  domain?: string;
  /** `--rotate-admin-key`: mint a new admin key and revoke the old one. */
  rotateAdminKey?: boolean;
  /**
   * The key already stored for this instance. A rerun cannot re-derive it (it
   * is stored hashed), so without one `doctor` is skipped rather than guessed.
   */
  existingKey?: string;
  /** When given, the run saves the instance to `instances.json` under it. */
  env?: Env;
  poll?: PollOptions;
  /**
   * A human-only wall (decision #67): the installer opens the exact dashboard
   * page and waits. `retry` re-checks, `stop` ends the run. Absent means
   * non-interactive: the wall is reported with the same URL and nothing waits.
   */
  onWall?: (wall: InitWall) => Promise<"retry" | "stop">;
  /** `--jsonl`: one event per step, as it completes. */
  onStep?: (step: InitStep) => void;
  deploy: (
    config: RenderedWranglerConfig,
    secrets: Record<string, string> | undefined,
    context: DeployContext,
  ) => Promise<DeployOutcome>;
};

export type RunInitResult = {
  ok: boolean;
  name: string;
  worker: string;
  bucket: string;
  kvNamespace: string;
  canonicalUrl?: string;
  aliasOrigins?: string[];
  domain?: string;
  steps: InitStep[];
  adminKeyStatus?: "created" | "existing" | "rotated";
  /** present ONLY when freshly minted or rotated this run */
  adminKey?: string;
  doctor?: DoctorReport;
  instancesFile?: string;
};

/**
 * The init engine: preflight, reconcile bucket + KV by name, admin-key
 * bootstrap before any deploy, lifecycle rules, config, render, deploy — and
 * then the part that makes "deployed" mean "works": attach the domain, wait
 * for the instance to answer, run its own `doctor`, and save it to
 * `instances.json`.
 *
 * Nothing in here prompts, opens a browser or reads the terminal. The command
 * layer (`cli/init-command.ts`) owns credentials, interactivity and output;
 * this owns the account and the instance.
 */
export async function runInit(options: RunInitOptions): Promise<RunInitResult> {
  const steps: InitStep[] = [];
  const push = (step: InitStep): InitStep => {
    steps.push(step);
    options.onStep?.(step);
    return step;
  };
  // The engine normalises too: `runInitCommand` is one caller, and every
  // resource name below is derived from this string.
  const instanceName = options.name === undefined ? "main" : normalizeInstanceName(options.name);
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
    push({ id: "token", status: "error", detail: `token status: ${token.status}` });
    return failure();
  }
  push({ id: "token", status: "ok" });

  const pinned = await pinAccount(client, options.accountId ?? options.creds.accountId);
  if (!pinned.ok) {
    push({ id: "account", status: "error", detail: pinned.code });
    return failure();
  }
  const accountId = pinned.accountId;
  push({ id: "account", status: "ok", detail: accountId });

  const r2 = await clearWall(
    { id: "r2_subscription", url: `https://dash.cloudflare.com/${accountId}/r2` },
    () => checkR2Subscription(client, accountId).then((check) => check.ok),
    options.onWall,
  );
  if (!r2.ok) {
    push({
      id: "r2_subscription",
      status: "error",
      detail: `R2 is not enabled on this account. Enable it at ${r2.url}, then run init again.`,
    });
    return failure();
  }
  push({ id: "r2_subscription", status: "ok" });

  /**
   * The domain's read-only half runs BEFORE anything is deployed: a hostname
   * in someone else's zone, or one that already has a DNS record, must cost
   * the operator nothing. The write half needs the script to exist, so it
   * happens after the deploy.
   *
   * The zone is matched before the permission probes because `--domain` adds
   * two permissions the account-level probes never touch, and both of those
   * reads need a zone id. One `permissions` step then covers every permission
   * this run will use — the alternative is provisioning and deploying for a
   * token that could never have finished (AGENTS.md, "Preflight names the
   * dashboard permission, not the HTTP code").
   */
  let domainZone: { id: string; name: string } | undefined;
  if (options.domain !== undefined) {
    const zone = await matchZone(client, accountId, options.domain);
    if (!zone.ok) {
      push({ id: "domain", status: "error", detail: `${zone.detail} ${zone.remediation}` });
      return failure();
    }
    domainZone = zone.zone;
  }

  const missing = [...(await checkPermissions(client, accountId)).missing];
  if (options.domain !== undefined && domainZone !== undefined) {
    missing.push(
      ...(await checkDomainPermissions(client, accountId, domainZone.id, options.domain)).missing,
    );
  }
  if (missing.length > 0) {
    push({ id: "permissions", status: "error", detail: missing.map((m) => m.permission).join(", ") });
    return failure();
  }
  push({ id: "permissions", status: "ok" });

  if (options.domain !== undefined && domainZone !== undefined) {
    for await (const record of client.dns.records.list({
      zone_id: domainZone.id,
      name: { exact: options.domain },
    })) {
      const taken = await isOurs(client, accountId, worker, options.domain);
      if (!taken) {
        push({
          id: "domain",
          status: "error",
          detail: `A ${String(record.type)} record already exists at ${options.domain}. Remove it in the Cloudflare dashboard, then run init again.`,
        });
        return failure();
      }
      break;
    }
  }


  const bucketResult = await reconcileBucket(client, accountId, bucket, { dryRun: options.dryRun });
  if (bucketResult.status === "created") {
    // The ownership marker, written before anything else in this run can fail:
    // a bucket with no config reads as a stranger's, and a run that died here
    // would leave every rerun answering NAME_TAKEN.
    await claimBucketForInstance(client, accountId, bucket, instanceName);
  }
  if (bucketResult.status === "ok") {
    // Pre-existing bucket: only a real rerun of THIS instance if it already
    // carries our config. Otherwise the derived name collided with something
    // dropthis never provisioned (spec-v1.md "Instance resource names").
    const existingConfig = await getObjectJson(client, accountId, bucket, "system/config.json");
    if (!existingConfig) {
      push({
        id: "bucket",
        status: "error",
        detail: `NAME_TAKEN: the bucket ${bucket} exists but holds no system/config.json, so dropthis did not create it. Rename this instance with --name <other>, or delete that bucket if it is an empty leftover.`,
      });
      return failure();
    }
  }
  push({ id: "bucket", status: bucketResult.status });

  const kvResult = await reconcileNamespace(client, accountId, kvNamespace, { dryRun: options.dryRun });
  push({ id: "kv_namespace", status: kvResult.status });

  if (options.dryRun) {
    if (options.domain !== undefined) {
      push({ id: "domain", status: "would_create", detail: `${options.domain} in zone ${domainZone!.name}` });
    }
    push({ id: "deploy", status: "skip", detail: "dry-run" });
    return { ok: true, name: instanceName, worker, bucket, kvNamespace, steps };
  }

  const rotate = options.rotateAdminKey === true;
  let adminKey: string | undefined;
  let adminKeyStatus: "created" | "existing" | "rotated";
  if (rotate) {
    const rotated = await rotateAdminKey(client, accountId, bucket);
    adminKey = rotated.key;
    adminKeyStatus = "rotated";
    push({ id: "admin_key", status: "created", detail: "rotated" });
  } else {
    const bootstrap = await bootstrapAdminKey(client, accountId, bucket);
    // A chain that cannot open the instance is a broken deploy, and no key
    // here can be re-derived: AGENTS.md, "A missing key file fails loudly;
    // rotation is explicit." So the run stops, before wrangler is called.
    if (bootstrap.status === "broken") {
      push({ id: "admin_key", status: "error", detail: `${bootstrap.detail} ${bootstrap.remediation}` });
      return failure();
    }
    adminKey = bootstrap.status === "created" ? bootstrap.key : undefined;
    adminKeyStatus = bootstrap.status === "created" ? "created" : "existing";
    push({
      id: "admin_key",
      status: bootstrap.status === "created" ? "created" : "ok",
      ...(bootstrap.status === "repaired" ? { detail: "repaired the keyhash pointer" } : {}),
    });
  }

  await applyLifecycleRules(client, accountId, bucket);
  push({ id: "lifecycle_rules", status: "ok" });

  const { subdomain } = await client.workers.subdomains.get({ account_id: accountId });
  const workersDevUrl = `https://${worker}.${subdomain}.workers.dev`;
  // With a domain the drop URLs are the domain's, and workers.dev stays an
  // alias so a request that arrives there redirects instead of 404ing.
  const canonicalUrl = options.domain === undefined ? workersDevUrl : `https://${options.domain}`;
  const aliasOrigins = options.domain === undefined ? [] : [workersDevUrl];

  await writeInstanceConfig(client, accountId, bucket, { instanceName, canonicalUrl, aliasOrigins });
  push({ id: "config", status: "ok" });

  const kvId = kvResult.id;
  if (kvId === undefined) throw new Error("KV namespace id missing after a non-dry-run reconcile");
  const renderedConfig = await renderWranglerConfig(instanceName, bucket, kvId);
  push({ id: "render", status: "ok" });

  /**
   * `HMAC_SECRET` is shipped only when the Worker has none. Re-shipping it on
   * a rerun would invalidate every unlock cookie, every signed upload URL and
   * every stored idempotency result — silently, and with no way back.
   */
  const secretNames = await workerSecretNames(client, accountId, worker);
  const shipSecret = secretNames === undefined || !secretNames.includes("HMAC_SECRET");
  const secrets = shipSecret ? secretsFilePayload(generateHmacSecret()) : undefined;
  const deployed = await options.deploy(renderedConfig, secrets, { accountId });
  push({
    id: "deploy",
    status: "ok",
    detail: shipSecret ? "HMAC_SECRET shipped" : "HMAC_SECRET reused from the deployed Worker",
  });

  let ok = true;
  if (options.domain !== undefined) {
    const attached = await attachDomain(client, accountId, worker, options.domain);
    if (attached.ok) {
      push({ id: "domain", status: attached.created ? "created" : "ok", detail: options.domain });
    } else {
      // The config already names this domain as canonical; put it back so the
      // instance never advertises a host it does not answer on.
      await writeInstanceConfig(client, accountId, bucket, {
        instanceName,
        canonicalUrl: workersDevUrl,
        aliasOrigins: [],
      });
      push({ id: "domain", status: "error", detail: `${attached.detail} ${attached.remediation}` });
      ok = false;
    }
  }

  const probeUrl = (deployed ?? {}).url ?? (ok ? canonicalUrl : workersDevUrl);
  const health = await pollHealth(probeUrl, options.poll ?? {});
  push({ id: "health", status: health.ok ? "ok" : "error", detail: health.detail });
  if (!health.ok) ok = false;

  const doctorKey = adminKey ?? options.existingKey;
  let report: DoctorReport | undefined;
  if (!health.ok) {
    push({ id: "doctor", status: "skip", detail: "the instance never answered, so there was nothing to check" });
  } else if (doctorKey === undefined) {
    push({
      id: "doctor",
      status: "skip",
      detail:
        "no admin key in hand for this instance: it is stored hashed and cannot be re-derived. Run with --rotate-admin-key, or run `dropthis doctor` with the key you kept.",
    });
  } else {
    report = await runRemoteDoctor(probeUrl, doctorKey);
    const failed = report.checks.filter((check) => check.status === "fail");
    push({
      id: "doctor",
      status: report.ok ? "ok" : "error",
      detail: report.ok
        ? `${report.checks.length} checks passed`
        : failed.map((check) => `${check.id}: ${check.evidence}`).join("; "),
    });
    if (!report.ok) ok = false;
  }

  let instancesFile: string | undefined;
  if (options.env === undefined || doctorKey === undefined) {
    push({
      id: "instances_file",
      status: "skip",
      detail:
        doctorKey === undefined
          ? "no key to store: this rerun did not mint one"
          : "no config home to write to",
    });
  } else {
    const saved = await saveInstance(options.env, instanceName, { url: canonicalUrl, key: doctorKey });
    instancesFile = saved.path;
    push({
      id: "instances_file",
      status: "ok",
      detail: saved.isDefault ? `${saved.path} (default)` : saved.path,
    });
  }

  return {
    ok,
    name: instanceName,
    worker,
    bucket,
    kvNamespace,
    canonicalUrl,
    aliasOrigins,
    ...(options.domain === undefined ? {} : { domain: options.domain }),
    steps,
    adminKeyStatus,
    ...(adminKey === undefined ? {} : { adminKey }),
    ...(report === undefined ? {} : { doctor: report }),
    ...(instancesFile === undefined ? {} : { instancesFile }),
  };
}

/**
 * A wall an operator has to clear in a browser. With a handler the installer
 * opens the page, waits for the handler, and re-checks — bounded, because a
 * loop with no end is the one failure mode an unattended run cannot report.
 * With no handler it fails at once and names the same page.
 */
const WALL_ATTEMPTS = 20;

async function clearWall(
  wall: InitWall,
  check: () => Promise<boolean>,
  onWall: ((wall: InitWall) => Promise<"retry" | "stop">) | undefined,
): Promise<{ ok: boolean; url: string }> {
  if (await check()) return { ok: true, url: wall.url };
  if (onWall === undefined) return { ok: false, url: wall.url };

  for (let attempt = 0; attempt < WALL_ATTEMPTS; attempt += 1) {
    if ((await onWall(wall)) === "stop") return { ok: false, url: wall.url };
    if (await check()) return { ok: true, url: wall.url };
  }
  return { ok: false, url: wall.url };
}

/** Is the hostname already attached to THIS Worker? Then a record at it is ours. */
async function isOurs(
  client: ReturnType<typeof makeClient>,
  accountId: string,
  worker: string,
  hostname: string,
): Promise<boolean> {
  for await (const domain of client.workers.domains.list({ account_id: accountId, hostname })) {
    return domain.service === worker;
  }
  return false;
}
