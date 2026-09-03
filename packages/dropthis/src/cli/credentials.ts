/**
 * Which instance, and with which key (AGENTS.md, "CLI conventions"):
 *
 *   DROPTHIS_URL + DROPTHIS_KEY      the env pair, beats everything (CI, n8n)
 *   --instance <name>                selects from ~/.config/dropthis/instances.json
 *   DROPTHIS_INSTANCE                the same, from the environment
 *   the file's default               else its only instance
 *
 * The key is never a flag: flags are visible in `ps` and shell history. There
 * is no fourth source and no merging — a run either uses the env pair or one
 * named instance from the file.
 */
import { join } from "node:path";
import { CliError } from "./errors.js";

export type Env = Record<string, string | undefined>;

export type InstanceEntry = { url: string; key: string };

/** `~/.config/dropthis/instances.json`, as `init` writes it. */
export type InstancesFile = {
  default?: string;
  instances: Record<string, InstanceEntry>;
};

export type Credentials = {
  url: string;
  key: string;
  source: "env" | "file";
  instance?: string;
};

export type ResolveInput = {
  env: Env;
  instance?: string | undefined;
  /** The parsed file, or `null` when there is none. */
  file: InstancesFile | null;
};

export const NO_CREDENTIALS_REMEDIATION =
  "Set DROPTHIS_URL and DROPTHIS_KEY, or run `dropthis init` and select an instance with --instance.";

const trimUrl = (url: string) => url.replace(/\/+$/, "");

export function instancesPath(env: Env): string {
  const configHome =
    env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME.length > 0
      ? env.XDG_CONFIG_HOME
      : join(env.HOME ?? "", ".config");
  return join(configHome, "dropthis", "instances.json");
}

export function resolveCredentials(input: ResolveInput): Credentials {
  const url = input.env.DROPTHIS_URL;
  const key = input.env.DROPTHIS_KEY;
  const hasUrl = typeof url === "string" && url.length > 0;
  const hasKey = typeof key === "string" && key.length > 0;

  if (hasUrl && hasKey) return { url: trimUrl(url), key, source: "env" };
  if (hasUrl !== hasKey) {
    throw new CliError(
      "INVALID_INPUT",
      `${hasUrl ? "DROPTHIS_KEY" : "DROPTHIS_URL"} is not set; the environment pair needs both DROPTHIS_URL and DROPTHIS_KEY.`,
      "Set both variables, or unset both and use --instance.",
    );
  }

  const file = input.file;
  const known = file === null ? [] : Object.keys(file.instances).sort();
  const wanted = input.instance ?? emptyToUndefined(input.env.DROPTHIS_INSTANCE);

  if (wanted !== undefined) {
    const entry = file?.instances[wanted];
    if (entry === undefined) {
      throw new CliError(
        "INVALID_INPUT",
        known.length === 0
          ? `No instance named ${JSON.stringify(wanted)}: ${instancesPath(input.env)} has none.`
          : `No instance named ${JSON.stringify(wanted)}; known: ${known.join(", ")}.`,
        "Pass one of the known names to --instance, or set DROPTHIS_URL and DROPTHIS_KEY.",
      );
    }
    return { url: trimUrl(entry.url), key: entry.key, source: "file", instance: wanted };
  }

  if (file === null || known.length === 0) {
    throw new CliError(
      "UNAUTHENTICATED",
      "No credentials: DROPTHIS_URL and DROPTHIS_KEY are not set and no instance is configured.",
      NO_CREDENTIALS_REMEDIATION,
    );
  }

  const name = file.default !== undefined ? file.default : known.length === 1 ? known[0]! : undefined;
  const entry = name === undefined ? undefined : file.instances[name];
  if (name === undefined || entry === undefined) {
    throw new CliError(
      "INVALID_INPUT",
      `Several instances are configured and none is the default; pass --instance <name> (known: ${known.join(", ")}).`,
      "Pass --instance <name> or set DROPTHIS_INSTANCE.",
    );
  }
  return { url: trimUrl(entry.url), key: entry.key, source: "file", instance: name };
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}
