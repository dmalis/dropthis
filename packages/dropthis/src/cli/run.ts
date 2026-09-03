/**
 * Running one command: credentials → input from arguments and flags → the
 * call (or the file transfer, or the paged scan) → the rendered result.
 *
 * Everything operation-specific here is the handful of things a shell cannot
 * express as a body: a target may be a URL, files come from disk, a scan is
 * followed to its end, a destructive command asks first when someone is
 * there to answer.
 */
import { readFile } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";
import { resolveTarget, TargetError } from "../../../worker/src/domain/target.js";
import { operation } from "../../../worker/src/registry/index.js";
import type { Operation } from "../../../worker/src/registry/index.js";
import { ApiClient } from "./client.js";
import { instancesPath, resolveCredentials } from "./credentials.js";
import type { Env, InstancesFile } from "./credentials.js";
import { CliError } from "./errors.js";
import { collectFiles } from "./files.js";
import { confirm, isInteractive } from "./interactive.js";
import { jsonLine, renderResult } from "./output.js";
import type { Mode } from "./output.js";
import { sendFiles } from "./send.js";
import { coerceFlag, GENERATE } from "./surface.js";
import type { CommandSpec } from "./surface.js";

export type Globals = {
  json: boolean;
  jsonl: boolean;
  instance?: string | undefined;
  yes: boolean;
};

export type Invocation = {
  spec: CommandSpec;
  /** Positional values in `spec.args` order; a variadic one is an array. */
  args: unknown[];
  /** Flag values by field name, as commander parsed them. */
  flags: Record<string, unknown>;
  globals: Globals;
};

export type RunIo = {
  env: Env;
  cwd: string;
  stdin: Readable & { isTTY?: boolean };
  stdout: Writable & { isTTY?: boolean };
  stderr: Writable;
};

/** Every byte of stdin, for the one thing that may never ride argv. */
async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

export const modeOf = (globals: Globals): Mode => (globals.jsonl ? "jsonl" : globals.json ? "json" : "plain");

export async function runCommand(invocation: Invocation, io: RunIo): Promise<void> {
  const { spec, globals } = invocation;
  const mode = modeOf(globals);

  const credentials = resolveCredentials({
    env: io.env,
    instance: globals.instance,
    file: await readInstancesFile(io.env),
  });
  const client = new ApiClient({ url: credentials.url, key: credentials.key });

  let op: Operation<never> = spec.op;
  const input: Record<string, unknown> = {};
  let files: Awaited<ReturnType<typeof collectFiles>> | undefined;

  for (const [index, arg] of spec.args.entries()) {
    const raw = invocation.args[index];
    if (arg.kind === "files") {
      const paths = (raw ?? []) as string[];
      if (paths.length > 0) files = await collectFiles(paths, io.cwd);
      continue;
    }
    if (raw === undefined) continue;
    if (arg.kind === "target") {
      input[arg.field] = toSlug(String(raw), credentials.url);
    } else if (arg.kind === "json") {
      Object.assign(input, parseJsonArgument(String(raw), arg.name));
    } else {
      input[arg.field] = raw;
    }
  }

  for (const flag of spec.flags) {
    const raw = invocation.flags[flag.field];
    if (raw === undefined) continue;
    if (flag.field === "list" && spec.op.name === "doctor") {
      if (raw === true) op = operation("doctor.checks");
      continue;
    }
    if (flag.field.endsWith("_stdin")) continue; // handled with its secret below
    if (flag.secret === true && raw !== false && raw !== GENERATE) {
      throw new CliError(
        "INVALID_INPUT",
        `--${flag.flag} takes only "${GENERATE}" on the command line.`,
        `A chosen ${flag.field} on argv is in your shell history and in \`ps\`. Send it on stdin with --${flag.flag}-stdin instead.`,
      );
    }
    input[flag.field] = raw === false && flag.nullable ? null : coerceFlag(flag, raw);
  }

  // A secret read from stdin, after the loop so it wins over nothing and
  // collides with an explicit value rather than silently replacing it.
  for (const flag of spec.flags.filter((f) => f.secret === true)) {
    if (invocation.flags[`${flag.field}_stdin`] !== true) continue;
    if (invocation.flags[flag.field] !== undefined) {
      throw new CliError(
        "INVALID_INPUT",
        `--${flag.flag} and --${flag.flag}-stdin are two ways to say the same thing.`,
        `Send the ${flag.field} on stdin and drop --${flag.flag}.`,
      );
    }
    const value = (await readAll(io.stdin)).replace(/\r?\n$/, "");
    if (value.length === 0) {
      throw new CliError("INVALID_INPUT", `--${flag.flag}-stdin read nothing from stdin.`,
        `Pipe the ${flag.field} in, for example: printf %s "$SECRET" | dropthis …`);
    }
    input[flag.field] = value;
  }

  const interactive = await isInteractive({ env: io.env, stdin: io.stdin, stdout: io.stdout, yes: globals.yes });

  if (op.name === "delete" && interactive) {
    await confirm(`Delete ${String(input.slug)}? Its files and URL go away now.`, io);
  }
  if (op.name === "prune" && input.dry_run === false && interactive) {
    await confirm("Delete every drop past its grace window?", io);
  }

  if (files !== undefined) {
    const { slug, ...settings } = input;
    const answer = await sendFiles(client, {
      ...(typeof slug === "string" ? { target: slug } : {}),
      files,
      settings,
    });
    renderResult(io, mode, op.name, answer.value);
    return;
  }

  if (spec.steps) {
    const report = await followScan(client, op, input, (step) => {
      if (mode === "jsonl") io.stdout.write(jsonLine(step));
    });
    renderResult(io, mode, op.name, report);
    return;
  }

  const answer = await client.call(op, input);
  const value = op.name === "delete" ? { slug: input.slug, deleted: true } : answer.value;
  renderResult(io, mode, op.name, value);
}

function toSlug(target: string, canonicalUrl: string): string {
  try {
    return resolveTarget(target, { canonicalUrl, aliasOrigins: [] });
  } catch (error) {
    if (error instanceof TargetError) throw new CliError(error.code, error.message);
    throw error;
  }
}

function parseJsonArgument(text: string, name: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new CliError("INVALID_INPUT", `<${name}> must be valid JSON; got ${JSON.stringify(text)}.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliError("INVALID_INPUT", `<${name}> must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

export async function readInstancesFile(env: Env): Promise<InstancesFile | null> {
  const path = instancesPath(env);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new CliError("INVALID_INPUT", `${path} is not valid JSON.`, "Fix the file or run `dropthis init` again.");
  }
  const file = parsed as Partial<InstancesFile>;
  if (typeof file !== "object" || file === null || typeof file.instances !== "object" || file.instances === null) {
    throw new CliError(
      "INVALID_INPUT",
      `${path} has no "instances" object.`,
      "Fix the file or run `dropthis init` again.",
    );
  }
  return { instances: file.instances, ...(typeof file.default === "string" ? { default: file.default } : {}) };
}

type Bucketed = { count: number; bytes: number };
type ScanReport = {
  states: Record<string, Bucketed>;
  total: Bucketed;
  incomplete: boolean;
  cursor?: string;
  dry_run?: boolean;
  deleted?: { drops: number; objects: number; bytes: number };
};

/**
 * `usage` and `prune` stop at the instance's ops budget and hand back a
 * cursor. The CLI follows it to the end — one call per step, streamed under
 * `--jsonl` — and sums the steps into one report of the same shape, so the
 * final line of `--jsonl` is the document `--json` prints.
 */
async function followScan(
  client: ApiClient,
  op: Operation<never>,
  input: Record<string, unknown>,
  onStep: (step: ScanReport) => void,
): Promise<ScanReport> {
  const sum = (a: Bucketed, b: Bucketed): Bucketed => ({ count: a.count + b.count, bytes: a.bytes + b.bytes });
  let report: ScanReport | undefined;
  let cursor = typeof input.cursor === "string" ? input.cursor : undefined;
  const seen = new Set<string>();

  for (;;) {
    const step = (await client.call<ScanReport>(op, { ...input, ...(cursor === undefined ? {} : { cursor }) })).value;
    onStep(step);

    if (report === undefined) {
      report = { ...step };
      delete report.cursor;
      report.incomplete = false;
    } else {
      for (const [state, bucket] of Object.entries(step.states)) {
        report.states[state] = sum(report.states[state] ?? { count: 0, bytes: 0 }, bucket);
      }
      report.total = sum(report.total, step.total);
      if (step.deleted !== undefined && report.deleted !== undefined) {
        report.deleted = {
          drops: report.deleted.drops + step.deleted.drops,
          objects: report.deleted.objects + step.deleted.objects,
          bytes: report.deleted.bytes + step.deleted.bytes,
        };
      }
    }

    if (!step.incomplete || step.cursor === undefined || seen.has(step.cursor)) {
      if (step.incomplete) {
        report.incomplete = true;
        if (step.cursor !== undefined) report.cursor = step.cursor;
      }
      return report;
    }
    seen.add(step.cursor);
    cursor = step.cursor;
  }
}
