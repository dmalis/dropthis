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
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Cloudflare from "cloudflare";

/**
 * The instance this run deploys. It defaults to `dev`, and `--instance <name>`
 * gives a second one its own Worker, bucket and KV namespace — every resource
 * is derived from the name, exactly as `init --name` derives them. Two people
 * working on the same repo at the same time each need their own seam: one
 * shared dev Worker means one agent's deploy silently answers the other's
 * contract run, and one shared bucket means one run's reset wipes the other's.
 */
const DEFAULT_INSTANCE = "dev";
/** Cloudflare's own page sizes; the reconcile pages until a page is short. */
const R2_PAGE_SIZE = 100;
const KV_PAGE_SIZE = 100;

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const templatePath = join(repoRoot, "packages", "worker", "wrangler.jsonc");
/**
 * The dev build, and only the dev build, mounts the `/_dev` probes seam 1 uses
 * to prove remote R2's behaviour. `src/index.ts` — the production entry — never
 * imports that module.
 */
const workerMain = join(repoRoot, "packages", "worker", "src", "dev-entry.ts");
const namesFor = (instance) => ({
  instance,
  worker: `dropthis-${instance}`,
  bucket: `dropthis-${instance}-drops`,
  kv: `dropthis-${instance}-oauth`,
  // The default instance keeps the paths it has always used. Moving them would
  // mint a fresh `HMAC_SECRET` for an instance that already has one, and every
  // unlock cookie signed with the old one would stop verifying.
  configOut:
    instance === DEFAULT_INSTANCE
      ? join(repoRoot, ".dev", "wrangler.dev.jsonc")
      : join(repoRoot, ".dev", `wrangler.${instance}.jsonc`),
  secretsOut:
    instance === DEFAULT_INSTANCE
      ? join(repoRoot, ".dev", "secrets.json")
      : join(repoRoot, ".dev", `secrets.${instance}.json`),
});

function parseArgs(argv) {
  const args = {
    dryRun: false,
    deploy: true,
    apiBase: undefined,
    instance: process.env.DROPTHIS_DEV_INSTANCE || DEFAULT_INSTANCE,
    configOut: undefined,
    secretsOut: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--no-deploy") args.deploy = false;
    else if (arg === "--api-base") args.apiBase = argv[++i];
    else if (arg === "--instance") args.instance = argv[++i];
    else if (arg === "--config-out") args.configOut = argv[++i];
    else if (arg === "--secrets-out") args.secretsOut = argv[++i];
    else die(`Unknown option: ${arg}`);
  }
  if (typeof args.instance !== "string" || !/^[a-z0-9][a-z0-9-]{1,29}$/.test(args.instance)) {
    die(`--instance must be 2-30 characters of a-z, 0-9 and -; got ${String(args.instance)}`);
  }
  const names = namesFor(args.instance);
  args.names = names;
  args.configOut ??= names.configOut;
  args.secretsOut ??= names.secretsOut;
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

/**
 * `HMAC_SECRET` is minted once and never re-minted: unlock cookies and signed
 * upload URLs are HMACs over it, so rotating it on every deploy would silently
 * invalidate them. The file holds the only copy and is gitignored; nothing
 * prints it.
 */
async function ensureSecrets(secretsOut) {
  try {
    const existing = JSON.parse(await readFile(secretsOut, "utf8"));
    if (typeof existing.HMAC_SECRET === "string" && existing.HMAC_SECRET.length > 0) {
      return { secrets: existing, minted: false };
    }
  } catch {
    // No file yet, or an unreadable one: mint below.
  }
  const secrets = { HMAC_SECRET: randomBytes(32).toString("base64url") };
  await mkdir(dirname(secretsOut), { recursive: true });
  await writeFile(secretsOut, `${JSON.stringify(secrets, null, 2)}\n`, "utf8", { mode: 0o600 });
  return { secrets, minted: true };
}

async function renderConfig(names, configOut, kvId) {
  const template = JSON.parse(stripJsonComments(await readFile(templatePath, "utf8")));
  const rendered = {
    ...template,
    name: names.worker,
    main: workerMain,
    vars: { DEV_ROUTES: "1" },
    r2_buckets: [{ binding: "BUCKET", bucket_name: names.bucket }],
    kv_namespaces: [{ binding: "OAUTH_KV", id: kvId }],
  };
  delete rendered.$schema;
  // A dev instance drives the cron through `POST /_dev/cron`, so it needs no
  // trigger — and the Free plan allows five cron triggers PER ACCOUNT, which
  // throwaway dev Workers must not spend.
  delete rendered.triggers;
  await mkdir(dirname(configOut), { recursive: true });
  await writeFile(configOut, `${JSON.stringify(rendered, null, 2)}\n`, "utf8");
  return rendered;
}

function runWrangler(configOut, secretsOut, token, accountId) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        join(repoRoot, "node_modules", "wrangler", "bin", "wrangler.js"),
        "deploy",
        "-c",
        configOut,
        "--secrets-file",
        secretsOut,
      ],
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

  let bucket = await findBucket(client, accountId, args.names.bucket);
  if (bucket) log(`bucket ${args.names.bucket}: exists`);
  else if (args.dryRun) log(`bucket ${args.names.bucket}: would create`);
  else {
    bucket = await client.r2.buckets.create({ account_id: accountId, name: args.names.bucket });
    log(`bucket ${args.names.bucket}: created`);
  }

  let namespace = await findNamespace(client, accountId, args.names.kv);
  if (namespace) log(`kv ${args.names.kv}: exists (${namespace.id})`);
  else if (args.dryRun) log(`kv ${args.names.kv}: would create`);
  else {
    namespace = await client.kv.namespaces.create({ account_id: accountId, title: args.names.kv });
    log(`kv ${args.names.kv}: created (${namespace.id})`);
  }

  const { subdomain } = await client.workers.subdomains.get({ account_id: accountId });
  const url = `https://${args.names.worker}.${subdomain}.workers.dev`;

  await renderConfig(args.names, args.configOut, namespace ? namespace.id : "pending-create");
  log(`rendered ${args.configOut}`);

  const { minted } = await ensureSecrets(args.secretsOut);
  log(`HMAC_SECRET: ${minted ? "minted" : "reused"} (${args.secretsOut})`);

  if (args.deploy) {
    await runWrangler(args.configOut, args.secretsOut, token, accountId);
    log("deployed");
  }

  process.stdout.write(`${url}\n`);
}

await main();
