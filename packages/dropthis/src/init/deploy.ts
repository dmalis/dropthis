/**
 * The real deploy: `wrangler deploy -c <rendered> [--secrets-file <file>]`,
 * the same invocation `scripts/deploy-dev.mjs` makes.
 *
 * Three rules, all from AGENTS.md ("Installer principles"):
 *
 *   - wrangler is never reimplemented and its stdout is never parsed. It gets
 *     a config file and exits; ids and URLs come from the Cloudflare API.
 *   - whichever credential this run pinned is put into wrangler's environment,
 *     so a deploy cannot land in a different account than the one preflight
 *     approved — an ambient `wrangler login` in the shell cannot win.
 *   - the rendered config and the secrets file live under the operator's
 *     config home, never in the working directory: the cwd is a repo, and a
 *     file holding `HMAC_SECRET` must not be one `git add .` away.
 *
 * The secrets file is deleted whatever happens. It exists only for the
 * seconds wrangler is reading it.
 */
import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Env } from "../cli/credentials.js";
import { instancesPath } from "../cli/credentials.js";
import { normalizeInstanceName } from "./instance-name.js";
import type { RenderedWranglerConfig } from "./plan-render.js";

export type DeployOptions = {
  env: Env;
  /** The instance name; its directory holds the rendered config. */
  name: string;
  config: RenderedWranglerConfig;
  /** Absent when the Worker already holds the secret (see worker-secrets.ts). */
  secrets: Record<string, string> | undefined;
  token: string;
  accountId: string;
  /** Tests point this at a stub; production resolves the bundled wrangler. */
  wranglerPath?: string;
  cwd?: string;
  /**
   * Where wrangler's own chatter goes. NEVER our stdout: `--json` is exactly
   * one document there, and wrangler prints a banner and a table on every
   * deploy. Defaults to stderr, which is where everything but the result goes.
   */
  log?: Writable;
};

/**
 * `~/.config/dropthis/<name>/` — beside `instances.json`, never in the cwd.
 *
 * The name is normalised here as well as at the command: this function turns a
 * string into a path, and a caller that has not normalised would write outside
 * the config home.
 */
export function instanceConfigDir(env: Env, name: string): string {
  return join(instancesPath(env), "..", normalizeInstanceName(name));
}

export async function wranglerDeploy(options: DeployOptions): Promise<void> {
  // An empty account id is worse than none: wrangler then picks an account on
  // its own, which is exactly the wrong-account deploy the pin exists to stop.
  if (options.accountId.length === 0) {
    throw new Error("wranglerDeploy needs the account id preflight pinned; it was empty.");
  }
  const dir = instanceConfigDir(options.env, options.name);
  await mkdir(dir, { recursive: true });

  const configPath = join(dir, "wrangler.json");
  await writeFile(configPath, `${JSON.stringify(options.config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });

  const secretsPath = join(dir, "secrets.deploy.json");
  const args = ["deploy", "-c", configPath];
  if (options.secrets !== undefined) {
    await writeFile(secretsPath, `${JSON.stringify(options.secrets)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    args.push("--secrets-file", secretsPath);
  }

  try {
    await run(resolveWrangler(options.wranglerPath), args, {
      cwd: options.cwd ?? process.cwd(),
      log: options.log ?? process.stderr,
      env: {
        ...process.env,
        CLOUDFLARE_API_TOKEN: options.token,
        CLOUDFLARE_ACCOUNT_ID: options.accountId,
        WRANGLER_SEND_METRICS: "false",
      },
    });
  } finally {
    await rm(secretsPath, { force: true });
  }
}

/**
 * The bundled wrangler, resolved through Node rather than a path relative to
 * this file: the CLI runs both from `dist/cli.cjs` in an installed package and
 * from source in the repo, and only one of those has a predictable layout.
 *
 * `wrangler/package.json` is the resolvable anchor — wrangler's `exports` map
 * publishes it and hides `./bin/*`, so the bin is reached from the package
 * directory and not through a subpath import that Node refuses.
 */
export function resolveWrangler(explicit?: string): string {
  if (explicit !== undefined) return explicit;
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("wrangler/package.json")), "bin", "wrangler.js");
}

function run(
  script: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; log: Writable },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: options.cwd,
      env: options.env,
      // wrangler talks to the operator, not to us. Its stdout is REDIRECTED to
      // ours-for-humans (stderr): inheriting it put a banner in front of the
      // `--json` document and broke "exactly one JSON document on stdout".
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.pipe(options.log, { end: false });
    child.stderr.pipe(options.log, { end: false });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`wrangler deploy exited ${String(code)}`)),
    );
  });
}
