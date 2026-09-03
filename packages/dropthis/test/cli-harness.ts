import { execFile, spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/**
 * Seam 2: the built `dropthis` binary as a subprocess. Every test here spawns
 * `dist/cli.cjs` with an explicit environment — no inherited credentials, no
 * TTY — and asserts on stdout, stderr and the exit code, which is exactly
 * what an agent branches on.
 */
export const execFileAsync = promisify(execFile);
export const packageRoot = fileURLToPath(new URL("../", import.meta.url));
export const bin = join(packageRoot, "dist", "cli.cjs");

export type RunResult = { stdout: string; stderr: string; code: number };

export type RunOptions = {
  env?: Record<string, string | undefined>;
  cwd?: string;
  input?: string;
};

/** A clean environment: PATH for node, HOME in a temp dir, nothing dropthis-shaped. */
export async function cleanEnv(): Promise<Record<string, string>> {
  const home = await mkdtemp(join(tmpdir(), "dropthis-home-"));
  return { PATH: process.env.PATH ?? "", HOME: home, XDG_CONFIG_HOME: join(home, ".config") };
}

export function runCli(args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: options.cwd ?? packageRoot,
      env: options.env ?? {},
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    if (options.input !== undefined) child.stdin.write(options.input);
    child.stdin.end();
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
  });
}

/** One build per run, from the `cli` project's global setup — never per file. */
export async function buildCli(): Promise<void> {
  await execFileAsync("npm", ["run", "--silent", "build"], { cwd: packageRoot });
}

export const oneJsonDocument = (text: string): unknown => {
  const lines = text.split("\n").filter((line) => line.length > 0);
  if (lines.length !== 1) throw new Error(`expected exactly one line, got ${lines.length}: ${text}`);
  return JSON.parse(lines[0]!);
};
