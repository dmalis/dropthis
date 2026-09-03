import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { instanceConfigDir, resolveWrangler, wranglerDeploy } from "../../src/init/deploy.js";
import type { RenderedWranglerConfig } from "../../src/init/plan-render.js";

const CONFIG: RenderedWranglerConfig = {
  name: "dropthis-main",
  main: "/repo/packages/worker/src/index.ts",
  r2_buckets: [{ binding: "BUCKET", bucket_name: "dropthis-main-drops" }],
  kv_namespaces: [{ binding: "OAUTH_KV", id: "kv-id" }],
};

async function home(): Promise<Record<string, string>> {
  const dir = await mkdtemp(join(tmpdir(), "dropthis-deploy-"));
  return { HOME: dir, XDG_CONFIG_HOME: join(dir, ".config") };
}

/** A stub wrangler: records argv and the env it was handed, then exits. */
async function stubWrangler(exitCode: number): Promise<{ path: string; recordPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "dropthis-wrangler-"));
  const recordPath = join(dir, "record.json");
  const path = join(dir, "wrangler.js");
  await writeFile(
    path,
    [
      "const { writeFileSync, readFileSync } = require('node:fs');",
      `const record = { argv: process.argv.slice(2), env: process.env, cwd: process.cwd() };`,
      "const at = (flag) => { const i = record.argv.indexOf(flag); return i === -1 ? null : record.argv[i + 1]; };",
      "const configArg = at('-c');",
      "const secretsArg = at('--secrets-file');",
      "record.config = configArg ? readFileSync(configArg, 'utf8') : null;",
      "record.secrets = secretsArg ? readFileSync(secretsArg, 'utf8') : null;",
      `writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify(record));`,
      `process.exit(${exitCode});`,
    ].join("\n"),
    "utf8",
  );
  return { path, recordPath };
}

describe("resolveWrangler", () => {
  it("finds the bundled wrangler binary", async () => {
    const path = resolveWrangler();

    expect(path).toMatch(/wrangler[/\\]bin[/\\]wrangler\.js$/);
    expect((await stat(path)).isFile()).toBe(true);
  });
});

describe("wranglerDeploy", () => {
  it("deploys from a rendered config under the config home, with the credential pinned", async () => {
    const env = await home();
    const wrangler = await stubWrangler(0);

    await wranglerDeploy({
      env,
      name: "main",
      config: CONFIG,
      secrets: { HMAC_SECRET: "s3cr3t" },
      token: "cf-token",
      accountId: "acct-1",
      wranglerPath: wrangler.path,
    });

    const record = JSON.parse(await readFile(wrangler.recordPath, "utf8")) as {
      argv: string[];
      env: Record<string, string>;
      config: string;
      secrets: string;
    };
    expect(record.argv[0]).toBe("deploy");
    expect(record.argv).toContain("-c");
    expect(record.argv).toContain("--secrets-file");
    expect(record.env.CLOUDFLARE_API_TOKEN).toBe("cf-token");
    expect(record.env.CLOUDFLARE_ACCOUNT_ID).toBe("acct-1");
    expect(record.env.WRANGLER_SEND_METRICS).toBe("false");
    expect(JSON.parse(record.config).name).toBe("dropthis-main");
    expect(JSON.parse(record.secrets).HMAC_SECRET).toBe("s3cr3t");

    // The config it deployed from stays; the secrets file does not.
    const dir = instanceConfigDir(env, "main");
    const left = await readdir(dir);
    expect(left).toContain("wrangler.json");
    expect(left.some((entry) => entry.includes("secret"))).toBe(false);
    expect((await stat(join(dir, "wrangler.json"))).mode & 0o777).toBe(0o600);
    // Nothing was written into the working directory.
    expect(await readdir(process.cwd())).not.toContain("wrangler.json");
  });

  it("removes the secrets file even when wrangler fails, and says what exited", async () => {
    const env = await home();
    const wrangler = await stubWrangler(1);

    await expect(
      wranglerDeploy({
        env,
        name: "main",
        config: CONFIG,
        secrets: { HMAC_SECRET: "s3cr3t" },
        token: "cf-token",
        accountId: "acct-1",
        wranglerPath: wrangler.path,
      }),
    ).rejects.toThrow(/exited 1/);

    const left = await readdir(instanceConfigDir(env, "main"));
    expect(left.some((entry) => entry.includes("secret"))).toBe(false);
  });

  it("passes no --secrets-file when there is no secret to ship", async () => {
    const env = await home();
    const wrangler = await stubWrangler(0);

    await wranglerDeploy({
      env,
      name: "main",
      config: CONFIG,
      secrets: undefined,
      token: "cf-token",
      accountId: "acct-1",
      wranglerPath: wrangler.path,
    });

    const record = JSON.parse(await readFile(wrangler.recordPath, "utf8")) as { argv: string[] };
    expect(record.argv).not.toContain("--secrets-file");
  });
});
