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
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
    zones: [{ id: "z-example", name: "example.com", account: { id: ACCOUNT } }],
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

    const document = oneJsonDocument(result.stdout) as Record<string, unknown>;
    expect(document.worker).toBe("dropthis-binary");
    expect(document.admin_key).toMatch(/^[0-9a-f]{64}$/);
    // Everything `doctor` proves, minus the one check that times the machine
    // this test runs on against a budget chosen for a Cloudflare Worker.
    const checks = (document.doctor as { checks: Array<{ id: string; status: string; evidence: string }> }).checks;
    expect(
      checks
        .filter((check) => check.status === "fail" && check.id !== "pbkdf2_benchmark")
        .map((check) => `${check.id}: ${check.evidence}`),
    ).toEqual([]);
    if (checks.every((check) => check.status !== "fail")) {
      expect(result.code, result.stderr).toBe(0);
      expect(document.ok).toBe(true);
    }

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

/**
 * Issue #25 through the binary: a Workers Route on the zone takes precedence
 * over the Custom Domain, so `init --domain` adds the one route that wins and
 * says so in its own step. Read the steps out of the one JSON document — that
 * is the record an agent branches on.
 */
describe("init --domain and a shadowing Workers Route", () => {
  const SHADOW = { id: "r1", zoneId: "z-example", pattern: "*.example.com/*", script: "notice" };

  afterEach(() => {
    cf.state.zoneRoutes.length = 0;
    cf.state.workerDomains.length = 0;
    cf.state.routeWriteForbidden = false;
  });

  const steps = (stdout: string): Array<{ step: string; status: string; detail?: string }> =>
    (oneJsonDocument(stdout) as { steps: Array<{ step: string; status: string; detail?: string }> }).steps;

  const routeStep = (stdout: string) => steps(stdout).find((s) => s.step === "route");

  it("creates <hostname>/* when a foreign route shadows the domain", async () => {
    cf.state.zoneRoutes.push({ ...SHADOW });
    const env = await initEnv();

    const result = await runCli(
      ["init", "--name", "shadowed", "--domain", "shadowed.example.com", "--json"],
      { env },
    );

    expect(routeStep(result.stdout)).toEqual({
      step: "route",
      status: "created",
      detail:
        "shadowed.example.com/* \u2192 dropthis-shadowed (shadowed by *.example.com/* \u2192 notice)",
    });
    expect(cf.state.zoneRoutes.map((r) => `${r.pattern} -> ${r.script}`)).toEqual([
      "*.example.com/* -> notice",
      "shadowed.example.com/* -> dropthis-shadowed",
    ]);
  }, 120_000);

  it("reports ok and adds nothing when no route shadows the domain", async () => {
    cf.state.zoneRoutes.push({ id: "r1", zoneId: "z-example", pattern: "blog.example.com/*", script: "notice" });
    const env = await initEnv();

    const result = await runCli(
      ["init", "--name", "clear", "--domain", "clear.example.com", "--json"],
      { env },
    );

    expect(routeStep(result.stdout)).toEqual({ step: "route", status: "ok", detail: "no shadowing route" });
    expect(cf.state.zoneRoutes).toHaveLength(1);
  }, 120_000);

  it("--dry-run reports would_create and touches the zone not at all", async () => {
    cf.state.zoneRoutes.push({ ...SHADOW });
    const env = await initEnv();

    const result = await runCli(
      ["init", "--name", "dryroute", "--domain", "dryroute.example.com", "--dry-run", "--json"],
      { env },
    );

    expect(result.code, result.stderr).toBe(0);
    expect(routeStep(result.stdout)?.status).toBe("would_create");
    expect(routeStep(result.stdout)?.detail).toContain("dryroute.example.com/*");
    expect(cf.state.zoneRoutes).toHaveLength(1);
  }, 120_000);

  it("names Workers Routes:Edit and still runs the health poll when the write is refused", async () => {
    cf.state.zoneRoutes.push({ ...SHADOW });
    cf.state.routeWriteForbidden = true;
    const env = await initEnv();

    const result = await runCli(
      ["init", "--name", "noperm", "--domain", "noperm.example.com", "--json"],
      { env },
    );

    const route = routeStep(result.stdout);
    expect(route?.status).toBe("error");
    expect(route?.detail).toContain("Workers Routes:Edit");
    expect(route?.detail).toContain("noperm.example.com/*");
    // The record stays honest: the run went on to probe the instance.
    expect(steps(result.stdout).map((s) => s.step)).toContain("health");
    expect(result.code).toBe(1);
    expect(cf.state.zoneRoutes).toHaveLength(1);
  }, 120_000);

  it("--check reports route_clear as a fail with the route to add by hand", async () => {
    cf.state.zoneRoutes.push({ ...SHADOW });
    const env = await initEnv();

    const result = await runCli(
      ["init", "--name", "shadowed", "--domain", "shadowed.example.com", "--check", "--json"],
      { env },
    );

    const report = oneJsonDocument(result.stdout) as {
      checks: Array<{ id: string; status: string; evidence: string; remediation?: string }>;
    };
    const route = report.checks.find((check) => check.id === "route_clear");
    expect(route?.status).toBe("fail");
    expect(route?.evidence).toContain("*.example.com/*");
    expect(route?.remediation).toContain("shadowed.example.com/*");
    expect(result.code).toBe(1);
    // `--check` never mutates.
    expect(cf.state.zoneRoutes).toHaveLength(1);
  }, 120_000);
});
