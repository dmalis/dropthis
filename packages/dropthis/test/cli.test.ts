import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const bin = join(packageRoot, "dist", "cli.cjs");

async function runCli(args: string[]) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [bin, ...args]);
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: failure.code ?? -1 };
  }
}

let version: string;

beforeAll(async () => {
  await execFileAsync("npm", ["run", "--silent", "build"], { cwd: packageRoot });
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
    version: string;
  };
  version = manifest.version;
}, 120_000);

describe("dropthis --version", () => {
  it("prints the package version on stdout and exits 0", async () => {
    const run = await runCli(["--version"]);
    expect(run.code).toBe(0);
    expect(run.stdout.trim()).toBe(version);
  });
});

describe("dropthis with an argv it does not know", () => {
  it.each([["publish"], ["--help"], []])("exits 1 for %j with one stderr line", async (...args) => {
    const argv = args.flat();
    const run = await runCli(argv);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr.trim().split("\n")).toHaveLength(1);
    expect(run.stderr.trim().length).toBeGreaterThan(0);
  });
});
