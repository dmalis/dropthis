/**
 * Signing a human in to Cloudflare through the browser (decision #67).
 *
 * `wrangler login` runs the OAuth dance and stores the token in wrangler's own
 * config; the installer then reads it and uses it like any other token, so
 * everything downstream — preflight, reconcile, the R2 API writes — has one
 * code path. Nothing here parses wrangler's human output: the token comes
 * from the file wrangler wrote, and the account list comes from the API.
 *
 * This path has no automated test: it opens a browser and waits for a person
 * to click Allow. It is exercised in the manual smoke, and every DECISION it
 * feeds (env token wins, one account or stop, exit 4 when nobody is there) is
 * tested against an injected login in `credential-mode.test.ts`.
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import Cloudflare from "cloudflare";
import type { LoginOutcome } from "./credential-mode.js";

export type BrowserLoginOptions = {
  wranglerPath: string;
  env: Record<string, string | undefined>;
};

export async function browserLogin(options: BrowserLoginOptions): Promise<LoginOutcome> {
  const code = await run(options.wranglerPath, ["login"], options.env);
  if (code !== 0) return { ok: false, detail: `wrangler login exited ${String(code)}` };

  const token = await readWranglerToken(options.env);
  if (token === undefined) {
    return { ok: false, detail: "wrangler reported a login but stored no OAuth token." };
  }

  const client = new Cloudflare({
    apiToken: token,
    ...(options.env.CLOUDFLARE_BASE_URL ? { baseURL: options.env.CLOUDFLARE_BASE_URL } : {}),
  });
  const accounts: Array<{ id: string; name: string }> = [];
  try {
    for await (const account of client.accounts.list()) accounts.push({ id: account.id, name: account.name });
  } catch (error) {
    return { ok: false, detail: `the login's token could not list accounts: ${message(error)}` };
  }
  return { ok: true, token, accounts };
}

/**
 * Wrangler's own config file, in the location its docs give. `XDG_CONFIG_HOME`
 * wins where it is set, as it does everywhere else in this CLI.
 */
async function readWranglerToken(env: Record<string, string | undefined>): Promise<string | undefined> {
  const configHome =
    env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME.length > 0
      ? env.XDG_CONFIG_HOME
      : join(env.HOME ?? "", ".config");
  const path = join(configHome, ".wrangler", "config", "default.toml");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  const matched = /^\s*oauth_token\s*=\s*"([^"]+)"/m.exec(text);
  return matched?.[1];
}

function run(script: string, args: string[], env: Record<string, string | undefined>): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, ...env, WRANGLER_SEND_METRICS: "false" },
      // The login is a conversation with the operator, on stderr; stdout stays
      // the result channel.
      stdio: ["inherit", "inherit", "inherit"],
    });
    child.on("error", () => resolve(-1));
    child.on("exit", (code) => resolve(code ?? -1));
  });
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
