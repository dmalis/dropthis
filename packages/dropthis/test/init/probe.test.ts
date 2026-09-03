import { afterEach, describe, expect, it } from "vitest";
import { startFakeInstance } from "../../../../test/fake-cloudflare/src/instance.js";
import { pollHealth, runRemoteDoctor } from "../../src/init/probe.js";

const teardown: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (teardown.length > 0) await teardown.pop()!();
});

async function instance(adminKey = "k".repeat(64)) {
  const started = await startFakeInstance({ adminKey });
  teardown.push(() => started.close());
  return started;
}

describe("pollHealth", () => {
  it("returns ok as soon as the instance answers", async () => {
    const started = await instance();

    const result = await pollHealth(started.url, { timeoutMs: 5_000, intervalMs: 10 });

    expect(result.ok).toBe(true);
    expect(result.attempts).toBeGreaterThanOrEqual(1);
  });

  it("gives up at the deadline instead of hanging, and says what it saw", async () => {
    const result = await pollHealth("http://127.0.0.1:1/", { timeoutMs: 60, intervalMs: 10 });

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/health/i);
  });

  it("does not accept a page that is not this instance's health answer", async () => {
    const started = await instance();
    const broken = await startFakeInstance({ adminKey: "x".repeat(64), broken: true });
    teardown.push(() => broken.close());

    const result = await pollHealth(broken.url, { timeoutMs: 60, intervalMs: 10 });

    expect(result.ok).toBe(false);
    expect(started.url).not.toBe(broken.url);
  });
});

describe("runRemoteDoctor", () => {
  it("runs every check against the deployed instance with the admin key", async () => {
    const adminKey = "a".repeat(64);
    const started = await instance(adminKey);

    const report = await runRemoteDoctor(started.url, adminKey);

    expect(report.ok).toBe(true);
    expect(report.checks.map((check) => check.id)).toContain("hello_drop");
    expect(report.checks.every((check) => check.status !== "fail")).toBe(true);
  });

  it("reports a failed check rather than throwing", async () => {
    const adminKey = "b".repeat(64);
    const started = await instance(adminKey);
    // No config object: `policy_readable` and `canonical_origin` must fail.
    started.bucket.delete("system/config.json");

    const report = await runRemoteDoctor(started.url, adminKey);

    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.id === "policy_readable")?.status).toBe("fail");
  });

  it("turns a rejected key into a report that fails, never an exception", async () => {
    const started = await instance("c".repeat(64));

    const report = await runRemoteDoctor(started.url, "d".repeat(64));

    expect(report.ok).toBe(false);
    expect(JSON.stringify(report)).not.toContain("d".repeat(64));
  });
});
