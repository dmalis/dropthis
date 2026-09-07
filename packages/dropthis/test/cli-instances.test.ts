import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { cleanEnv, oneJsonDocument, runCli } from "./cli-harness.js";

/**
 * `dropthis instances` (issue #30). The instances file is the only place the
 * keys live, so the one thing this command must never do is print one: an
 * operator asking "which instances do I have" gets names and URLs.
 *
 * `default` is the instance a command with no `--instance` would use — the
 * file's `default`, else its only instance, else the env pair, else nothing —
 * so the answer matches what the next command actually does.
 */
const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

type Row = { name: string; url: string; default: boolean };
type Document = { default: string | null; instances: Row[] };

async function envWithFile(content: unknown): Promise<Record<string, string>> {
  const env = await cleanEnv();
  const file = join(env.XDG_CONFIG_HOME!, "dropthis", "instances.json");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(content));
  return env;
}

describe("dropthis instances", () => {
  it("--json lists every instance sorted by name, with the default marked and no key", async () => {
    const env = await envWithFile({
      default: "beta",
      instances: {
        beta: { url: "https://beta.example.workers.dev", key: KEY_B },
        alpha: { url: "https://alpha.example.workers.dev", key: KEY_A },
      },
    });

    const run = await runCli(["instances", "--json"], { env });
    expect(run.code, run.stderr).toBe(0);
    expect(oneJsonDocument(run.stdout)).toEqual({
      default: "beta",
      instances: [
        { name: "alpha", url: "https://alpha.example.workers.dev", default: false },
        { name: "beta", url: "https://beta.example.workers.dev", default: true },
      ],
    });
    expect(run.stdout).not.toContain(KEY_A);
    expect(run.stdout).not.toContain(KEY_B);
    expect(run.stderr).not.toContain(KEY_B);
  });

  it("plain mode prints one row per instance and marks the default; no key anywhere", async () => {
    const env = await envWithFile({
      default: "beta",
      instances: {
        beta: { url: "https://beta.example.workers.dev", key: KEY_B },
        alpha: { url: "https://alpha.example.workers.dev", key: KEY_A },
      },
    });

    const run = await runCli(["instances"], { env });
    expect(run.code, run.stderr).toBe(0);
    const lines = run.stdout.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("alpha");
    expect(lines[0]).toContain("https://alpha.example.workers.dev");
    expect(lines[0]).not.toContain("(default)");
    expect(lines[1]).toContain("beta");
    expect(lines[1]).toContain("(default)");
    expect(run.stdout + run.stderr).not.toContain(KEY_A);
    expect(run.stdout + run.stderr).not.toContain(KEY_B);
  });

  it("an only instance is the default even when the file names none", async () => {
    const env = await envWithFile({ instances: { solo: { url: "https://solo.example.workers.dev", key: KEY_A } } });
    const run = await runCli(["instances", "--json"], { env });
    expect(run.code, run.stderr).toBe(0);
    expect(oneJsonDocument(run.stdout)).toEqual({
      default: "solo",
      instances: [{ name: "solo", url: "https://solo.example.workers.dev", default: true }],
    });
  });

  it("several instances and no default: nothing is marked", async () => {
    const env = await envWithFile({
      instances: {
        alpha: { url: "https://alpha.example.workers.dev", key: KEY_A },
        beta: { url: "https://beta.example.workers.dev", key: KEY_B },
      },
    });
    const run = await runCli(["instances", "--json"], { env });
    const document = oneJsonDocument(run.stdout) as Document;
    expect(document.default).toBeNull();
    expect(document.instances.map((row) => row.default)).toEqual([false, false]);
  });

  it("no file at all: an empty list, exit 0, and plain mode names `dropthis init`", async () => {
    const env = await cleanEnv();

    const json = await runCli(["instances", "--json"], { env });
    expect(json.code, json.stderr).toBe(0);
    expect(oneJsonDocument(json.stdout)).toEqual({ default: null, instances: [] });

    const plain = await runCli(["instances"], { env });
    expect(plain.code, plain.stderr).toBe(0);
    expect(plain.stdout).toBe("");
    expect(plain.stderr).toContain("dropthis init");
  });

  it("an empty instances object is the same as no file", async () => {
    const env = await envWithFile({ instances: {} });
    const run = await runCli(["instances", "--json"], { env });
    expect(run.code, run.stderr).toBe(0);
    expect(oneJsonDocument(run.stdout)).toEqual({ default: null, instances: [] });
  });

  it("the env pair with no file is one row named `env`, and it is the default", async () => {
    const base = await cleanEnv();
    const env = { ...base, DROPTHIS_URL: "https://env.example.workers.dev", DROPTHIS_KEY: KEY_A };

    const run = await runCli(["instances", "--json"], { env });
    expect(run.code, run.stderr).toBe(0);
    expect(oneJsonDocument(run.stdout)).toEqual({
      default: "env",
      instances: [{ name: "env", url: "https://env.example.workers.dev", default: true }],
    });
    expect(run.stdout).not.toContain(KEY_A);
  });

  it("the env pair beside a file is listed too, and it is the default it would be", async () => {
    const base = await envWithFile({
      default: "alpha",
      instances: { alpha: { url: "https://alpha.example.workers.dev", key: KEY_A } },
    });
    const env = { ...base, DROPTHIS_URL: "https://env.example.workers.dev", DROPTHIS_KEY: KEY_B };

    const run = await runCli(["instances", "--json"], { env });
    expect(run.code, run.stderr).toBe(0);
    expect(oneJsonDocument(run.stdout)).toEqual({
      default: "env",
      instances: [
        { name: "alpha", url: "https://alpha.example.workers.dev", default: false },
        { name: "env", url: "https://env.example.workers.dev", default: true },
      ],
    });
  });

  it("is listed by `dropthis commands`", async () => {
    const env = await cleanEnv();
    const run = await runCli(["commands", "--json"], { env });
    expect(run.code, run.stderr).toBe(0);
    const surface = oneJsonDocument(run.stdout) as Array<Record<string, unknown>>;
    const row = surface.find((entry) => entry.command === "instances");
    expect(row).toBeDefined();
    expect(row!.operation).toBeNull();
    expect(row!.arguments).toEqual([]);

    const plain = await runCli(["commands"], { env });
    expect(plain.stdout).toContain("instances");
  });
});
