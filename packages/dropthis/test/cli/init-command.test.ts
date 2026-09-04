/**
 * `dropthis init` and `dropthis connect`, driven through `main()` with an
 * explicit io — the same entry the binary calls. The account API is the local
 * fake; the deploy is the real `wranglerDeploy` pointed at a stub wrangler
 * that registers the script with the fake and reports where the instance is.
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { startFakeCloudflare } from "../../../../test/fake-cloudflare/src/server.js";
import { startFakeInstance } from "../../../../test/fake-cloudflare/src/instance.js";
import { main } from "../../src/cli/main.js";
import { saveInstance } from "../../src/init/instances-file.js";
import { stubWrangler, stubWranglerBinary } from "../stub-wrangler.js";

const teardown: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (teardown.length > 0) await teardown.pop()!();
});

const ACCOUNT = "fake-account-id";

function collect() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return { stream, text: () => chunks.join("") };
}

async function home(): Promise<Record<string, string>> {
  const dir = await mkdtemp(join(tmpdir(), "dropthis-cmd-"));
  return { HOME: dir, XDG_CONFIG_HOME: join(dir, ".config") };
}

type RunOptions = { env: Record<string, string | undefined>; cwd?: string };

async function run(argv: string[], options: RunOptions) {
  const stdout = collect();
  const stderr = collect();
  const stdin = new PassThrough();
  stdin.end();
  const code = await main(argv, "0.1.0", {
    env: options.env,
    cwd: options.cwd ?? process.cwd(),
    stdin,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

/**
 * The account API, plus a real instance on localhost that the deploy fills.
 *
 * The URL has to exist BEFORE `init` runs (it is what `init` polls), and the
 * bucket only exists once `init` has written it — so the instance starts
 * empty and the fake's `onDeploy` hook copies the installer's bucket into it
 * at the moment a deploy happens, which is exactly when a real Worker starts
 * seeing that bucket.
 */
async function fake(options: Parameters<typeof startFakeCloudflare>[0] = {}) {
  const instance = await startFakeInstance({});
  teardown.push(() => instance.close());
  const started = await startFakeCloudflare({
    ...options,
    onDeploy: (script) => {
      const bucketName = String(
        script.bindings.find((binding) => binding.name === "BUCKET")?.bucket_name ?? "",
      );
      for (const [key, object] of started.state.objects.get(bucketName) ?? new Map()) {
        instance.bucket.seed(key, new TextDecoder().decode(object.body));
      }
    },
  });
  teardown.push(() => started.close());
  return { ...started, instanceUrl: instance.url, instance };
}

/**
 * `doctor`'s `pbkdf2_benchmark` times a real derive against the 8 ms budget a
 * Cloudflare Worker has. Inside a Node test process on a loaded machine the
 * same 25,000 iterations cost 10-16 ms, so asserting a green run outright
 * would make the suite a function of how busy the laptop is. Everything else
 * `doctor` proves is asserted; the benchmark is allowed to be slow here.
 */
const slowMachineOnly = (document: Record<string, unknown>): boolean => {
  const checks = (document.doctor as { checks?: Array<{ id: string; status: string }> } | undefined)?.checks ?? [];
  const failed = checks.filter((check) => check.status === "fail");
  return failed.length > 0 && failed.every((check) => check.id === "pbkdf2_benchmark");
};

const expectProved = (document: Record<string, unknown>, code: number): void => {
  const checks = (document.doctor as { checks?: Array<{ id: string; status: string; evidence: string }> } | undefined)?.checks ?? [];
  expect(checks.length).toBeGreaterThan(0);
  expect(
    checks
      .filter((check) => check.status === "fail" && check.id !== "pbkdf2_benchmark")
      .map((check) => `${check.id}: ${check.evidence}`),
  ).toEqual([]);
  if (!slowMachineOnly(document)) {
    expect(document.ok).toBe(true);
    expect(code).toBe(0);
  }
};

const oneDocument = (text: string): Record<string, unknown> => {
  const lines = text.split("\n").filter((line) => line.length > 0);
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
};

describe("init --json", () => {
  it("provisions, proves and stores an instance in one deterministic document", async () => {
    const cf = await fake();
    const env = {
      ...(await home()),
      PATH: process.env.PATH,
      CLOUDFLARE_API_TOKEN: "fake-token",
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
      CLOUDFLARE_BASE_URL: cf.apiBase,
      DROPTHIS_WRANGLER: await stubWranglerBinary(cf.origin),
      DROPTHIS_INIT_PROBE_URL: cf.instanceUrl,
      DROPTHIS_INIT_POLL_MS: "10",
    };

    const result = await run(["init", "--json"], { env });

    const document = oneDocument(result.stdout);
    expectProved(document, result.code);
    expect(document.name).toBe("main");
    expect(document.kv_namespace).toBe("dropthis-main-oauth");
    expect(document.admin_key_status).toBe("created");
    expect(document.admin_key).toMatch(/^[0-9a-f]{64}$/);
    expect((document.steps as Array<{ step: string }>).map((s) => s.step)).toContain("doctor");
    expect(document.instances_file).toMatch(/instances\.json$/);

    const stored = JSON.parse(await readFile(String(document.instances_file), "utf8")) as {
      instances: Record<string, { key: string }>;
    };
    expect(stored.instances.main!.key).toBe(document.admin_key);
  });

  it("a rerun repairs, reports existing and never re-prints the key", async () => {
    const cf = await fake();
    const env = {
      ...(await home()),
      PATH: process.env.PATH,
      CLOUDFLARE_API_TOKEN: "fake-token",
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
      CLOUDFLARE_BASE_URL: cf.apiBase,
      DROPTHIS_WRANGLER: await stubWranglerBinary(cf.origin),
      DROPTHIS_INIT_PROBE_URL: cf.instanceUrl,
      DROPTHIS_INIT_POLL_MS: "10",
    };
    const first = oneDocument((await run(["init", "--json"], { env })).stdout);

    const second = await run(["init", "--json"], { env });

    const document = oneDocument(second.stdout);
    expect(document.admin_key_status).toBe("existing");
    expect(document.admin_key).toBeUndefined();
    expect(second.stdout).not.toContain(String(first.admin_key));
    expect(second.stderr).not.toContain(String(first.admin_key));
  });

  it("pins the account init resolved into wrangler's environment, token-only", async () => {
    // No CLOUDFLARE_ACCOUNT_ID and no --account-id: preflight resolves the
    // one account the token sees, and THAT is what the deploy must be pinned
    // to (AGENTS.md: "a deploy cannot land in the wrong account"). An empty
    // CLOUDFLARE_ACCOUNT_ID leaves wrangler to pick one for itself.
    const cf = await fake();
    const wrangler = await stubWrangler(cf.origin);
    const env = {
      ...(await home()),
      PATH: process.env.PATH,
      CLOUDFLARE_API_TOKEN: "fake-token",
      CLOUDFLARE_BASE_URL: cf.apiBase,
      DROPTHIS_WRANGLER: wrangler.path,
      DROPTHIS_INIT_PROBE_URL: cf.instanceUrl,
      DROPTHIS_INIT_POLL_MS: "10",
    };

    await run(["init", "--json"], { env });

    const record = JSON.parse(await readFile(wrangler.recordPath, "utf8")) as {
      env: Record<string, string>;
    };
    expect(record.env.CLOUDFLARE_ACCOUNT_ID).toBe(ACCOUNT);
  });

  it("streams one event per step under --jsonl and ends with the document --json prints", async () => {
    const cf = await fake();
    const env = {
      ...(await home()),
      PATH: process.env.PATH,
      CLOUDFLARE_API_TOKEN: "fake-token",
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
      CLOUDFLARE_BASE_URL: cf.apiBase,
      DROPTHIS_WRANGLER: await stubWranglerBinary(cf.origin),
      DROPTHIS_INIT_PROBE_URL: cf.instanceUrl,
      DROPTHIS_INIT_POLL_MS: "10",
    };

    const result = await run(["init", "--jsonl"], { env });

    const lines = result.stdout.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line));
    expect(lines.length).toBeGreaterThan(5);
    expect(lines[0]).toEqual({ step: "token", status: "ok" });
    const final = lines[lines.length - 1] as Record<string, unknown>;
    expectProved(final, 0);
    expect(final.steps).toHaveLength(lines.length - 1);
  });

  it("never prints the HMAC secret, in any mode", async () => {
    const cf = await fake();
    const env = {
      ...(await home()),
      PATH: process.env.PATH,
      CLOUDFLARE_API_TOKEN: "fake-token",
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
      CLOUDFLARE_BASE_URL: cf.apiBase,
      DROPTHIS_WRANGLER: await stubWranglerBinary(cf.origin),
      DROPTHIS_INIT_PROBE_URL: cf.instanceUrl,
      DROPTHIS_INIT_POLL_MS: "10",
    };

    const json = await run(["init", "--json"], { env });
    const plain = await run(["init", "--name", "second"], { env });

    for (const stream of [json.stdout, json.stderr, plain.stdout, plain.stderr]) {
      expect(stream).not.toMatch(/HMAC_SECRET["'\s]*[:=]/);
    }
  });

  it("--dry-run creates nothing and deploys nothing", async () => {
    const cf = await fake();
    const env = {
      ...(await home()),
      PATH: process.env.PATH,
      CLOUDFLARE_API_TOKEN: "fake-token",
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
      CLOUDFLARE_BASE_URL: cf.apiBase,
      DROPTHIS_WRANGLER: await stubWranglerBinary(cf.origin),
      DROPTHIS_INIT_PROBE_URL: cf.instanceUrl,
    };

    const result = await run(["init", "--dry-run", "--json"], { env });

    const document = oneDocument(result.stdout);
    expect(result.code).toBe(0);
    expect(cf.state.buckets).toEqual([]);
    expect(cf.state.namespaces).toEqual([]);
    expect(cf.state.scripts.size).toBe(0);
    expect(document.admin_key).toBeUndefined();
  });

  it("exits 4 with the token page and the four permissions when no credential is set", async () => {
    const env = { ...(await home()), PATH: process.env.PATH };

    const result = await run(["init", "--json"], { env });

    expect(result.code).toBe(4);
    const error = oneDocument(result.stderr);
    expect(error.code).toBe("UNAUTHENTICATED");
    expect(String(error.remediation)).toContain("https://dash.cloudflare.com/profile/api-tokens");
    expect(String(error.remediation)).toContain("Workers R2 Storage — Edit");
    expect(result.stdout).toBe("");
  });

  it("--check answers the account questions and stops", async () => {
    const cf = await fake({ buckets: ["dropthis-main-drops"] });
    const env = {
      ...(await home()),
      PATH: process.env.PATH,
      CLOUDFLARE_API_TOKEN: "fake-token",
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
      CLOUDFLARE_BASE_URL: cf.apiBase,
    };

    const result = await run(["init", "--check", "--json"], { env });

    const document = oneDocument(result.stdout);
    expect(result.code).toBe(1);
    expect((document.checks as Array<{ id: string }>).map((check) => check.id)).toEqual([
      "lifecycle_rules",
      "kv_bound",
      "domain_attached",
    ]);
    expect(cf.state.scripts.size).toBe(0);
  });
});

describe("connect and auth-header", () => {
  async function instanceHome() {
    const env = await home();
    const started = await startFakeInstance({ adminKey: "k".repeat(64) });
    teardown.push(() => started.close());
    await saveInstance(env, "main", { url: started.url, key: "k".repeat(64) });
    return { env: { ...env, PATH: process.env.PATH }, url: started.url };
  }

  it("claude-code writes .mcp.json with a header helper and no key", async () => {
    const { env, url } = await instanceHome();
    const cwd = await mkdtemp(join(tmpdir(), "dropthis-project-"));

    const result = await run(["connect", "--client", "claude-code", "--json"], { env, cwd });

    expect(result.code).toBe(0);
    const written = JSON.parse(await readFile(join(cwd, ".mcp.json"), "utf8")) as {
      mcpServers: { dropthis: { type: string; url: string; headersHelper: string } };
    };
    expect(written.mcpServers.dropthis.type).toBe("http");
    expect(written.mcpServers.dropthis.url).toBe(`${url}/_api/mcp`);
    expect(written.mcpServers.dropthis.headersHelper).toBe("dropthis auth-header --instance main");
    expect(JSON.stringify(written)).not.toContain("k".repeat(64));
    expect(result.stdout).not.toContain("k".repeat(64));
  });

  it("claude-code merges into an existing .mcp.json instead of replacing it", async () => {
    const { env } = await instanceHome();
    const cwd = await mkdtemp(join(tmpdir(), "dropthis-project-"));
    await writeFile(
      join(cwd, ".mcp.json"),
      JSON.stringify({ mcpServers: { other: { command: "x" } } }),
      "utf8",
    );

    await run(["connect", "--client", "claude-code", "--json"], { env, cwd });

    const written = JSON.parse(await readFile(join(cwd, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(written.mcpServers).sort()).toEqual(["dropthis", "other"]);
  });

  it("cursor and codex reference the env var and print the export line, never the key", async () => {
    const { env } = await instanceHome();

    for (const client of ["cursor", "codex"]) {
      const result = await run(["connect", "--client", client, "--json"], { env });
      const document = oneDocument(result.stdout);

      expect(result.code).toBe(0);
      expect(document.key_env_var).toBe("DROPTHIS_KEY_MAIN");
      expect(String(document.shell_profile_line)).toContain("export DROPTHIS_KEY_MAIN=");
      expect(result.stdout).not.toContain("k".repeat(64));
    }
  });

  it("claude-ai gives the connector URL and a message to forward, and writes no file", async () => {
    const { env, url } = await instanceHome();
    const cwd = await mkdtemp(join(tmpdir(), "dropthis-project-"));

    const result = await run(["connect", "--client", "claude-ai", "--json"], { env, cwd });

    const document = oneDocument(result.stdout);
    expect(document.connector_url).toBe(`${url}/_api/mcp`);
    expect(String(document.message)).toContain(`${url}/_api/mcp`);
    await expect(readFile(join(cwd, ".mcp.json"), "utf8")).rejects.toThrow();
  });

  it("refuses a client it does not know", async () => {
    const { env } = await instanceHome();

    const result = await run(["connect", "--client", "emacs", "--json"], { env });

    expect(result.code).toBe(1);
    expect(String(oneDocument(result.stderr).message)).toContain("claude-code");
  });

  it("auth-header prints one header line and nothing else", async () => {
    const { env } = await instanceHome();

    const result = await run(["auth-header", "--instance", "main"], { env });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`Authorization: Bearer ${"k".repeat(64)}\n`);
    expect(result.stderr).toBe("");
  });

  it("auth-header exits 4 for an instance it does not know", async () => {
    const { env } = await instanceHome();

    const result = await run(["auth-header", "--instance", "nope"], { env });

    expect(result.code).toBe(4);
    expect(result.stdout).toBe("");
  });
});
