import { beforeEach, describe, expect, it } from "vitest";
import { hashKey } from "../src/auth/key.js";
import type { Env } from "../src/bindings.js";
import { CHECK_IDS } from "../src/operations/doctor.js";
import { createApp } from "../src/index.js";
import { INITIAL_POLICY } from "../src/policy/defaults.js";
import { CONFIG_KEY, keyHashKey, keyRecordKey, userKey } from "../src/storage/keys.js";
import { memoryBucket } from "./memory-bucket.js";
import type { MemoryBucket } from "./memory-bucket.js";

/**
 * `doctor` — a named check registry, answerable with the instance key alone
 * (decision #29). Account-level checks belong to `init`, which holds the
 * Cloudflare token; nothing here needs one.
 *
 * A check that cannot run yet is `skip`, never `pass`: an instance is not
 * proved healthy by a check that did not happen.
 */
const ADMIN_KEY = "a".repeat(64);
const USER_KEY = "b".repeat(64);

let bucket: MemoryBucket;
let env: Env;

type Check = { id: string; status: string; evidence: string; remediation?: string };
type Report = { ok: boolean; checks: Check[] };

async function seedKey(key: string, id: string, label: string, scope: "admin" | "user") {
  const hash = await hashKey(key);
  bucket.seed(keyHashKey(hash), JSON.stringify({ id }));
  bucket.seed(
    keyRecordKey(id),
    JSON.stringify({ id, label, scope, hash, created: "2026-09-01T00:00:00Z" }),
  );
}

beforeEach(async () => {
  bucket = memoryBucket();
  bucket.seed(
    CONFIG_KEY,
    JSON.stringify({
      ...INITIAL_POLICY,
      canonical_url: "https://drops.test",
      alias_origins: [],
      instance_name: "acme",
    }),
  );
  await seedKey(ADMIN_KEY, "admin", "admin", "admin");
  await seedKey(USER_KEY, "id-anna", "anna", "user");
  bucket.seed(userKey("admin"), JSON.stringify({ id: "admin" }));
  env = { BUCKET: bucket, OAUTH_KV: {}, HMAC_SECRET: "s".repeat(32) };
});

async function call(path: string, key = ADMIN_KEY): Promise<Response> {
  return createApp().fetch(
    new Request(`https://drops.test${path}`, { headers: { authorization: `Bearer ${key}` } }),
    env,
  );
}

const run = async (): Promise<Report> => (await (await call("/_api/v1/doctor")).json()) as Report;

const checkOf = (report: Report, id: string): Check => {
  const found = report.checks.find((check) => check.id === id);
  expect(found, `no check ${id}`).toBeDefined();
  return found!;
};

describe("doctor --list", () => {
  it("names every check with a description an operator can read", async () => {
    const body = (await (await call("/_api/v1/doctor/checks")).json()) as {
      checks: Array<{ id: string; description: string }>;
    };

    expect(body.checks.map((check) => check.id)).toEqual([...CHECK_IDS]);
    for (const check of body.checks) expect(check.description.length).toBeGreaterThan(10);
  });

  it("lists exactly the checks decision #29 froze", () => {
    expect([...CHECK_IDS]).toEqual([
      "hello_drop",
      "mcp_initialize",
      "policy_readable",
      "cron_state",
      "canonical_origin",
      "pbkdf2_benchmark",
      "admin_rotation_clean",
    ]);
  });
});

describe("doctor", () => {
  it("runs green on a healthy instance", async () => {
    const report = await run();

    expect(report.ok).toBe(true);
    expect(report.checks.map((check) => check.id)).toEqual([...CHECK_IDS]);
    expect(report.checks.filter((check) => check.status === "fail")).toEqual([]);
  });

  it("skips the checks whose subject does not exist yet, and says why", async () => {
    const report = await run();

    expect(checkOf(report, "mcp_initialize").status).toBe("skip");
    expect(checkOf(report, "mcp_initialize").evidence).toContain("#8");
    expect(checkOf(report, "cron_state").status).toBe("skip");
    expect(checkOf(report, "cron_state").evidence).toContain("#6");
  });

  it("proves the deploy with a real drop and leaves nothing behind", async () => {
    const before = bucket.keys();
    const report = await run();

    expect(checkOf(report, "hello_drop").status).toBe("pass");
    expect(bucket.keys()).toEqual(before);
  });

  it("times PBKDF2 at the instance's own iteration count", async () => {
    const report = await run();
    const check = checkOf(report, "pbkdf2_benchmark");

    expect(check.evidence).toContain(String(INITIAL_POLICY.pbkdf2_iterations));
    expect(check.evidence).toMatch(/\d+ ms/);
  });

  it("fails when the config is unreadable, and says how to fix it", async () => {
    bucket.seed(CONFIG_KEY, "not json at all");
    const report = await run();

    const check = checkOf(report, "policy_readable");
    expect(check.status).toBe("fail");
    expect(check.remediation ?? "").not.toBe("");
    expect(report.ok).toBe(false);
  });

  it("fails while an admin rotation is half finished", async () => {
    bucket.seed(userKey("admin"), JSON.stringify({ id: "admin-2", previous: "admin" }));
    const report = await run();

    const check = checkOf(report, "admin_rotation_clean");
    expect(check.status).toBe("fail");
    expect(check.evidence).toContain("previous");
    expect(report.ok).toBe(false);
  });

  it("fails when the instance does not know its own canonical origin", async () => {
    bucket.seed(CONFIG_KEY, JSON.stringify({ ...INITIAL_POLICY, instance_name: "acme" }));
    const report = await run();

    expect(checkOf(report, "canonical_origin").status).toBe("fail");
  });

  it("needs the admin key", async () => {
    const response = await call("/_api/v1/doctor", USER_KEY);
    expect(response.status).toBe(403);
  });
});
