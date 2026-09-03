/**
 * The instance policy `init` writes into `system/config.json` on a new
 * instance, plus the hard ceilings `config set` refuses to cross.
 *
 * Two values are MEASURED against the deployed Free-plan Worker, not chosen —
 * transcript and method in docs/research/2026-09-03-free-plan-measurements.md:
 *
 *   max_request_bytes  4 MiB   parse + base64-decode + SHA-256 of a 4 MiB
 *                              inline body passes 10/10 at 254 ms median, with
 *                              6 MiB and 8 MiB also passing above it. Depends
 *                              on `publish` decoding with
 *                              `Uint8Array.fromBase64`: with the portable
 *                              `atob` loop the same size passed only 2/10.
 *   pbkdf2_iterations  25,000  6.1 ms per derive, the highest count inside the
 *                              8 ms unlock budget (50,000 costs 12.5 ms).
 *
 * `max_unhashed_bytes` and `cron_ops_budget` are still provisional: the code
 * paths they bound (URL fetches, the cron) do not exist yet.
 *
 * Policy is prospective — `config set` changes what future calls resolve to and
 * never rewrites an existing drop.
 */
export const INITIAL_POLICY = {
  expiry: { default: "30d", max: "365d", allow_never: true },
  password: { default: null, required: false },
  noindex: { default: true, forced: false },
  /** Request-body cap for a streamed staged PUT or a `url` fetch. */
  max_file_bytes: 104_857_600,
  /** Measured: the single-call inline ceiling on the Free plan. */
  max_request_bytes: 4 * 1024 * 1024,
  /** Provisional: a `url` entry with no digest must be hashed by the Worker. */
  max_unhashed_bytes: 2 * 1024 * 1024,
  auto_index: "list",
  /** Measured: the highest PBKDF2 count inside the 8 ms unlock budget. */
  pbkdf2_iterations: 25_000,
  /** Provisional: derived from the subrequest budget, not yet measured. */
  cron_ops_budget: 40,
} as const;

export type InstancePolicy = typeof INITIAL_POLICY;

/**
 * Above these, `config set` answers `POLICY_VIOLATION`. `max_request_bytes` is
 * capped at 64 MiB encoded so the decoded body still fits the isolate; on Free
 * the honest working value is far lower and is the default above.
 */
export const POLICY_CEILINGS = {
  max_request_bytes: 64 * 1024 * 1024,
  max_file_bytes: 104_857_600,
  /**
   * workerd refuses 200,000 PBKDF2 iterations outright (decision #73), so a
   * count above this ceiling would deploy an instance whose password page
   * cannot answer at all. 50,000 already costs 12.5 ms, over the 8 ms unlock
   * budget, so anything near the ceiling is an operator's deliberate trade.
   */
  pbkdf2_iterations: 100_000,
  /**
   * The Free plan allows 50 subrequests per invocation and every cron R2 call
   * is one, so a budget at or above 50 guarantees the run is killed mid-sweep.
   */
  cron_ops_budget: 45,
} as const;

/**
 * Below these, a stored password is materially weaker than the measured
 * default with nothing measured to justify it. There is no floor on the byte
 * limits: a tiny instance is a valid choice.
 */
export const POLICY_FLOORS = {
  pbkdf2_iterations: 10_000,
  cron_ops_budget: 1,
  max_request_bytes: 1024,
  max_file_bytes: 1024,
  max_unhashed_bytes: 1024,
} as const;

/** The shortest password this instance will ever accept (docs/spec-v1.md). */
export const MIN_PASSWORD_LENGTH = 8;
