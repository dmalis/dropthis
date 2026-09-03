import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeInstance } from "../../../test/fake-cloudflare/src/instance.js";
import type { FakeInstance } from "../../../test/fake-cloudflare/src/instance.js";
import { bin, cleanEnv, oneJsonDocument, packageRoot, runCli } from "./cli-harness.js";

/**
 * The admin commands, the scope gate (exit 4), the `--jsonl` stream, the
 * prompt path (exit 2 on "no" and on SIGINT), and an instance that answers
 * with something that is not dropthis.
 */
const ADMIN_KEY = "a".repeat(64);
const USER_KEY = "b".repeat(64);

let instance: FakeInstance;
let admin: Record<string, string>;
let user: Record<string, string>;
let page: string;

type Json = Record<string, unknown>;

beforeAll(async () => {
  instance = await startFakeInstance({ adminKey: ADMIN_KEY, userKey: USER_KEY });
  const base = await cleanEnv();
  admin = { ...base, DROPTHIS_URL: instance.url, DROPTHIS_KEY: ADMIN_KEY };
  user = { ...base, DROPTHIS_URL: instance.url, DROPTHIS_KEY: USER_KEY };
  const dir = await mkdtemp(join(tmpdir(), "dropthis-admin-"));
  page = join(dir, "page.html");
  await writeFile(page, "<p>page</p>");
}, 120_000);

afterAll(async () => {
  await instance.close();
});

describe("admin commands", () => {
  it("user add / list / remove, with the key shown once", async () => {
    const added = await runCli(["user", "add", "bob", "--json"], { env: admin });
    expect(added.code, added.stderr).toBe(0);
    const result = oneJsonDocument(added.stdout) as Json;
    expect(typeof result.key).toBe("string");
    expect((result.user as Json).label).toBe("bob");
    expect(result.connect).toBeDefined();

    const listed = await runCli(["user", "list", "--json"], { env: admin });
    expect((oneJsonDocument(listed.stdout) as { users: Json[] }).users.map((u) => u.label)).toContain("bob");

    const removed = await runCli(["user", "remove", "bob", "--json"], { env: admin });
    expect(removed.code, removed.stderr).toBe(0);
    const again = await runCli(["user", "list", "--json"], { env: admin });
    expect((oneJsonDocument(again.stdout) as { users: Json[] }).users.map((u) => u.label)).not.toContain("bob");
  });

  it("config get / set take and return the policy; set is a JSON argument", async () => {
    const set = await runCli(["config", "set", '{"expiry":{"default":"14d"}}', "--json"], { env: admin });
    expect(set.code, set.stderr).toBe(0);
    const result = oneJsonDocument(set.stdout) as Json;
    expect(typeof result.note).toBe("string");

    const got = await runCli(["config", "get", "--json"], { env: admin });
    expect((oneJsonDocument(got.stdout) as { policy: { expiry: Json } }).policy.expiry.default).toBe("14d");

    const bad = await runCli(["config", "set", "{nope", "--json"], { env: admin });
    expect(bad.code).toBe(1);
    expect(oneJsonDocument(bad.stderr)).toMatchObject({ code: "INVALID_INPUT" });
  });

  it("doctor --list --json and doctor --json", async () => {
    const list = await runCli(["doctor", "--list", "--json"], { env: admin });
    expect(list.code, list.stderr).toBe(0);
    const checks = (oneJsonDocument(list.stdout) as { checks: Json[] }).checks;
    expect(checks.map((c) => c.id)).toContain("hello_drop");

    const run = await runCli(["doctor", "--json"], { env: admin });
    expect(run.code, run.stderr).toBe(0);
    const report = oneJsonDocument(run.stdout) as Json;
    expect(Object.keys(report)).toEqual(["ok", "checks"]);
  });

  it("a user key on an admin command exits 4 with FORBIDDEN_SCOPE", async () => {
    const run = await runCli(["user", "list", "--json"], { env: user });
    expect(run.code).toBe(4);
    expect(oneJsonDocument(run.stderr)).toMatchObject({ code: "FORBIDDEN_SCOPE" });
  });
});

describe("usage and prune", () => {
  it("prune is a dry run unless --no-dry-run; --jsonl streams steps and ends with the --json document", async () => {
    await runCli(["publish", page], { env: admin });

    const dry = await runCli(["prune", "--json"], { env: admin });
    expect(dry.code, dry.stderr).toBe(0);
    const report = oneJsonDocument(dry.stdout) as Json;
    expect(report.dry_run).toBe(true);
    expect(report.incomplete).toBe(false);
    expect((report.states as Json).live).toMatchObject({ count: expect.any(Number) });

    const streamed = await runCli(["prune", "--jsonl"], { env: admin });
    expect(streamed.code, streamed.stderr).toBe(0);
    const lines = streamed.stdout.trim().split("\n").map((line) => JSON.parse(line) as Json);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines[lines.length - 1]).toEqual(report);
    for (const step of lines.slice(0, -1)) expect(step.dry_run).toBe(true);

    const real = await runCli(["prune", "--no-dry-run", "--json"], { env: admin });
    expect(real.code, real.stderr).toBe(0);
    expect((oneJsonDocument(real.stdout) as Json).dry_run).toBe(false);
  });

  it("usage shares the report shape", async () => {
    const run = await runCli(["usage", "--json"], { env: admin });
    expect(run.code, run.stderr).toBe(0);
    expect(Object.keys(oneJsonDocument(run.stdout) as Json)).toEqual(["states", "total", "incomplete"]);
  });
});

describe("prompts", () => {
  const publishOne = async () => {
    const run = await runCli(["publish", page, "--json"], { env: admin });
    return (oneJsonDocument(run.stdout) as Json).slug as string;
  };

  it("delete asks when interactive: 'n' cancels with exit 2, 'y' deletes", async () => {
    const slug = await publishOne();
    const env = { ...admin, DROPTHIS_INTERACTIVE: "1" };

    const declined = await runCli(["delete", slug], { env, input: "n\n" });
    expect(declined.code).toBe(2);
    expect(declined.stderr).toContain(slug);
    expect((await runCli(["get", slug, "--json"], { env: admin })).code).toBe(0);

    const accepted = await runCli(["delete", slug], { env, input: "y\n" });
    expect(accepted.code, accepted.stderr).toBe(0);
    expect((await runCli(["get", slug, "--json"], { env: admin })).code).toBe(1);
  });

  it("--yes and a non-TTY skip the prompt", async () => {
    const slug = await publishOne();
    const run = await runCli(["delete", slug, "--yes"], { env: { ...admin, DROPTHIS_INTERACTIVE: "1" } });
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).not.toContain("?");
  });

  it("SIGINT during the prompt exits 2", async () => {
    const slug = await publishOne();
    const child = spawn(process.execPath, [bin, "delete", slug], {
      cwd: packageRoot,
      env: { ...admin, DROPTHIS_INTERACTIVE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    let sent = false;
    const code = await new Promise<number | null>((resolve) => {
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        if (!sent && stderr.includes(slug)) {
          sent = true;
          child.kill("SIGINT");
        }
      });
      child.on("close", (exit) => resolve(exit));
    });
    expect(code).toBe(2);
    expect((await runCli(["get", slug, "--json"], { env: admin })).code).toBe(0);
  }, 20_000);
});

describe("an instance that is not dropthis", () => {
  it("answers exit 1 with INTERNAL naming what came back", async () => {
    const broken = await startFakeInstance({ adminKey: ADMIN_KEY, broken: true });
    try {
      const run = await runCli(["list", "--json"], { env: { ...admin, DROPTHIS_URL: broken.url } });
      expect(run.code).toBe(1);
      const error = oneJsonDocument(run.stderr) as Json;
      expect(error.code).toBe("INTERNAL");
      expect(error.message).toContain("text/html");
      expect(error.retryable).toBe(false);
    } finally {
      await broken.close();
    }
  });

  it("an unreachable URL is INTERNAL and retryable", async () => {
    const run = await runCli(["list", "--json"], { env: { ...admin, DROPTHIS_URL: "http://127.0.0.1:1" } });
    expect(run.code).toBe(1);
    expect(oneJsonDocument(run.stderr)).toMatchObject({ code: "INTERNAL", retryable: true });
  });
});
