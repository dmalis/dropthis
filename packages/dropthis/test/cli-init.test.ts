/**
 * Seam 2 for the installer: the BUILT `dropthis` binary as a subprocess,
 * against a local fake of the Cloudflare management API and a real instance
 * on localhost.
 *
 * The in-process tests (`test/cli/init-command.test.ts`) prove the decisions.
 * These prove the thing an operator actually runs: the bundle resolves its own
 * dependencies, `--json` is one document on stdout, exit codes are what an
 * agent branches on, and no secret reaches either stream.
 */
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeCloudflare } from "../../../test/fake-cloudflare/src/server.js";
import { startFakeInstance } from "../../../test/fake-cloudflare/src/instance.js";
import type { FakeInstance } from "../../../test/fake-cloudflare/src/instance.js";
import { cleanEnv, oneJsonDocument, runCli } from "./cli-harness.js";
import { saveInstance } from "../src/init/instances-file.js";
import { stubWranglerBinary } from "./stub-wrangler.js";

const ACCOUNT = "fake-account-id";

let cf: Awaited<ReturnType<typeof startFakeCloudflare>>;
let instance: FakeInstance;
let wranglerPath: string;

beforeAll(async () => {
  instance = await startFakeInstance({});
  cf = await startFakeCloudflare({
    onDeploy: (script) => {
      const bucketName = String(
        script.bindings.find((binding) => binding.name === "BUCKET")?.bucket_name ?? "",
      );
      for (const [key, object] of cf.state.objects.get(bucketName) ?? new Map()) {
        instance.bucket.seed(key, new TextDecoder().decode(object.body));
      }
    },
  });
  wranglerPath = await stubWranglerBinary(cf.origin);
}, 120_000);

afterAll(async () => {
  await instance.close();
  await cf.close();
});

async function initEnv(): Promise<Record<string, string>> {
  return {
    ...(await cleanEnv()),
    CLOUDFLARE_API_TOKEN: "fake-token",
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
    CLOUDFLARE_BASE_URL: cf.apiBase,
    DROPTHIS_WRANGLER: wranglerPath,
    DROPTHIS_INIT_PROBE_URL: instance.url,
    DROPTHIS_INIT_POLL_MS: "10",
  };
}

describe("init through the binary", () => {
  it("prints one JSON document, exits 0, and stores the instance", async () => {
    const env = await initEnv();

    const result = await runCli(["init", "--name", "binary", "--json"], { env });

    expect(result.code, result.stderr).toBe(0);
    const document = oneJsonDocument(result.stdout) as Record<string, unknown>;
    expect(document.ok).toBe(true);
    expect(document.worker).toBe("dropthis-binary");
    expect(document.admin_key).toMatch(/^[0-9a-f]{64}$/);
    expect((document.doctor as { ok: boolean }).ok).toBe(true);

    const stored = JSON.parse(await readFile(String(document.instances_file), "utf8")) as {
      instances: Record<string, { key: string }>;
    };
    expect(stored.instances.binary!.key).toBe(document.admin_key);

    // The key is in the one field it belongs in, and nowhere else.
    const occurrences = result.stdout.split(String(document.admin_key)).length - 1;
    expect(occurrences).toBe(1);
    expect(result.stderr).not.toContain(String(document.admin_key));
    // The HMAC secret is a 64-hex string like the key, and it must never be
    // printed: so every 64-hex string in either stream has to BE the key.
    const secrets = [...`${result.stdout}${result.stderr}`.matchAll(/[0-9a-f]{64}/g)].map((m) => m[0]);
    expect(new Set(secrets)).toEqual(new Set([document.admin_key]));
  }, 120_000);

  it("exits 4 with the frozen error object when no credential is set", async () => {
    const env = await cleanEnv();

    const result = await runCli(["init", "--json"], { env });

    expect(result.code).toBe(4);
    expect(result.stdout).toBe("");
    expect(oneJsonDocument(result.stderr)).toMatchObject({ code: "UNAUTHENTICATED", retryable: false });
  }, 120_000);

  it("resolves its own bundled wrangler when nothing points at one", async () => {
    const env = await initEnv();
    delete (env as Record<string, string | undefined>).DROPTHIS_WRANGLER;

    const result = await runCli(["init", "--name", "realwrangler", "--json"], { env });

    // The deploy fails — the fake API is not Cloudflare — but wrangler itself
    // ran, which is what this proves: the bundle found its own binary.
    expect(result.stderr).toMatch(/wrangler/);
    expect(result.stderr).not.toMatch(/Cannot find module/);
  }, 120_000);

  it("--dry-run touches nothing", async () => {
    const env = await initEnv();

    const result = await runCli(["init", "--name", "dry", "--dry-run", "--json"], { env });

    expect(result.code, result.stderr).toBe(0);
    expect(cf.state.buckets).not.toContain("dropthis-dry-drops");
    expect(cf.state.namespaces.map((n) => n.title)).not.toContain("dropthis-dry-oauth");
  }, 120_000);
});

describe("connect and auth-header through the binary", () => {
  it("registers claude-code without the key touching the file", async () => {
    const env = await cleanEnv();
    await saveInstance(env, "main", { url: instance.url, key: "c".repeat(64) });
    const cwd = await mkdtemp(join(tmpdir(), "dropthis-bin-project-"));

    const result = await runCli(["connect", "--client", "claude-code", "--json"], { env, cwd });

    expect(result.code, result.stderr).toBe(0);
    const written = await readFile(join(cwd, ".mcp.json"), "utf8");
    expect(written).toContain("dropthis auth-header --instance main");
    expect(written).not.toContain("c".repeat(64));

    const header = await runCli(["auth-header", "--instance", "main"], { env });
    expect(header.code).toBe(0);
    expect(header.stdout).toBe(`Authorization: Bearer ${"c".repeat(64)}\n`);
  }, 120_000);
});
