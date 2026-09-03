import { describe, expect, it } from "vitest";
import { INITIAL_POLICY, POLICY_CEILINGS } from "../src/policy/defaults.js";

/**
 * The values `init` writes into `system/config.json`. Two of them are measured,
 * not chosen: the transcript is docs/research/2026-09-03-free-plan-measurements.md.
 * This test is the pin — changing either number here means re-running the
 * measurement, not editing a constant.
 */
describe("initial instance policy", () => {
  it("carries the measured Free-safe inline request ceiling (4 MiB)", () => {
    expect(INITIAL_POLICY.max_request_bytes).toBe(4 * 1024 * 1024);
  });

  it("carries the measured PBKDF2 count that fits the 8 ms budget", () => {
    expect(INITIAL_POLICY.pbkdf2_iterations).toBe(25_000);
  });

  it("stays inside the hard ceilings `config set` enforces", () => {
    expect(INITIAL_POLICY.max_request_bytes).toBeLessThanOrEqual(
      POLICY_CEILINGS.max_request_bytes,
    );
    expect(INITIAL_POLICY.max_file_bytes).toBeLessThanOrEqual(POLICY_CEILINGS.max_file_bytes);
  });

  it("keeps the rest of the frozen v1 defaults", () => {
    expect(INITIAL_POLICY).toMatchObject({
      expiry: { default: "30d", max: "365d", allow_never: true },
      password: { default: null, required: false },
      noindex: { default: true, forced: false },
      max_file_bytes: 104_857_600,
      max_unhashed_bytes: 2 * 1024 * 1024,
      auto_index: "list",
      cron_ops_budget: 40,
    });
  });
});
