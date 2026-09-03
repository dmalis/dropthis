/**
 * `config get` and `config set` (AGENTS.md, "Instance policy").
 *
 * The policy has two layers. DEFAULTS fill in a field the caller omitted;
 * RULES are enforced on every field a call does provide. `config set` changes
 * both, and it is PROSPECTIVE: it never rewrites a drop that already exists,
 * so a drop whose omitted field is now non-compliant is grandfathered until
 * the caller next sets that field. The response says so in one sentence,
 * because an operator who tightens expiry will otherwise believe old drops
 * moved with it.
 *
 * What `config set` may NOT touch is the instance's identity — `canonical_url`,
 * `alias_origins`, `instance_name`. Those are written by `init`, which knows
 * the account, the zone and the deployed Worker; an HTTP call that could move
 * the canonical origin could take the instance off its own domain.
 */
import type { Bucket } from "../bindings.js";
import { resolveExpiry, ExpiryError } from "../domain/expiry.js";
import { ApiError } from "../errors.js";
import type { InstanceConfig, ResolvedPolicy } from "../instance-config.js";
import { CONFIG_KEY } from "../storage/keys.js";
import { casPut, createPut } from "../storage/r2.js";
import {
  INITIAL_POLICY,
  MIN_PASSWORD_LENGTH,
  POLICY_CEILINGS,
  POLICY_FLOORS,
} from "../policy/defaults.js";

export const PROSPECTIVE_NOTE =
  "This policy applies to future calls: defaults fill in what a call omits and rules are " +
  "enforced on the fields a call provides. Drops that already exist are unchanged until " +
  "their next update.";

export type ConfigView = {
  policy: ResolvedPolicy;
  canonical_url: string;
  alias_origins: string[];
  instance_name: string;
};

export function configView(config: InstanceConfig): ConfigView {
  return {
    policy: config.policy,
    canonical_url: config.canonicalUrl,
    alias_origins: config.aliasOrigins,
    instance_name: config.instanceName,
  };
}

/** The byte limits, each a positive integer inside its floor and ceiling. */
const BYTE_LIMITS = ["max_file_bytes", "max_request_bytes", "max_unhashed_bytes"] as const;
const COUNT_LIMITS = ["pbkdf2_iterations", "cron_ops_budget"] as const;

const GROUPS = ["expiry", "password", "noindex"] as const;
const SCALARS = [...BYTE_LIMITS, ...COUNT_LIMITS, "auto_index"] as const;

const GROUP_FIELDS: Record<(typeof GROUPS)[number], readonly string[]> = {
  expiry: ["default", "max", "allow_never"],
  password: ["default", "required"],
  noindex: ["default", "forced"],
};

export async function setConfig(
  patch: Record<string, unknown>,
  bucket: Bucket,
  config: InstanceConfig,
  now: Date,
): Promise<ConfigView> {
  const next = merge(config.policy, patch);
  validate(next, now);

  const stored = {
    ...next,
    canonical_url: config.canonicalUrl,
    alias_origins: config.aliasOrigins,
    instance_name: config.instanceName,
  };

  // One key, so one compare-and-swap: two operators tightening policy at the
  // same second must not silently lose one of the two changes.
  const existing = await bucket.get(CONFIG_KEY);
  const body = JSON.stringify(stored);
  const written =
    existing === null
      ? await createPut(bucket, CONFIG_KEY, body)
      : await casPut(bucket, CONFIG_KEY, body, existing.etag);
  if (!written.ok) {
    throw new ApiError(
      "UPDATE_CONFLICT",
      "This instance's config changed while this call was running.",
    );
  }

  return { ...configView(config), policy: next };
}

/** The patch folded onto the current policy, one level deep inside a group. */
function merge(current: ResolvedPolicy, patch: Record<string, unknown>): ResolvedPolicy {
  const keys = Object.keys(patch);
  if (keys.length === 0) {
    throw new ApiError("INVALID_INPUT", "Send at least one policy field to change.");
  }

  const known = new Set<string>([...GROUPS, ...SCALARS]);
  const unknown = keys.filter((key) => !known.has(key));
  if (unknown.length > 0) {
    throw new ApiError(
      "INVALID_INPUT",
      `Unknown policy field${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. ` +
        `This instance's policy holds ${[...known].join(", ")}.`,
    );
  }

  const next = {
    ...current,
    expiry: { ...current.expiry },
    password: { ...current.password },
    noindex: { ...current.noindex },
  } as ResolvedPolicy;

  for (const group of GROUPS) {
    const value = patch[group];
    if (value === undefined) continue;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new ApiError("INVALID_INPUT", `${group} must be an object.`);
    }
    const fields = GROUP_FIELDS[group];
    for (const [field, fieldValue] of Object.entries(value)) {
      if (!fields.includes(field)) {
        throw new ApiError(
          "INVALID_INPUT",
          `Unknown field ${group}.${field}; ${group} holds ${fields.join(", ")}.`,
        );
      }
      (next[group] as Record<string, unknown>)[field] = fieldValue;
    }
  }

  for (const scalar of SCALARS) {
    if (patch[scalar] !== undefined) (next as Record<string, unknown>)[scalar] = patch[scalar];
  }

  return next;
}

function validate(policy: ResolvedPolicy, now: Date): void {
  for (const field of [...BYTE_LIMITS, ...COUNT_LIMITS]) {
    const value = (policy as Record<string, unknown>)[field];
    if (typeof value !== "number" || !Number.isInteger(value)) {
      throw new ApiError("INVALID_INPUT", `${field} must be a whole number of bytes.`);
    }
    const ceiling = (POLICY_CEILINGS as Record<string, number | undefined>)[field];
    const floor = (POLICY_FLOORS as Record<string, number | undefined>)[field];
    if (ceiling !== undefined && value > ceiling) {
      throw new ApiError(
        "POLICY_VIOLATION",
        `${field} is capped at ${ceiling} on this product; ${value} is above it.`,
      );
    }
    if (floor !== undefined && value < floor) {
      throw new ApiError(
        "POLICY_VIOLATION",
        `${field} has a floor of ${floor}; ${value} is below it.`,
      );
    }
  }

  if (policy.auto_index !== INITIAL_POLICY.auto_index) {
    throw new ApiError(
      "POLICY_VIOLATION",
      `auto_index is "${INITIAL_POLICY.auto_index}" in v1; "${String(policy.auto_index)}" is not served.`,
    );
  }

  if (typeof policy.expiry.allow_never !== "boolean") {
    throw new ApiError("INVALID_INPUT", "expiry.allow_never must be true or false.");
  }
  for (const flag of ["required"] as const) {
    if (typeof policy.password[flag] !== "boolean") {
      throw new ApiError("INVALID_INPUT", `password.${flag} must be true or false.`);
    }
  }
  for (const flag of ["default", "forced"] as const) {
    if (typeof policy.noindex[flag] !== "boolean") {
      throw new ApiError("INVALID_INPUT", `noindex.${flag} must be true or false.`);
    }
  }

  // `max` first: it is the rule the default has to fit inside.
  const max = resolveOrFail("expiry.max", policy.expiry.max, { max: "36500d", allowNever: false }, now);
  if (max === null) {
    throw new ApiError("POLICY_VIOLATION", 'expiry.max cannot be "never"; use allow_never instead.');
  }
  resolveOrFail(
    "expiry.default",
    policy.expiry.default,
    { max: policy.expiry.max, allowNever: policy.expiry.allow_never },
    now,
  );

  const password = policy.password.default;
  if (password !== null && password !== "generate") {
    if (typeof password !== "string") {
      throw new ApiError("INVALID_INPUT", 'password.default must be null, "generate" or a password.');
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new ApiError(
        "POLICY_VIOLATION",
        `password.default must be at least ${MIN_PASSWORD_LENGTH} characters.`,
      );
    }
  }
}

function resolveOrFail(
  field: string,
  value: unknown,
  bounds: { max: string; allowNever: boolean },
  now: Date,
): string | null {
  if (typeof value !== "string") {
    throw new ApiError("INVALID_INPUT", `${field} must be a string such as "30d" or "never".`);
  }
  try {
    return resolveExpiry(value, bounds, now);
  } catch (error) {
    if (error instanceof ExpiryError) {
      throw new ApiError(error.code, `${field}: ${error.message}`);
    }
    throw error;
  }
}
