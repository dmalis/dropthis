/**
 * `init --check` — the checks that need the CLOUDFLARE token, not an instance
 * key (decision #29, AGENTS.md "Operation registry").
 *
 * `doctor` proves the instance from the inside and is answerable with the
 * instance key alone, which is what an operator running it against a client's
 * instance holds. These three questions are about the ACCOUNT — did the
 * lifecycle rules land, does the deployed Worker bind the KV namespace we
 * reconciled, is the domain attached to OUR Worker — and only a token can ask
 * them. Same row shape as `doctor`, so an agent parses one thing.
 *
 * A check whose subject does not exist is `skip`, never `pass`: green has to
 * mean "this was proved".
 */
import type Cloudflare from "cloudflare";
import { getObjectJson } from "./r2-objects.js";

export type AccountCheckId = "lifecycle_rules" | "kv_bound" | "domain_attached";
export type AccountCheckStatus = "pass" | "fail" | "skip";

export type AccountCheck = {
  id: AccountCheckId;
  status: AccountCheckStatus;
  evidence: string;
  remediation?: string;
};

export type AccountCheckReport = { ok: boolean; checks: AccountCheck[] };

export type AccountCheckInput = { name: string; domain?: string };

/** The three rules `applyLifecycleRules` writes; any missing one is a fail. */
const REQUIRED_RULE_IDS = ["uploads-expire-1d", "requests-expire-7d", "abort-incomplete-multipart-1d"];

export async function runAccountChecks(
  client: Cloudflare,
  accountId: string,
  input: AccountCheckInput,
): Promise<AccountCheckReport> {
  const worker = `dropthis-${input.name}`;
  const bucket = `dropthis-${input.name}-drops`;
  const kvTitle = `dropthis-${input.name}-oauth`;

  // With no --domain, the instance's own config says which hostname it
  // advertises. An operator checking an instance someone else installed does
  // not know it, and a `workers.dev` origin means there is nothing to attach.
  const domain = input.domain ?? (await storedDomain(client, accountId, bucket));

  const checks: AccountCheck[] = [
    await lifecycleRules(client, accountId, bucket),
    await kvBound(client, accountId, worker, kvTitle),
    await domainAttached(client, accountId, worker, domain),
  ];

  return { ok: checks.every((check) => check.status !== "fail"), checks };
}

async function lifecycleRules(
  client: Cloudflare,
  accountId: string,
  bucket: string,
): Promise<AccountCheck> {
  let ids: string[];
  try {
    const response = await client.r2.buckets.lifecycle.get(bucket, { account_id: accountId });
    ids = (response.rules ?? []).map((rule) => String(rule.id));
  } catch (error) {
    return {
      id: "lifecycle_rules",
      status: "fail",
      evidence: `The lifecycle rules on ${bucket} could not be read: ${message(error)}`,
      remediation: `Run \`dropthis init\` for this instance; it sets the rules on ${bucket}.`,
    };
  }

  const missing = REQUIRED_RULE_IDS.filter((id) => !ids.includes(id));
  if (missing.length > 0) {
    return {
      id: "lifecycle_rules",
      status: "fail",
      evidence: `${bucket} is missing the lifecycle rule(s): ${missing.join(", ")}. Abandoned uploads and idempotency records would never be pruned.`,
      remediation: "Run `dropthis init` for this instance; it applies the rules.",
    };
  }
  return {
    id: "lifecycle_rules",
    status: "pass",
    evidence: `${bucket} carries all ${REQUIRED_RULE_IDS.length} lifecycle rules.`,
  };
}

/**
 * The deployed script's OWN bindings, not the rendered config: a config that
 * says the right thing and a Worker that was deployed from an older one look
 * identical from the file, and only one of them serves OAuth sessions.
 */
async function kvBound(
  client: Cloudflare,
  accountId: string,
  worker: string,
  kvTitle: string,
): Promise<AccountCheck> {
  let expected: string | undefined;
  for await (const namespace of client.kv.namespaces.list({ account_id: accountId, per_page: 100 })) {
    if (namespace.title === kvTitle) {
      expected = namespace.id;
      break;
    }
  }
  if (expected === undefined) {
    return {
      id: "kv_bound",
      status: "fail",
      evidence: `No KV namespace named ${kvTitle} exists in this account.`,
      remediation: "Run `dropthis init` for this instance; it reconciles the namespace by name.",
    };
  }

  let bindings: Array<Record<string, unknown>>;
  try {
    // `scripts.settings` is a DIFFERENT endpoint (`/script-settings`) and
    // carries logpush and tags, not bindings. The metadata a deploy actually
    // wrote is on `/settings`, which the SDK calls scriptAndVersionSettings.
    const settings = await client.workers.scripts.scriptAndVersionSettings.get(worker, {
      account_id: accountId,
    });
    bindings = (settings.bindings ?? []) as unknown as Array<Record<string, unknown>>;
  } catch (error) {
    return {
      id: "kv_bound",
      status: "fail",
      evidence: `The Worker ${worker} has no readable settings: ${message(error)}`,
      remediation: "Run `dropthis init` for this instance to deploy it.",
    };
  }

  const bound = bindings.find((binding) => binding.name === "OAUTH_KV");
  const boundId = typeof bound?.namespace_id === "string" ? bound.namespace_id : undefined;
  if (boundId !== expected) {
    return {
      id: "kv_bound",
      status: "fail",
      evidence: `${worker} binds OAUTH_KV to ${boundId ?? "nothing"}, but ${kvTitle} is ${expected}.`,
      remediation: "Run `dropthis init` for this instance; it renders the config with the reconciled id and redeploys.",
    };
  }
  return { id: "kv_bound", status: "pass", evidence: `${worker} binds OAUTH_KV to ${kvTitle} (${expected}).` };
}

async function domainAttached(
  client: Cloudflare,
  accountId: string,
  worker: string,
  domain: string | undefined,
): Promise<AccountCheck> {
  if (domain === undefined) {
    return {
      id: "domain_attached",
      status: "skip",
      evidence: "No custom domain was asked for, so there is nothing to attach.",
    };
  }
  for await (const attached of client.workers.domains.list({ account_id: accountId, hostname: domain })) {
    if (attached.service === worker) {
      return { id: "domain_attached", status: "pass", evidence: `${domain} routes to ${worker}.` };
    }
    return {
      id: "domain_attached",
      status: "fail",
      evidence: `${domain} routes to the Worker ${String(attached.service)}, not to ${worker}.`,
      remediation: `Detach ${domain} from ${String(attached.service)}, or pick another hostname.`,
    };
  }
  return {
    id: "domain_attached",
    status: "fail",
    evidence: `${domain} is not attached to any Worker in this account.`,
    remediation: `Run \`dropthis init --domain ${domain}\` for this instance.`,
  };
}

async function storedDomain(
  client: Cloudflare,
  accountId: string,
  bucket: string,
): Promise<string | undefined> {
  const config = await getObjectJson<{ canonical_url?: unknown }>(
    client,
    accountId,
    bucket,
    "system/config.json",
  ).catch(() => undefined);
  if (typeof config?.canonical_url !== "string") return undefined;
  let host: string;
  try {
    host = new URL(config.canonical_url).hostname;
  } catch {
    return undefined;
  }
  return host.endsWith(".workers.dev") ? undefined : host;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
