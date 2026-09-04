/**
 * Expiry: three caller spellings, one stored timestamp, four states
 * (docs/spec-v1.md, "Expiry lifecycle").
 *
 * An agent does not compute timestamps, so `expires` accepts `"<n>d"`, a bare
 * `YYYY-MM-DD` (midnight UTC), an RFC 3339 instant, or `"never"`. Everything is
 * normalised to `expires_at` — RFC 3339 at second precision, or `null` for
 * never — because that is the one form the viewer, `list`, the cron and every
 * response read.
 *
 * A past `expires_at` is refused on every surface. That is not politeness: the
 * `expiring/<date>/` marker it would create could land behind the cron's
 * `oldest_pending_date` and never be swept.
 */
import { ApiError } from "../errors.js";

/** How long an expired drop can still be revived with one `update`. */
export const GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export type ExpiryPolicy = {
  /** The longest lifetime this instance allows, as a `"<n>d"` duration. */
  max: string;
  allowNever: boolean;
};

export type DropState = "live" | "expired_grace" | "expired_final";

export class ExpiryError extends Error {
  readonly code: "INVALID_INPUT" | "POLICY_VIOLATION";

  constructor(code: "INVALID_INPUT" | "POLICY_VIOLATION", message: string) {
    super(message);
    this.name = "ExpiryError";
    this.code = code;
  }
}

const DAYS = /^(\d+)d$/;
const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RFC_3339 =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

/** RFC 3339 at second precision — the only form `expires_at` is ever stored in. */
function toRfc3339(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

/**
 * The instant a caller's `expires` names, in epoch milliseconds, or `null` for
 * `"never"`. Shape only: policy is applied by `resolveExpiry`.
 */
function parseExpires(value: string, now: Date): number | null {
  if (value === "never") return null;

  const days = DAYS.exec(value);
  if (days !== null) return now.getTime() + Number(days[1]) * 24 * 60 * 60 * 1000;

  if (BARE_DATE.test(value)) {
    const ms = Date.parse(`${value}T00:00:00Z`);
    if (Number.isNaN(ms)) throw invalid(value);
    // Date.parse accepts "2026-13-40" by rolling over; the round-trip catches it.
    if (!toRfc3339(ms).startsWith(value)) throw invalid(value);
    return ms;
  }

  if (RFC_3339.test(value)) {
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) throw invalid(value);
    return ms;
  }

  throw invalid(value);
}

function invalid(value: string): ExpiryError {
  return new ExpiryError(
    "INVALID_INPUT",
    `expires must be "<n>d", YYYY-MM-DD, an RFC 3339 timestamp or "never"; got ${JSON.stringify(value)}.`,
  );
}

export function resolveExpiry(value: string, policy: ExpiryPolicy, now: Date): string | null {
  const at = parseExpires(value, now);

  if (at === null) {
    if (!policy.allowNever) {
      throw new ExpiryError("POLICY_VIOLATION", "This instance does not allow drops that never expire.");
    }
    return null;
  }

  if (at <= now.getTime()) {
    throw new ExpiryError("POLICY_VIOLATION", "expires must be in the future.");
  }

  const maxAt = parseExpires(policy.max, now);
  if (maxAt !== null && at > maxAt) {
    throw new ExpiryError(
      "POLICY_VIOLATION",
      `This instance allows at most ${policy.max}; ${toRfc3339(at)} is beyond that.`,
    );
  }

  return toRfc3339(at);
}

export function dropState(expiresAt: string | null, now: Date): DropState {
  if (expiresAt === null) return "live";
  const at = Date.parse(expiresAt);
  if (now.getTime() < at) return "live";
  return now.getTime() < at + GRACE_MS ? "expired_grace" : "expired_final";
}

/**
 * The `expiring/<yyyy-mm-dd>/<id>` day the cron should look at: the drop's
 * expiry plus the grace window. It is a hint — the cron re-reads `meta.json`
 * before deleting anything.
 */
export function expiringMarkerDate(expiresAt: string): string {
  return new Date(Date.parse(expiresAt) + GRACE_MS).toISOString().slice(0, 10);
}

/**
 * `resolveExpiry`, with its domain error already translated into the wire
 * error every operation was translating it into by hand (issue #24, standards
 * finding 6). `publish`, `update` and the staged commit all resolve the same
 * value against the same policy; three copies of the adapter were three places
 * for the code to drift.
 *
 * It lives here rather than in an operations helper because the translation is
 * about this module's own error type.
 */
export function resolveExpiryOrFail(
  value: string,
  policy: { expiry: { max: string; allow_never: boolean } },
  now: Date,
): string | null {
  try {
    return resolveExpiry(value, { max: policy.expiry.max, allowNever: policy.expiry.allow_never }, now);
  } catch (error) {
    if (error instanceof ExpiryError) throw new ApiError(error.code, error.message);
    throw error;
  }
}
