import { describe, expect, it } from "vitest";
import { BASE_URL } from "./base-url.js";
import { api, apiJson, errorOf } from "./client.js";
import { INITIAL_POLICY } from "../packages/worker/src/policy/defaults.js";

/**
 * `config`, `usage`, `prune` and `doctor` against the deployed dev Worker.
 *
 * These tests share one instance, so anything that changes policy puts it back
 * afterwards: a test that tightens expiry and walks away would fail every test
 * that runs after it, and the failure would point at the wrong place.
 */
type ConfigBody = {
  policy: typeof INITIAL_POLICY;
  canonical_url: string;
  alias_origins: string[];
  instance_name: string;
  note?: string;
};

const readConfig = async (): Promise<ConfigBody> =>
  (await (await api("/_api/v1/config")).json()) as ConfigBody;

const patchConfig = (body: unknown) => apiJson("/_api/v1/config", "PATCH", body);

describe("config", () => {
  it("reads the policy this instance was installed with", async () => {
    const body = await readConfig();

    expect(body.canonical_url).toBe(BASE_URL);
    expect(body.policy.max_request_bytes).toBe(INITIAL_POLICY.max_request_bytes);
    expect(body.policy.pbkdf2_iterations).toBe(INITIAL_POLICY.pbkdf2_iterations);
  });

  it("changes a rule, enforces it on the next publish, and puts it back", async () => {
    const before = (await readConfig()).policy.expiry;

    const changed = await patchConfig({ expiry: { default: "1d", max: "2d" } });
    expect(changed.status, await changed.clone().text()).toBe(200);
    expect(((await changed.json()) as ConfigBody).note ?? "").toMatch(/future calls/i);

    try {
      const refused = await apiJson("/_api/v1/drops", "POST", {
        files: [{ path: "a.txt", text: "x" }],
        expires: "30d",
      });
      expect(await errorOf(refused)).toMatchObject({ status: 400, code: "POLICY_VIOLATION" });
    } finally {
      const restored = await patchConfig({ expiry: before });
      expect(restored.status, await restored.clone().text()).toBe(200);
    }

    expect((await readConfig()).policy.expiry).toEqual(before);
  });

  it("refuses a value above the hard ceiling", async () => {
    expect(await errorOf(await patchConfig({ max_request_bytes: 1024 * 1024 * 1024 }))).toMatchObject(
      { status: 400, code: "POLICY_VIOLATION" },
    );
  });

  it("refuses to move the instance's own identity", async () => {
    expect(await errorOf(await patchConfig({ canonical_url: "https://elsewhere.test" }))).toMatchObject(
      { status: 400, code: "INVALID_INPUT" },
    );
    expect((await readConfig()).canonical_url).toBe(BASE_URL);
  });
});

describe("usage and prune", () => {
  // The scan is BUDGETED (`cron_ops_budget`, 40 by default) and walks `drops/`
  // oldest first, so a new drop is the last thing it would reach. Once the
  // instance holds more drops than the budget, the count saturates and
  // `incomplete` is true — that is the contract, not a bug, and it is what a
  // shared bucket makes happen. Both branches are asserted.
  it("counts a drop it just published, or says it ran out of budget", async () => {
    const usageNow = async () =>
      (await (await api("/_api/v1/usage")).json()) as {
        states: { live: { count: number; bytes: number } };
        total: { count: number };
        incomplete: boolean;
        cursor?: string | null;
      };

    const before = await usageNow();

    await apiJson("/_api/v1/drops", "POST", { files: [{ path: "u.txt", text: "usage" }] });

    const after = await usageNow();

    if (after.incomplete) {
      expect(after.cursor, "an incomplete scan must hand back where to resume").toBeTruthy();
      expect(after.total.count).toBeGreaterThan(0);
      return;
    }

    expect(before.incomplete, "a complete scan cannot follow an incomplete one").toBe(false);
    expect(after.total.count).toBe(before.total.count + 1);
    expect(after.states.live.count).toBe(before.states.live.count + 1);
    expect(after.states.live.bytes).toBeGreaterThan(before.states.live.bytes);
  });

  it("reports without deleting by default", async () => {
    const response = await apiJson("/_api/v1/prune", "POST", {});
    expect(response.status, await response.clone().text()).toBe(200);

    const report = (await response.json()) as {
      dry_run: boolean;
      deleted: { drops: number };
      states: Record<string, unknown>;
    };
    expect(report.dry_run).toBe(true);
    expect(report.deleted.drops).toBe(0);
    expect(Object.keys(report.states)).toEqual([
      "live",
      "expired_grace",
      "expired_final",
      "staging",
      "orphan",
    ]);
  });

  it("deletes nothing on a healthy instance when asked to run for real", async () => {
    const published = await apiJson("/_api/v1/drops", "POST", {
      files: [{ path: "keep.txt", text: "keep" }],
    });
    const drop = (await published.json()) as { slug: string };

    const response = await apiJson("/_api/v1/prune", "POST", { dry_run: false });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { deleted: { drops: number } }).deleted.drops).toBe(0);

    // The live drop is untouched.
    expect((await api(`/_api/v1/drops/${drop.slug}`)).status).toBe(200);
  });
});

describe("doctor", () => {
  it("lists its checks", async () => {
    const body = (await (await api("/_api/v1/doctor/checks")).json()) as {
      checks: Array<{ id: string; description: string }>;
    };

    expect(body.checks.map((check) => check.id)).toEqual([
      "hello_drop",
      "mcp_initialize",
      "policy_readable",
      "cron_state",
      "canonical_origin",
      "pbkdf2_benchmark",
      "admin_rotation_clean",
    ]);
  });

  it("runs green against the deployed instance, with the one skip named", async () => {
    const response = await api("/_api/v1/doctor");
    expect(response.status, await response.clone().text()).toBe(200);

    const report = (await response.json()) as {
      ok: boolean;
      checks: Array<{ id: string; status: string; evidence: string }>;
    };

    const failed = report.checks.filter((check) => check.status === "fail");
    expect(failed, JSON.stringify(failed)).toEqual([]);
    expect(report.ok).toBe(true);

    const skipped = report.checks.filter((check) => check.status === "skip").map((c) => c.id);
    expect(skipped).toEqual([]);
    const mcp = report.checks.find((check) => check.id === "mcp_initialize")!;
    expect(mcp.status, mcp.evidence).toBe("pass");
    expect(mcp.evidence).toContain("tools/list offers");
  });

  it("publishes and cleans up a real drop, leaving the instance as it found it", async () => {
    const before = (await (await api("/_api/v1/usage")).json()) as { total: { count: number } };
    await api("/_api/v1/doctor");
    const after = (await (await api("/_api/v1/usage")).json()) as typeof before;

    expect(after.total.count).toBe(before.total.count);
  });

  /**
   * The check that only this seam can prove. A Worker freezes `Date.now()`
   * inside a request, so the old stopwatch around one derive reported 0 ms on
   * every deployed instance and still said "pass" (issue #16). Miniflare and
   * Node both hid it: their clocks run free.
   *
   * `inconclusive` is an allowed outcome — a busy instance cannot separate the
   * derive from its own I/O — but a `pass` must carry a real per-derive cost,
   * within 2x of the 6.1 ms measured at 25,000 iterations on the Free plan
   * (docs/research/2026-09-03-free-plan-measurements.md).
   */
  it("measures PBKDF2 on the deployed isolate, and never passes with 0 ms", async () => {
    const report = (await (await api("/_api/v1/doctor")).json()) as {
      checks: Array<{ id: string; status: string; evidence: string }>;
    };
    const check = report.checks.find((entry) => entry.id === "pbkdf2_benchmark")!;

    expect(["pass", "inconclusive"], check.evidence).toContain(check.status);
    expect(check.evidence).toContain(String(INITIAL_POLICY.pbkdf2_iterations));
    expect(check.evidence).toContain("baseline");
    if (check.status !== "pass") return;

    const perDerive = Number(/cost ([\d.]+) ms per derive/.exec(check.evidence)?.[1]);
    expect(perDerive, check.evidence).toBeGreaterThan(0);
    expect(perDerive, check.evidence).toBeLessThan(2 * 6.1);
  });
});
