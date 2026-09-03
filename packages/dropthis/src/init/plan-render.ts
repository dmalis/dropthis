import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where the Worker source lives, found by walking up from this module until a
 * directory holds `packages/worker/wrangler.jsonc`.
 *
 * A fixed number of `..` is wrong in one of the two places this code runs: it
 * is four levels from `src/init/plan-render.ts` and three from the bundled
 * `dist/cli.cjs`, and the bundle is what an operator runs. Walking up is right
 * in both, and it fails with a sentence instead of building a path that
 * silently points outside the repo (v1 is used from the repo build,
 * `npx ./packages/dropthis`; bundling the built Worker into the package is the
 * first-public-release milestone).
 */
function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 10; up += 1) {
    if (existsSync(join(dir, "packages", "worker", "wrangler.jsonc"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "Cannot find packages/worker/wrangler.jsonc above this CLI. In v1 `init` deploys the Worker from this repository; run it as `npx ./packages/dropthis`.",
  );
}

const repoRoot = findRepoRoot();
const templatePath = join(repoRoot, "packages", "worker", "wrangler.jsonc");
const workerMain = join(repoRoot, "packages", "worker", "src", "index.ts");

/** Strips // and /* *\/ comments that sit outside JSON strings (same as deploy-dev.mjs). */
function stripJsonComments(source: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    const next = source[i + 1];
    if (inLine) {
      if (c === "\n") { inLine = false; out += c; }
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") { inBlock = false; i += 1; }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") { out += next ?? ""; i += 1; }
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === "/" && next === "/") { inLine = true; i += 1; continue; }
    if (c === "/" && next === "*") { inBlock = true; i += 1; continue; }
    out += c;
  }
  return out;
}

export type RenderedWranglerConfig = Record<string, unknown> & {
  name: string;
  main: string;
  r2_buckets: Array<{ binding: string; bucket_name: string }>;
  kv_namespaces: Array<{ binding: string; id: string }>;
};

/**
 * Renders the per-instance wrangler config from the repo's id-less template
 * (`packages/worker/wrangler.jsonc`), same contract as `scripts/deploy-dev.mjs`:
 * bucket by NAME, KV by the reconciled id (an existing namespace cannot be
 * bound by name; id-less auto-provisioning would create a second one).
 */
export async function renderWranglerConfig(
  instanceName: string,
  bucketName: string,
  kvId: string,
): Promise<RenderedWranglerConfig> {
  const template = JSON.parse(stripJsonComments(await readFile(templatePath, "utf8"))) as Record<
    string,
    unknown
  >;
  const rendered = {
    ...template,
    name: `dropthis-${instanceName}`,
    main: workerMain,
    r2_buckets: [{ binding: "BUCKET", bucket_name: bucketName }],
    kv_namespaces: [{ binding: "OAUTH_KV", id: kvId }],
  } as RenderedWranglerConfig & { $schema?: unknown };
  delete rendered.$schema;
  return rendered;
}

export async function writeWranglerConfig(path: string, config: RenderedWranglerConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}
