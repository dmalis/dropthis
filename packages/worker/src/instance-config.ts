/**
 * `system/config.json` — the instance's policy and its identity on the web
 * (AGENTS.md, "Instance policy").
 *
 * The reader is deliberately tolerant, for the same reason `meta.json`'s is:
 * an instance installed by an older `init` must keep working. Missing keys fall
 * back to the frozen initial policy, unknown keys are ignored, and a missing
 * file altogether resolves to the initial policy with the request's own origin
 * as the canonical one — so a Worker deployed before its config was written
 * still serves rather than 500s.
 */
import type { Bucket } from "./bindings.js";
import { INITIAL_POLICY } from "./policy/defaults.js";
import type { InstancePolicy } from "./policy/defaults.js";
import { CONFIG_KEY } from "./storage/keys.js";

/**
 * The policy as a DEPLOYED instance holds it: the same shape as the frozen
 * initial values, but with ordinary types — an installed instance's numbers are
 * whatever `config set` last wrote, not the literals in the source.
 */
export type ResolvedPolicy = {
  expiry: { default: string; max: string; allow_never: boolean };
  password: { default: string | null; required: boolean };
  noindex: { default: boolean; forced: boolean };
  max_file_bytes: number;
  max_request_bytes: number;
  max_unhashed_bytes: number;
  auto_index: string;
  pbkdf2_iterations: number;
  cron_ops_budget: number;
};

export type InstanceConfig = {
  policy: ResolvedPolicy;
  canonicalUrl: string;
  aliasOrigins: string[];
  instanceName: string;
};

type StoredConfig = Partial<InstancePolicy> & {
  canonical_url?: unknown;
  alias_origins?: unknown;
  instance_name?: unknown;
};

function asObject(value: unknown): StoredConfig {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as StoredConfig)
    : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export async function loadInstanceConfig(bucket: Bucket, requestUrl: string): Promise<InstanceConfig> {
  const object = await bucket.get(CONFIG_KEY);
  let stored: StoredConfig = {};
  if (object !== null) {
    try {
      stored = asObject(JSON.parse(await object.text()));
    } catch {
      // A config we cannot parse is a config we do not have: serve on the
      // frozen initial policy rather than take the instance down.
      stored = {};
    }
  }

  return {
    policy: { ...INITIAL_POLICY, ...stripUnknownPolicy(stored) } as ResolvedPolicy,
    canonicalUrl:
      typeof stored.canonical_url === "string" && stored.canonical_url.length > 0
        ? stored.canonical_url.replace(/\/+$/, "")
        : new URL(requestUrl).origin,
    aliasOrigins: asStringArray(stored.alias_origins),
    instanceName: typeof stored.instance_name === "string" ? stored.instance_name : "main",
  };
}

/** Only keys the current policy knows; anything else is a newer instance's. */
function stripUnknownPolicy(stored: StoredConfig): Partial<InstancePolicy> {
  const known: Record<string, unknown> = {};
  for (const key of Object.keys(INITIAL_POLICY)) {
    const value = (stored as Record<string, unknown>)[key];
    if (value !== undefined) known[key] = value;
  }
  return known as Partial<InstancePolicy>;
}
