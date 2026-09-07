/**
 * `dropthis instance list` — what is configured on this machine (issues #30,
 * #31). It is a CLI-only command, like `connect`: it reads the local instances
 * file and never calls an instance. The keys live in that file and nowhere
 * else, so the one thing this command must never print is one.
 *
 * Every `--json` row carries the instance's four addresses, so an operator who
 * has not yet chosen a client still gets them. They come from `connectFor()`
 * in the Worker's registry — the one formula for those URLs, never a second
 * one written here. Plain mode stays `name  url  (default)`: a person reading
 * a terminal asked which instances exist, not for four URLs each.
 *
 * `default` is the instance a command with no `--instance` would use, resolved
 * the way `credentials.ts` resolves it: the env pair beats everything, then the
 * file's `default`, then its only instance. So the answer here is what the next
 * command actually does, not a field copied out of a file.
 */
import { connectFor } from "../../../worker/src/registry/connect.js";
import { EXIT_OK } from "./errors.js";
import { jsonLine } from "./output.js";
import { modeOf, readInstancesFile } from "./run.js";
import type { Globals, RunIo } from "./run.js";

/** The name the env pair is listed under; it is not in any file. */
export const ENV_INSTANCE = "env";

export type InstanceRow = {
  name: string;
  url: string;
  default: boolean;
  mcp_url: string;
  rest_url: string;
  skill_url: string;
  connect_page: string;
};

export type InstanceListReport = { default: string | null; instances: InstanceRow[] };

export const INSTANCE_LIST_SUMMARY =
  "List the instances configured on this machine: name, url, which is the default, and their URLs.";

export const NO_INSTANCES_HINT = "No instances are configured. Run `dropthis init` to create one.";

export async function runInstanceListCommand(globals: Globals, io: RunIo): Promise<number> {
  const file = await readInstancesFile(io.env);
  const named = Object.entries(file?.instances ?? {}).map(([name, entry]) => ({ name, url: entry.url }));

  const url = io.env.DROPTHIS_URL;
  const key = io.env.DROPTHIS_KEY;
  const hasEnvPair = typeof url === "string" && url.length > 0 && typeof key === "string" && key.length > 0;
  if (hasEnvPair) named.push({ name: ENV_INSTANCE, url });

  const fileDefault = file?.default !== undefined ? file.default : named.length === 1 ? named[0]!.name : undefined;
  const selected = hasEnvPair ? ENV_INSTANCE : fileDefault;
  // A `default` naming an instance the file does not hold is not the one a
  // command would reach; it marks nothing rather than a row that is not there.
  const chosen = named.some((row) => row.name === selected) ? selected! : null;

  const sorted = named.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const report: InstanceListReport = {
    default: chosen,
    instances: sorted.map((row) => {
      const connect = connectFor({ canonicalUrl: row.url, instanceName: row.name });
      return {
        name: row.name,
        url: row.url,
        default: row.name === chosen,
        mcp_url: connect.mcp_url,
        rest_url: connect.rest_url,
        skill_url: connect.skill_url,
        connect_page: connect.connect_page,
      };
    }),
  };

  if (modeOf(globals) !== "plain") {
    io.stdout.write(jsonLine(report));
    return EXIT_OK;
  }

  if (report.instances.length === 0) {
    // Nothing to print is not an error: an operator who has not run `init` yet
    // asked a fair question. The answer goes to stderr so stdout stays empty
    // and a pipe counting rows counts none.
    io.stderr.write(`${NO_INSTANCES_HINT}\n`);
    return EXIT_OK;
  }

  const width = Math.max(...report.instances.map((row) => row.name.length));
  for (const row of report.instances) {
    io.stdout.write(`${row.name.padEnd(width)}  ${row.url}${row.default ? "  (default)" : ""}\n`);
  }
  return EXIT_OK;
}
