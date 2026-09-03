import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BASE_URL } from "./base-url.js";
import { adminKey, api } from "./client.js";

/**
 * Seam 2 against the deployed dev instance: the built `dropthis` binary
 * publishing to real R2. The offline half of the CLI corpus lives in
 * `packages/dropthis/test/cli-*.test.ts`; this file proves the two things
 * that need the real thing — a 5 MiB staged publish serving identical bytes
 * and replaying under one key, and the env pair beating instances.json with
 * the drop landing on the env URL.
 */
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const bin = join(repoRoot, "packages", "dropthis", "dist", "cli.cjs");

type Run = { stdout: string; stderr: string; code: number };

function run(args: string[], env: Record<string, string>): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd: repoRoot, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.stdin.end();
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
  });
}

const oneJson = (text: string): Record<string, unknown> => {
  const lines = text.split("\n").filter((line) => line.length > 0);
  expect(lines, text).toHaveLength(1);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
};

let env: Record<string, string>;
let dir: string;

beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("npm", ["run", "--silent", "build"], { cwd: join(repoRoot, "packages", "dropthis"), stdio: "ignore" });
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`build exited ${code}`))));
  });
  const home = await mkdtemp(join(tmpdir(), "dropthis-cli-home-"));
  env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    DROPTHIS_URL: BASE_URL,
    DROPTHIS_KEY: adminKey(),
  };
  dir = await mkdtemp(join(tmpdir(), "dropthis-cli-site-"));
  await writeFile(join(dir, "index.html"), "<h1>cli</h1>");
}, 120_000);

describe("dropthis publish against the deployed instance", () => {
  it("prints only the URL and the page serves", async () => {
    const result = await run(["publish", join(dir, "index.html"), "--title", "CLI hello"], env);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(new RegExp(`^${BASE_URL}/[a-z0-9]{10}/\n$`));
    const served = await fetch(result.stdout.trim(), { cache: "no-store" });
    expect(await served.text()).toBe("<h1>cli</h1>");
  }, 60_000);

  it("a 5 MiB file stages, serves identical bytes, and replays under one idempotency key", async () => {
    const big = randomBytes(5 * 1024 * 1024);
    const bigPath = join(dir, "big.bin");
    await writeFile(bigPath, big);
    const title = `Staged ${crypto.randomUUID().slice(0, 8)}`;
    const args = ["publish", bigPath, "--json", "--title", title, "--idempotency-key", `cli-${title}`];

    const first = await run(args, env);
    expect(first.code, first.stderr).toBe(0);
    const drop = oneJson(first.stdout);
    const digest = createHash("sha256").update(big).digest("hex");
    expect((drop.files as Array<Record<string, unknown>>)[0]).toMatchObject({ path: "big.bin", size: big.length, sha256: digest });

    const served = await fetch(`${drop.url as string}big.bin`, { cache: "no-store" });
    expect(served.status).toBe(200);
    expect(Buffer.from(await served.arrayBuffer()).equals(big)).toBe(true);

    const second = await run(args, env);
    expect(second.code, second.stderr).toBe(0);
    expect(oneJson(second.stdout).slug).toBe(drop.slug);

    // One drop with that title, not two.
    const listed = await run(["list", "--json", "--q", title], env);
    expect((oneJson(listed.stdout).drops as unknown[]).length).toBe(1);
  }, 180_000);

  it("the env pair wins over instances.json: the drop lands on the env URL", async () => {
    const file = join(env.XDG_CONFIG_HOME!, "dropthis", "instances.json");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({ default: "wrong", instances: { wrong: { url: "http://127.0.0.1:1", key: "not-a-key" } } }),
    );
    const result = await run(["publish", join(dir, "index.html"), "--json", "--instance", "wrong"], env);
    expect(result.code, result.stderr).toBe(0);
    expect((oneJson(result.stdout).url as string).startsWith(BASE_URL)).toBe(true);

    // Without the env pair the file is used, and the wrong instance is unreachable.
    const { DROPTHIS_URL: _u, DROPTHIS_KEY: _k, ...noEnv } = env;
    const unreachable = await run(["list", "--json"], noEnv);
    expect(unreachable.code).toBe(1);
    expect(oneJson(unreachable.stderr).code).toBe("INTERNAL");
  }, 60_000);

  it("prune --jsonl streams steps and ends with the --json document", async () => {
    const json = await run(["prune", "--json"], env);
    expect(json.code, json.stderr).toBe(0);
    const report = oneJson(json.stdout);
    expect(report.dry_run).toBe(true);

    const jsonl = await run(["prune", "--jsonl"], env);
    expect(jsonl.code, jsonl.stderr).toBe(0);
    const lines = jsonl.stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(Object.keys(lines[lines.length - 1]!)).toEqual(Object.keys(report));
    expect(lines[lines.length - 1]!.incomplete).toBe(false);
  }, 120_000);

  it("a bad key exits 4 with the instance's own error object", async () => {
    const result = await run(["list", "--json"], { ...env, DROPTHIS_KEY: "nope" });
    expect(result.code).toBe(4);
    expect(oneJson(result.stderr)).toMatchObject({ code: "UNAUTHENTICATED", retryable: false });
    // Health still answers: the instance is there, the key is not.
    expect((await api("/_api/v1/health", {}, "")).status).toBe(200);
  });
});
