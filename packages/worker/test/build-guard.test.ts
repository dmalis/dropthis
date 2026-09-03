import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * The `/_dev` probes may never reach a real instance. The runtime `DEV_ROUTES`
 * gate is the second line; this is the first: the production entry point does
 * not import the module, so the bundle Cloudflare would run cannot contain it.
 */
async function bundleProduction(): Promise<string> {
  const outdir = await mkdtemp(join(tmpdir(), "dropthis-build-guard-"));
  await execFileAsync(
    process.execPath,
    [
      join(repoRoot, "node_modules", "wrangler", "bin", "wrangler.js"),
      "deploy",
      "--dry-run",
      "--outdir",
      outdir,
      "-c",
      join(repoRoot, "packages", "worker", "wrangler.jsonc"),
    ],
    { cwd: repoRoot, env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
  );
  const files = await readdir(outdir);
  const bundles = files.filter((name) => name.endsWith(".js"));
  expect(bundles.length).toBeGreaterThan(0);
  const parts = await Promise.all(bundles.map((name) => readFile(join(outdir, name), "utf8")));
  return parts.join("\n");
}

describe("production bundle", () => {
  it("contains no /_dev route and no dev probe code", async () => {
    const bundle = await bundleProduction();

    expect(bundle).not.toContain("/_dev");
    expect(bundle).not.toContain("/bench/pbkdf2");
    expect(bundle).not.toContain("DEV_ROUTES");
    expect(bundle).not.toContain("r2/burst");

    // The two things the dev build may bend — what time it is and where a
    // write aborts — reach it only through `dev/enabled-hooks.ts`, which the
    // production entry never imports. A production Worker whose clock a header
    // could move would serve an expired drop on request.
    expect(bundle).not.toContain("DEV_CLOCK");
    expect(bundle).not.toContain("DEV-Clock");
    expect(bundle).not.toContain("DEV-Fault");
  }, 120_000);

  it("still contains the product's own routes", async () => {
    const bundle = await bundleProduction();

    // The routes are generated from the registry, so the bundle carries the
    // prefix and each operation's path rather than one joined literal.
    expect(bundle).toContain("/_api/v1");
    expect(bundle).toContain("/health");
    expect(bundle).toContain("/drops");
    expect(bundle).toContain("/users");
  }, 120_000);
});
