/**
 * `dropthis init` — the one command that turns a Cloudflare account into a
 * working instance, and `init --check`, the account-level half of `doctor`.
 *
 * It is hand-mounted rather than generated: every other command is an
 * operation on an instance and comes from the registry, while this one runs
 * BEFORE an instance exists and speaks to Cloudflare with the operator's own
 * token (AGENTS.md, "Operation registry": instance lifecycle lives in the CLI
 * only).
 *
 * This module owns credentials, interactivity and output. `init/run-init.ts`
 * owns the account and the instance and never prints anything.
 */
import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import { runAccountChecks } from "../init/account-checks.js";
import { makeClient } from "../init/cloudflare-client.js";
import { resolveCloudflareCredential, TOKEN_PERMISSIONS, TOKEN_URL } from "../init/credential-mode.js";
import { resolveWrangler, wranglerDeploy } from "../init/deploy.js";
import { pinAccount } from "../init/preflight.js";
import { runInit } from "../init/run-init.js";
import type { InitStep, InitWall, RunInitResult } from "../init/run-init.js";
import { readInstancesFile } from "./run.js";
import type { Globals, RunIo } from "./run.js";
import { CliError, EXIT_AUTH, EXIT_FAILURE, EXIT_OK } from "./errors.js";
import { isInteractive } from "./interactive.js";
import { jsonLine } from "./output.js";
import { modeOf } from "./run.js";
import { browserLogin } from "../init/browser-login.js";
import { connectFor } from "../../../worker/src/registry/connect.js";

export type InitInput = {
  name?: string;
  accountId?: string;
  domain?: string;
  dryRun: boolean;
  check: boolean;
  rotateAdminKey: boolean;
};

/** How long the installer waits at a human-only wall before asking again. */
const WALL_POLL_MS = 3_000;

/**
 * The CLI's own test seam, the way `DEV_ROUTES` is the Worker's.
 *
 * `init` proves a deploy by polling the instance's health route and running
 * its `doctor`, both at the URL the ACCOUNT says the Worker is at. A test that
 * points the account API at the local fake has no such hostname, so it also
 * says where the instance really is. Both variables must be set together: with
 * a real `api.cloudflare.com` the override is ignored, so it can never send a
 * real install's proof somewhere else.
 */
function probeOverride(env: Record<string, string | undefined>): string | undefined {
  const base = env.CLOUDFLARE_BASE_URL;
  const probe = env.DROPTHIS_INIT_PROBE_URL;
  if (base === undefined || base.length === 0) return undefined;
  return probe !== undefined && probe.length > 0 ? probe : undefined;
}

export async function runInitCommand(input: InitInput, globals: Globals, io: RunIo): Promise<number> {
  const mode = modeOf(globals);
  const interactive = await isInteractive({
    env: io.env,
    stdin: io.stdin,
    stdout: io.stdout,
    yes: globals.yes,
  });

  const credential = await resolveCloudflareCredential({
    env: io.env,
    interactive,
    ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
    browserLogin: () => browserLogin({ wranglerPath: resolveWrangler(), env: io.env }),
  });
  if (!credential.ok) {
    const error = new CliError(
      credential.exitCode === EXIT_AUTH ? "UNAUTHENTICATED" : "INVALID_INPUT",
      credential.message,
      credential.remediation,
      false,
    );
    if (mode === "plain") {
      io.stderr.write(`dropthis: ${error.code}: ${error.message}\n  ${error.remediation}\n`);
    } else {
      io.stderr.write(jsonLine(error.toObject()));
    }
    return credential.exitCode;
  }

  const name = input.name ?? "main";
  const apiBase = io.env.CLOUDFLARE_BASE_URL;
  const creds = {
    apiToken: credential.token,
    ...(credential.accountId === undefined ? {} : { accountId: credential.accountId }),
    ...(apiBase === undefined || apiBase.length === 0 ? {} : { apiBase }),
  };

  if (mode === "plain") {
    io.stderr.write(`dropthis: using the Cloudflare credential from ${sourceLabel(credential.source)}\n`);
  }

  if (input.check) return await accountCheck(creds, name, input, mode, io);

  // A rerun cannot re-derive the admin key (it is stored hashed), so the one
  // stored for this instance is what `doctor` runs with.
  const stored = (await readInstancesFile(io.env))?.instances[name]?.key;

  const result = await runInit({
    creds,
    ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
    name,
    dryRun: input.dryRun,
    ...(input.domain === undefined ? {} : { domain: input.domain }),
    rotateAdminKey: input.rotateAdminKey,
    ...(stored === undefined ? {} : { existingKey: stored }),
    env: io.env,
    onStep: (step) => {
      if (mode === "jsonl") io.stdout.write(jsonLine(stepEvent(step)));
      else if (mode === "plain") io.stderr.write(`${stepLine(step)}\n`);
    },
    ...(interactive ? { onWall: (wall: InitWall) => waitAtWall(wall, io.stderr) } : {}),
    ...pollOptions(io.env),
    deploy: async (config, secrets) => {
      await wranglerDeploy({
        env: io.env,
        name,
        config,
        secrets,
        token: credential.token,
        accountId: credential.accountId ?? "",
        cwd: io.cwd,
        log: io.stderr,
        ...(io.env.DROPTHIS_WRANGLER === undefined ? {} : { wranglerPath: io.env.DROPTHIS_WRANGLER }),
      });
      const override = probeOverride(io.env);
      return override === undefined ? undefined : { url: override };
    },
  });

  render(result, mode, io);
  return result.ok ? EXIT_OK : EXIT_FAILURE;
}

/** `--check`: the questions only the Cloudflare token can ask (decision #29). */
async function accountCheck(
  creds: Parameters<typeof makeClient>[0],
  name: string,
  input: InitInput,
  mode: ReturnType<typeof modeOf>,
  io: RunIo,
): Promise<number> {
  const client = makeClient(creds);
  const pinned = await pinAccount(client, creds.accountId);
  if (!pinned.ok) {
    throw new CliError(
      "INVALID_INPUT",
      `Cannot pin a Cloudflare account: ${pinned.code}.`,
      "Pass --account-id <id>, or use a token scoped to one account.",
    );
  }
  const report = await runAccountChecks(client, pinned.accountId, {
    name,
    ...(input.domain === undefined ? {} : { domain: input.domain }),
  });
  if (mode === "plain") {
    for (const check of report.checks) {
      io.stderr.write(`${check.status.padEnd(5)} ${check.id}: ${check.evidence}\n`);
      if (check.remediation !== undefined) io.stderr.write(`      ${check.remediation}\n`);
    }
    io.stdout.write(`${report.ok ? "ok" : "not ok"}\n`);
  } else {
    io.stdout.write(jsonLine(report));
  }
  return report.ok ? EXIT_OK : EXIT_FAILURE;
}

/** snake_case on the wire, as every other surface (AGENTS.md, "Responses"). */
const stepEvent = (step: InitStep) => ({
  step: step.id,
  status: step.status,
  ...(step.detail === undefined ? {} : { detail: step.detail }),
});

const stepLine = (step: InitStep): string =>
  `${step.status.padEnd(12)} ${step.id}${step.detail === undefined ? "" : `: ${step.detail}`}`;

function initDocument(result: RunInitResult): Record<string, unknown> {
  return {
    ok: result.ok,
    name: result.name,
    worker: result.worker,
    bucket: result.bucket,
    kv_namespace: result.kvNamespace,
    ...(result.canonicalUrl === undefined ? {} : { canonical_url: result.canonicalUrl }),
    ...(result.aliasOrigins === undefined ? {} : { alias_origins: result.aliasOrigins }),
    ...(result.domain === undefined ? {} : { domain: result.domain }),
    ...(result.adminKeyStatus === undefined ? {} : { admin_key_status: result.adminKeyStatus }),
    // Present ONLY when this run minted or rotated it. A rerun never re-prints
    // a key: it is stored hashed and cannot be re-derived.
    ...(result.adminKey === undefined ? {} : { admin_key: result.adminKey }),
    steps: result.steps.map(stepEvent),
    ...(result.doctor === undefined ? {} : { doctor: result.doctor }),
    ...(result.instancesFile === undefined ? {} : { instances_file: result.instancesFile }),
    ...(result.canonicalUrl === undefined
      ? {}
      : { connect: connectFor({ canonicalUrl: result.canonicalUrl, instanceName: result.name, label: "admin" }) }),
  };
}

function render(result: RunInitResult, mode: ReturnType<typeof modeOf>, io: RunIo): void {
  const document = initDocument(result);
  if (mode !== "plain") {
    io.stdout.write(jsonLine(document));
    return;
  }

  if (result.adminKey !== undefined) {
    io.stderr.write(
      `\nadmin key (shown once, store it now): ${result.adminKey}\n` +
        `It is saved to ${result.instancesFile ?? "no instances.json"}.\n`,
    );
  } else if (result.adminKeyStatus === "existing") {
    io.stderr.write("\nadmin key: unchanged (it is stored hashed and cannot be re-printed).\n");
  }
  if (result.canonicalUrl !== undefined) {
    io.stderr.write(
      `\nConnect an agent: dropthis connect --instance ${result.name} --client claude-code\n` +
        `This instance's skill: ${result.canonicalUrl}/_skill.md\n` +
        `A second instance needs an explicit name: dropthis init --name <other>\n`,
    );
    io.stdout.write(`${result.canonicalUrl}\n`);
  }
}

/** The health poll's budget; a test shortens it so nothing waits on a deadline. */
function pollOptions(env: Record<string, string | undefined>): { poll?: { timeoutMs: number; intervalMs: number } } {
  const raw = env.DROPTHIS_INIT_POLL_MS;
  if (raw === undefined || !/^\d+$/.test(raw)) return {};
  const intervalMs = Number(raw);
  return { poll: { intervalMs, timeoutMs: Math.max(intervalMs * 20, 1_000) } };
}

const sourceLabel = (source: "env" | "browser-login"): string =>
  source === "env" ? "CLOUDFLARE_API_TOKEN" : "the browser login";

/**
 * A wall only a person can clear. The installer opens the page and waits,
 * rather than printing a paragraph and quitting (decision #67).
 */
async function waitAtWall(wall: InitWall, stderr: Writable): Promise<"retry" | "stop"> {
  stderr.write(
    `\nThis needs you in a browser: ${wall.url}\n` +
      `Opening it now; this will keep checking. Press Ctrl-C to stop.\n`,
  );
  openInBrowser(wall.url);
  await new Promise((resolve) => setTimeout(resolve, WALL_POLL_MS));
  return "retry";
}

/**
 * Best effort, and deliberately fire-and-forget: the URL is already on screen,
 * so a machine with no opener loses nothing. Never `shell: true` — the URL
 * would then be a shell string.
 */
function openInBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
  try {
    spawn(command, [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    // Nothing to do: the operator has the URL.
  }
}

export { TOKEN_PERMISSIONS, TOKEN_URL };
