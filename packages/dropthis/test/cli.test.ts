import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { cleanEnv, oneJsonDocument, packageRoot, runCli } from "./cli-harness.js";

/**
 * The binary's own contract, with no instance behind it: version, help,
 * `commands --json`, and what a bad invocation looks like.
 */
let version: string;
let env: Record<string, string>;

beforeAll(async () => {
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
    version: string;
  };
  version = manifest.version;
  env = await cleanEnv();
}, 120_000);

describe("dropthis --version", () => {
  it("prints the package version on stdout and exits 0", async () => {
    const run = await runCli(["--version"], { env });
    expect(run.code).toBe(0);
    expect(run.stdout.trim()).toBe(version);
  });
});

describe("dropthis --help", () => {
  it("lists the AGENTS.md grammar and exits 0", async () => {
    const run = await runCli(["--help"], { env });
    expect(run.code).toBe(0);
    for (const word of ["publish", "update", "get", "list", "delete", "user", "config", "usage", "prune", "doctor", "commands"]) {
      expect(run.stdout).toContain(word);
    }
  });

  it("with no command prints the help to stderr and exits 1", async () => {
    const run = await runCli([], { env });
    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("Usage: dropthis");
  });
});

describe("dropthis commands --json", () => {
  it("lists every command with its arguments and options as one document", async () => {
    const run = await runCli(["commands", "--json"], { env });
    expect(run.code).toBe(0);
    const surface = oneJsonDocument(run.stdout) as Array<Record<string, unknown>>;
    expect(surface.map((entry) => entry.command)).toEqual([
      "publish", "update", "get", "list", "delete", "user add", "user list", "user remove",
      "config get", "config set", "usage", "prune", "doctor",
    ]);
    const publish = surface[0]!;
    expect(publish.arguments).toEqual([{ name: "paths", kind: "files", required: true, variadic: true }]);
    expect((publish.options as Array<{ flag: string }>).map((o) => o.flag)).toEqual([
      "--title", "--meta", "--password", "--expires", "--noindex", "--idempotency-key",
      "--password-stdin",
    ]);
    expect(surface.find((entry) => entry.command === "prune")!.steps).toBe(true);
  });

  it("no flag anywhere accepts a key", async () => {
    const run = await runCli(["commands", "--json"], { env });
    const surface = oneJsonDocument(run.stdout) as Array<{ options: Array<{ flag: string }> }>;
    const flags = surface.flatMap((entry) => entry.options.map((o) => o.flag));
    expect(flags.some((flag) => /key$/.test(flag) && flag !== "--idempotency-key")).toBe(false);
    // `--password` exists (the field is `publish`'s), but it takes only the
    // spellings that are NOT a secret: a chosen one goes in on stdin.
    expect(flags.filter((flag) => /token|secret|password/.test(flag)).sort()).toEqual([
      "--password", "--password", "--password-stdin", "--password-stdin",
    ]);
    const publish = surface[0] as unknown as { options: Array<{ flag: string; description: string }> };
    const password = publish.options.find((o) => o.flag === "--password")!;
    expect(password.description).toContain("--password-stdin");
  });
});

describe("a bad invocation", () => {
  it("unknown command → exit 1, one stderr message, nothing on stdout", async () => {
    const run = await runCli(["frobnicate"], { env });
    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("frobnicate");
  });

  it("missing argument → exit 1 before any credential is read", async () => {
    const run = await runCli(["get"], { env });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("target");
  });
});
