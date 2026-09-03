import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { startFakeCloudflare } from "../src/server.js";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const script = join(repoRoot, "scripts", "deploy-dev.mjs");

type Run = { stdout: string; stderr: string; code: number };

async function runDeployDev(args: string[], env: Record<string, string | undefined>): Promise<Run> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [script, ...args], {
      cwd: repoRoot,
      env: { PATH: process.env.PATH ?? "", ...env } as NodeJS.ProcessEnv,
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: failure.code ?? -1 };
  }
}

async function secretsPath() {
  const dir = await mkdtemp(join(tmpdir(), "dropthis-deploy-dev-secrets-"));
  return join(dir, "secrets.json");
}

async function outPath() {
  const dir = await mkdtemp(join(tmpdir(), "dropthis-deploy-dev-"));
  return join(dir, "wrangler.dev.jsonc");
}

/** The rendered config is JSONC; the renderer emits comment-free JSON. */
async function readRendered(path: string) {
  return JSON.parse(await readFile(path, "utf8")) as {
    name: string;
    main: string;
    vars?: Record<string, string>;
    r2_buckets: Array<{ binding: string; bucket_name: string }>;
    kv_namespaces: Array<{ binding: string; id: string }>;
  };
}

const teardown: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (teardown.length > 0) await teardown.pop()!();
});

async function fake(options: Parameters<typeof startFakeCloudflare>[0] = {}) {
  const started = await startFakeCloudflare(options);
  teardown.push(() => started.close());
  return started;
}

const creates = (calls: Array<{ method: string; path: string }>) =>
  calls.filter((call) => call.method === "POST");

describe("deploy-dev credentials", () => {
  it("refuses to run without CLOUDFLARE_API_TOKEN and points at dev.env", async () => {
    const run = await runDeployDev(["--no-deploy"], {
      CLOUDFLARE_ACCOUNT_ID: "fake-account-id",
    });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("CLOUDFLARE_API_TOKEN");
    expect(run.stderr).toContain("~/.config/dropthis/dev.env");
  });

  it("refuses to run without CLOUDFLARE_ACCOUNT_ID and points at dev.env", async () => {
    const run = await runDeployDev(["--no-deploy"], {
      CLOUDFLARE_API_TOKEN: "fake-token",
    });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(run.stderr).toContain("~/.config/dropthis/dev.env");
  });
});

describe("deploy-dev reconcile by name", () => {
  it("creates the bucket and the KV namespace on a first run and renders the returned id", async () => {
    const cf = await fake();
    const out = await outPath();

    const run = await runDeployDev(
      ["--no-deploy", "--api-base", cf.apiBase, "--config-out", out],
      { CLOUDFLARE_API_TOKEN: "fake-token", CLOUDFLARE_ACCOUNT_ID: "fake-account-id" },
    );

    expect(run.code, run.stderr).toBe(0);
    expect(cf.state.buckets).toContain("dropthis-dev-drops");
    expect(cf.state.namespaces.map((n) => n.title)).toContain("dropthis-dev-oauth");

    const rendered = await readRendered(out);
    const created = cf.state.namespaces.find((n) => n.title === "dropthis-dev-oauth")!;
    expect(rendered.name).toBe("dropthis-dev");
    expect(rendered.r2_buckets).toEqual([
      { binding: "BUCKET", bucket_name: "dropthis-dev-drops" },
    ]);
    expect(rendered.kv_namespaces).toEqual([{ binding: "OAUTH_KV", id: created.id }]);
    expect(run.stdout.trim()).toBe("https://dropthis-dev.fake-subdomain.workers.dev");
  });

  it("reuses both on a second run: no create calls, identical rendered config", async () => {
    const cf = await fake();
    const first = await outPath();
    const second = await outPath();
    const env = { CLOUDFLARE_API_TOKEN: "fake-token", CLOUDFLARE_ACCOUNT_ID: "fake-account-id" };

    const firstRun = await runDeployDev(
      ["--no-deploy", "--api-base", cf.apiBase, "--config-out", first],
      env,
    );
    expect(firstRun.code, firstRun.stderr).toBe(0);
    cf.state.calls.length = 0;

    const secondRun = await runDeployDev(
      ["--no-deploy", "--api-base", cf.apiBase, "--config-out", second],
      env,
    );

    expect(secondRun.code, secondRun.stderr).toBe(0);
    expect(creates(cf.state.calls)).toEqual([]);
    expect(cf.state.buckets.filter((b) => b === "dropthis-dev-drops")).toHaveLength(1);
    expect(cf.state.namespaces.filter((n) => n.title === "dropthis-dev-oauth")).toHaveLength(1);
    expect(await readFile(second, "utf8")).toBe(await readFile(first, "utf8"));
  });

  it("finds resources that sit past the first page and creates no duplicate", async () => {
    const cf = await fake({
      perPage: 2,
      buckets: ["aaa-bucket", "bbb-bucket", "dropthis-dev-drops", "zzz-bucket"],
      namespaces: [
        { id: "id-a".padEnd(32, "0"), title: "aaa-kv" },
        { id: "id-b".padEnd(32, "0"), title: "bbb-kv" },
        { id: "id-c".padEnd(32, "0"), title: "ccc-kv" },
        { id: "id-existing".padEnd(32, "0"), title: "dropthis-dev-oauth" },
      ],
    });
    const out = await outPath();

    const run = await runDeployDev(
      ["--no-deploy", "--api-base", cf.apiBase, "--config-out", out],
      { CLOUDFLARE_API_TOKEN: "fake-token", CLOUDFLARE_ACCOUNT_ID: "fake-account-id" },
    );

    expect(run.code, run.stderr).toBe(0);
    expect(creates(cf.state.calls)).toEqual([]);
    expect(cf.state.buckets).toHaveLength(4);
    expect(cf.state.namespaces).toHaveLength(4);
    const rendered = await readRendered(out);
    expect(rendered.kv_namespaces[0]!.id).toBe("id-existing".padEnd(32, "0"));
  });
});

describe("deploy-dev --dry-run", () => {
  it("is read-only: it lists, renders and never creates", async () => {
    const cf = await fake();
    const out = await outPath();

    const run = await runDeployDev(
      ["--dry-run", "--api-base", cf.apiBase, "--config-out", out],
      { CLOUDFLARE_API_TOKEN: "fake-token", CLOUDFLARE_ACCOUNT_ID: "fake-account-id" },
    );

    expect(run.code, run.stderr).toBe(0);
    expect(creates(cf.state.calls)).toEqual([]);
    expect(cf.state.buckets).toEqual([]);
    expect(cf.state.namespaces).toEqual([]);
    const rendered = await readRendered(out);
    expect(rendered.name).toBe("dropthis-dev");
    expect(rendered.r2_buckets[0]!.bucket_name).toBe("dropthis-dev-drops");
  });
});

describe("deploy-dev renders the dev build", () => {
  const env = { CLOUDFLARE_API_TOKEN: "fake-token", CLOUDFLARE_ACCOUNT_ID: "fake-account-id" };

  it("points main at the dev entry and turns the /_dev probes on", async () => {
    const cf = await fake();
    const out = await outPath();

    const run = await runDeployDev(
      ["--no-deploy", "--api-base", cf.apiBase, "--config-out", out, "--secrets-out", await secretsPath()],
      env,
    );

    expect(run.code, run.stderr).toBe(0);
    const rendered = await readRendered(out);
    expect(rendered.main.endsWith("packages/worker/src/dev-entry.ts")).toBe(true);
    expect(rendered.vars).toEqual({ DEV_ROUTES: "1" });
  });

  it("mints HMAC_SECRET once and reuses it on every later run", async () => {
    const cf = await fake();
    const secrets = await secretsPath();
    const env2 = { ...env };

    const first = await runDeployDev(
      ["--no-deploy", "--api-base", cf.apiBase, "--config-out", await outPath(), "--secrets-out", secrets],
      env2,
    );
    expect(first.code, first.stderr).toBe(0);
    const minted = JSON.parse(await readFile(secrets, "utf8")) as { HMAC_SECRET: string };
    // 32 random bytes, base64url — long enough that it is not a placeholder.
    expect(minted.HMAC_SECRET.length).toBeGreaterThanOrEqual(43);

    const second = await runDeployDev(
      ["--no-deploy", "--api-base", cf.apiBase, "--config-out", await outPath(), "--secrets-out", secrets],
      env2,
    );
    expect(second.code, second.stderr).toBe(0);
    expect(JSON.parse(await readFile(secrets, "utf8"))).toEqual(minted);
  });

  it("never prints the secret", async () => {
    const cf = await fake();
    const secrets = await secretsPath();

    const run = await runDeployDev(
      ["--no-deploy", "--api-base", cf.apiBase, "--config-out", await outPath(), "--secrets-out", secrets],
      env,
    );

    const minted = JSON.parse(await readFile(secrets, "utf8")) as { HMAC_SECRET: string };
    expect(run.stdout + run.stderr).not.toContain(minted.HMAC_SECRET);
  });
});
