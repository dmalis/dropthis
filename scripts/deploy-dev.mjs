#!/usr/bin/env node
/**
 * Deploys the dev Worker to the operator's own Cloudflare account.
 *
 * It reconciles the dev bucket and KV namespace BY NAME through the official
 * Cloudflare SDK (ids come from JSON, never from wrangler's stdout), renders a
 * per-instance wrangler config with those ids filled in, and deploys from it.
 * Rerunning is safe: an existing resource is reused, never duplicated.
 *
 *   node scripts/deploy-dev.mjs [--dry-run] [--no-deploy]
 *                               [--api-base <url>] [--config-out <path>]
 *
 *   --dry-run     read-only: list and render, create nothing, deploy nothing
 *   --no-deploy   reconcile (creating what is missing) and render, but do not deploy
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Cloudflare from "cloudflare";

const INSTANCE = "dev";
const WORKER_NAME = `dropthis-${INSTANCE}`;
const BUCKET_NAME = `dropthis-${INSTANCE}-drops`;
const KV_TITLE = `dropthis-${INSTANCE}-oauth`;
/** Cloudflare's own page sizes; the reconcile pages until a page is short. */
const R2_PAGE_SIZE = 100;
const KV_PAGE_SIZE = 100;

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const templatePath = join(repoRoot, "packages", "worker", "wrangler.jsonc");
const workerMain = join(repoRoot, "packages", "worker", "src", "index.ts");
const defaultConfigOut = join(repoRoot, ".dev", "wrangler.dev.jsonc");

function parseArgs(argv) {
  const args = { dryRun: false, deploy: true, apiBase: undefined, configOut: defaultConfigOut };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--no-deploy") args.deploy = false;
    else if (arg === "--api-base") args.apiBase = argv[++i];
    else if (arg === "--config-out") args.configOut = argv[++i];
    else die(`Unknown option: ${arg}`);
  }
  if (args.dryRun) args.deploy = false;
  return args;
}

function die(message) {
  process.stderr.write(`deploy-dev: ${message}\n`);
  process.exit(1);
}

function requireEnv(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) {
    die(
      `${name} is not set. Source the dev credentials first: ` +
        `\`source ~/.config/dropthis/dev.env\` (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID).`,
    );
  }
  return value;
}

/** Strips // and /* *\/ comments that sit outside JSON strings. */
function stripJsonComments(source) {
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

async function findBucket(client, accountId, name) {
  let startAfter;
  for (;;) {
    const params = { account_id: accountId, per_page: R2_PAGE_SIZE, order: "name", direction: "asc" };
    if (startAfter !== undefined) params.start_after = startAfter;
    const page = await client.r2.buckets.list(params);
    const buckets = page.buckets ?? [];
    // The server may return fewer than `per_page`, so an empty page — not a
    // short one — is the only reliable end of the list.
    if (buckets.length === 0) return undefined;
    const hit = buckets.find((bucket) => bucket.name === name);
    if (hit) return hit;
    startAfter = buckets[buckets.length - 1].name;
  }
}

async function findNamespace(client, accountId, title) {
  for await (const namespace of client.kv.namespaces.list({
    account_id: accountId,
    per_page: KV_PAGE_SIZE,
  })) {
    if (namespace.title === title) return namespace;
  }
  return undefined;
}

async function renderConfig(configOut, kvId) {
  const template = JSON.parse(stripJsonComments(await readFile(templatePath, "utf8")));
  const rendered = {
    ...template,
    name: WORKER_NAME,
    main: workerMain,
    r2_buckets: [{ binding: "BUCKET", bucket_name: BUCKET_NAME }],
    kv_namespaces: [{ binding: "OAUTH_KV", id: kvId }],
  };
  delete rendered.$schema;
  await mkdir(dirname(configOut), { recursive: true });
  await writeFile(configOut, `${JSON.stringify(rendered, null, 2)}\n`, "utf8");
  return rendered;
}

function runWrangler(configOut, token, accountId) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(repoRoot, "node_modules", "wrangler", "bin", "wrangler.js"), "deploy", "-c", configOut],
      {
        cwd: repoRoot,
        stdio: ["ignore", "inherit", "inherit"],
        env: {
          ...process.env,
          CLOUDFLARE_API_TOKEN: token,
          CLOUDFLARE_ACCOUNT_ID: accountId,
          WRANGLER_SEND_METRICS: "false",
        },
      },
    );
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`wrangler deploy exited ${code}`)),
    );
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = requireEnv("CLOUDFLARE_API_TOKEN");
  const accountId = requireEnv("CLOUDFLARE_ACCOUNT_ID");

  const client = new Cloudflare({
    apiToken: token,
    ...(args.apiBase ? { baseURL: args.apiBase } : {}),
  });

  const log = (line) => process.stderr.write(`deploy-dev: ${line}\n`);

  try {
    const verified = await client.user.tokens.verify();
    if (verified.status !== "active") die(`API token is ${verified.status}, not active.`);
  } catch (error) {
    die(`API token verification failed: ${error.message}`);
  }

  let bucket = await findBucket(client, accountId, BUCKET_NAME);
  if (bucket) log(`bucket ${BUCKET_NAME}: exists`);
  else if (args.dryRun) log(`bucket ${BUCKET_NAME}: would create`);
  else {
    bucket = await client.r2.buckets.create({ account_id: accountId, name: BUCKET_NAME });
    log(`bucket ${BUCKET_NAME}: created`);
  }

  let namespace = await findNamespace(client, accountId, KV_TITLE);
  if (namespace) log(`kv ${KV_TITLE}: exists (${namespace.id})`);
  else if (args.dryRun) log(`kv ${KV_TITLE}: would create`);
  else {
    namespace = await client.kv.namespaces.create({ account_id: accountId, title: KV_TITLE });
    log(`kv ${KV_TITLE}: created (${namespace.id})`);
  }

  const { subdomain } = await client.workers.subdomains.get({ account_id: accountId });
  const url = `https://${WORKER_NAME}.${subdomain}.workers.dev`;

  await renderConfig(args.configOut, namespace ? namespace.id : "pending-create");
  log(`rendered ${args.configOut}`);

  if (args.deploy) {
    await runWrangler(args.configOut, token, accountId);
    log("deployed");
  }

  process.stdout.write(`${url}\n`);
}

await main();
