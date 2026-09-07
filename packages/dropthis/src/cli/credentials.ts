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
 *
 * That precedence is written ONCE, in `selectInstance` (issue #32): it answers
 * "which instance would this run use, and why" with a name or a url and never
 * a key, so a command that only lists can ask it too. `resolveCredentials` is
 * that answer plus the key lookup. A second copy of the order — in a listing,
 * in a connect command — is how a listing comes to mark a default the next
 * command refuses.
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

/**
 * Why no instance was selected. `no-instances` is "nothing is configured at
 * all" — the exit-4 case for a command. `ambiguous` is "several are, and none
 * of them is the one": a command must be told which, a listing marks none.
 */
export type NoInstanceReason = "no-instances" | "ambiguous";

/**
 * Which instance this run uses, with no key in it. `url` rides the `env`
 * answer because the env pair has no name to look up later; a `file` answer
 * carries only the name, and the key stays in the file until a caller that
 * needs one asks `resolveCredentials`.
 */
export type Selection =
  | { kind: "env"; url: string }
  | { kind: "file"; name: string }
  | { kind: "none"; reason: NoInstanceReason; known: string[] };

export function selectInstance(input: ResolveInput): Selection {
  const url = input.env.DROPTHIS_URL;
  const key = input.env.DROPTHIS_KEY;
  const hasUrl = typeof url === "string" && url.length > 0;
  const hasKey = typeof key === "string" && key.length > 0;

  if (hasUrl && hasKey) return { kind: "env", url: trimUrl(url!) };
  if (hasUrl !== hasKey) {
    // Half a pair is an error everywhere, before the file is even read: the
    // operator meant the environment to win, and it cannot.
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
    if (file?.instances[wanted] === undefined) {
      throw new CliError(
        "INVALID_INPUT",
        known.length === 0
          ? `No instance named ${JSON.stringify(wanted)}: ${instancesPath(input.env)} has none.`
          : `No instance named ${JSON.stringify(wanted)}; known: ${known.join(", ")}.`,
        "Pass one of the known names to --instance, or set DROPTHIS_URL and DROPTHIS_KEY.",
      );
    }
    return { kind: "file", name: wanted };
  }

  if (file === null || known.length === 0) return { kind: "none", reason: "no-instances", known };

  const name = file.default !== undefined ? file.default : known.length === 1 ? known[0]! : undefined;
  // A `default` naming an instance the file does not hold is not one a command
  // would reach either: it is as ambiguous as naming none.
  if (name === undefined || file.instances[name] === undefined) {
    return { kind: "none", reason: "ambiguous", known };
  }
  return { kind: "file", name };
}

export function resolveCredentials(input: ResolveInput): Credentials {
  const selected = selectInstance(input);

  if (selected.kind === "env") {
    return { url: selected.url, key: input.env.DROPTHIS_KEY!, source: "env" };
  }
  if (selected.kind === "file") {
    const entry = input.file!.instances[selected.name]!;
    return { url: trimUrl(entry.url), key: entry.key, source: "file", instance: selected.name };
  }
  if (selected.reason === "no-instances") {
    throw new CliError(
      "UNAUTHENTICATED",
      "No credentials: DROPTHIS_URL and DROPTHIS_KEY are not set and no instance is configured.",
      NO_CREDENTIALS_REMEDIATION,
    );
  }
  throw new CliError(
    "INVALID_INPUT",
    `Several instances are configured and none is the default; pass --instance <name> (known: ${selected.known.join(", ")}).`,
    "Pass --instance <name> or set DROPTHIS_INSTANCE.",
  );
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}
