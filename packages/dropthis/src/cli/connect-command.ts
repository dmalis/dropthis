/**
 * `dropthis connect --client <client>` and `dropthis auth-header`.
 *
 * The payload is the instance's own (`worker/src/registry/connect.ts`), so the
 * snippet an operator gets from `user add` and the one this command applies
 * are the same text from one source. This module only decides where it goes.
 *
 * The key is in NO snippet and in no argv:
 *   claude-code   `.mcp.json` gets a `headersHelper` that calls this CLI back;
 *                 the key stays in `instances.json` at mode 600.
 *   cursor/codex  the snippet references `DROPTHIS_KEY_<NAME>` and the export
 *                 line is printed for the operator's shell profile.
 *   claude-ai     no file at all: a connector URL and a paste-key message.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { connectFor, keyEnvVar, onboardingMessage } from "../../../worker/src/registry/connect.js";
import type { Connect } from "../../../worker/src/registry/connect.js";
import { resolveCredentials } from "./credentials.js";
import { CliError, EXIT_OK } from "./errors.js";
import { jsonLine } from "./output.js";
import { modeOf, readInstancesFile } from "./run.js";
import type { Globals, RunIo } from "./run.js";

export const CLIENTS = ["claude-code", "cursor", "codex", "claude-ai"] as const;
export type ClientName = (typeof CLIENTS)[number];

export function isClientName(value: unknown): value is ClientName {
  return typeof value === "string" && (CLIENTS as readonly string[]).includes(value);
}

export async function runConnectCommand(client: ClientName, globals: Globals, io: RunIo): Promise<number> {
  const credentials = resolveCredentials({
    env: io.env,
    instance: globals.instance,
    file: await readInstancesFile(io.env),
  });
  const instanceName = credentials.instance ?? "main";
  const connect = connectFor({ canonicalUrl: credentials.url, instanceName, label: "you" });
  const mode = modeOf(globals);

  const applied = client === "claude-code" ? await writeMcpJson(io.cwd, connect) : undefined;
  const document = {
    instance: instanceName,
    client,
    ...(applied === undefined ? {} : { applied_to: applied }),
    ...clientPayload(client, connect, instanceName),
  };

  if (mode !== "plain") {
    io.stdout.write(jsonLine(document));
    return EXIT_OK;
  }
  io.stdout.write(`${plain(client, connect, instanceName, applied)}\n`);
  return EXIT_OK;
}

function clientPayload(client: ClientName, connect: Connect, instanceName: string): Record<string, unknown> {
  switch (client) {
    case "claude-code":
      return { mcp_json: connect.clients.claude_code.mcp_json };
    case "cursor":
      return {
        mcp_json: connect.clients.cursor.mcp_json,
        shell_profile_line: connect.clients.cursor.shell_profile_line,
        key_env_var: keyEnvVar(instanceName),
      };
    case "codex":
      return {
        config_toml: connect.clients.codex.config_toml,
        shell_profile_line: connect.clients.codex.shell_profile_line,
        key_env_var: keyEnvVar(instanceName),
      };
    default:
      return {
        connector_url: connect.clients.claude_ai.connector_url,
        steps: connect.clients.claude_ai.steps,
        message: onboardingMessage(connect, "you"),
      };
  }
}

function plain(
  client: ClientName,
  connect: Connect,
  instanceName: string,
  applied: string | undefined,
): string {
  const payload = clientPayload(client, connect, instanceName);
  switch (client) {
    case "claude-code":
      return `Registered the dropthis MCP server in ${String(applied)}. The key stays in your instances file; the entry calls \`dropthis auth-header --instance ${instanceName}\` for it.`;
    case "cursor":
      return `${String(payload.shell_profile_line)}\n\n${JSON.stringify(payload.mcp_json, null, 2)}`;
    case "codex":
      return `${String(payload.shell_profile_line)}\n\n${String(payload.config_toml)}`;
    default:
      return String(payload.message);
  }
}

/**
 * `.mcp.json` in the working directory — the project-scoped file Claude Code
 * reads. It is merged, never replaced: the file usually already holds other
 * servers, and losing them would be a silent, expensive surprise.
 */
async function writeMcpJson(cwd: string, connect: Connect): Promise<string> {
  const path = join(cwd, ".mcp.json");
  let existing: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    } else {
      throw new CliError(
        "INVALID_INPUT",
        `${path} is not a JSON object.`,
        "Fix or remove the file, then run connect again.",
      );
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    const code = (error as { code?: string }).code;
    if (code !== "ENOENT") {
      throw new CliError(
        "INVALID_INPUT",
        `${path} is not valid JSON.`,
        "Fix or remove the file, then run connect again.",
      );
    }
  }

  const servers = (connect.clients.claude_code.mcp_json as { mcpServers: Record<string, unknown> }).mcpServers;
  const merged = {
    ...existing,
    mcpServers: {
      ...((existing.mcpServers as Record<string, unknown> | undefined) ?? {}),
      ...servers,
    },
  };
  await writeFile(path, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return path;
}

/**
 * `auth-header` — the whole point of `headersHelper`: the key is read at call
 * time from the file, so it is in no config file, no argv and no shell
 * history. It prints one header line and nothing else.
 */
export async function runAuthHeaderCommand(globals: Globals, io: RunIo): Promise<number> {
  let key: string;
  try {
    key = resolveCredentials({
      env: io.env,
      instance: globals.instance,
      file: await readInstancesFile(io.env),
    }).key;
  } catch (error) {
    // An MCP client asking for a header and getting none has an auth problem,
    // whatever the underlying reason: exit 4, as `gh` does.
    throw new CliError(
      "UNAUTHENTICATED",
      error instanceof CliError ? error.message : String(error),
      error instanceof CliError ? error.remediation : undefined,
      false,
    );
  }
  io.stdout.write(`Authorization: Bearer ${key}\n`);
  return EXIT_OK;
}
