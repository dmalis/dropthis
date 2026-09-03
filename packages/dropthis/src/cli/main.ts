/**
 * The entry: parse, run, map every outcome to an exit code (0 ok, 1 failure,
 * 2 cancelled, 4 auth required). Nothing else in the CLI calls
 * `process.exit`; the code is returned so a test can run `main` in-process
 * and the binary can set `process.exitCode`.
 */
import type { Readable, Writable } from "node:stream";
import { CommanderError } from "commander";
import { Cancelled, CliError, EXIT_CANCELLED, EXIT_FAILURE, EXIT_OK } from "./errors.js";
import { renderError, jsonLine } from "./output.js";
import { buildProgram } from "./program.js";
import { modeOf, runCommand } from "./run.js";
import type { Globals } from "./run.js";
import { commandSurface } from "./surface.js";
import { isClientName, runAuthHeaderCommand, runConnectCommand, CLIENTS } from "./connect-command.js";
import { runInitCommand } from "./init-command.js";

export type MainIo = {
  env: Record<string, string | undefined>;
  cwd: string;
  stdin: Readable & { isTTY?: boolean };
  stdout: Writable & { isTTY?: boolean };
  stderr: Writable;
};

export async function main(argv: string[], version: string, io: MainIo): Promise<number> {
  let exitCode = EXIT_OK;
  let lastGlobals: Globals = { json: false, jsonl: false, yes: false };

  const fail = (error: unknown): void => {
    const mode = modeOf(lastGlobals);
    if (error instanceof Cancelled) {
      io.stderr.write(mode === "plain" ? "dropthis: cancelled.\n" : jsonLine({ cancelled: true }));
      exitCode = EXIT_CANCELLED;
      return;
    }
    const cli =
      error instanceof CliError
        ? error
        : new CliError("INTERNAL", error instanceof Error ? error.message : String(error), undefined, false);
    renderError(io, mode, cli);
    exitCode = cli.exitCode;
  };

  const program = buildProgram(version, io, {
    async command(invocation) {
      lastGlobals = invocation.globals;
      try {
        await runCommand(invocation, io);
      } catch (error) {
        fail(error);
      }
    },
    async init(input, globals) {
      lastGlobals = globals;
      try {
        exitCode = await runInitCommand(input, globals, io);
      } catch (error) {
        fail(error);
      }
    },
    async connect(client, globals) {
      lastGlobals = globals;
      try {
        if (!isClientName(client)) {
          throw new CliError(
            "INVALID_INPUT",
            `--client must be one of: ${CLIENTS.join(", ")}; got ${JSON.stringify(client)}.`,
            "Pass one of the four client names.",
          );
        }
        exitCode = await runConnectCommand(client, globals, io);
      } catch (error) {
        fail(error);
      }
    },
    async authHeader(globals) {
      lastGlobals = globals;
      try {
        exitCode = await runAuthHeaderCommand(globals, io);
      } catch (error) {
        fail(error);
      }
    },
    async commands(globals) {
      lastGlobals = globals;
      const surface = commandSurface().map((spec) => ({
        command: spec.words.join(" "),
        operation: spec.op.name,
        scope: spec.op.scope,
        summary: spec.op.summary,
        arguments: spec.args.map((arg) => ({
          name: arg.name,
          kind: arg.kind,
          required: arg.required,
          variadic: arg.variadic,
        })),
        options: spec.flags.map((flag) => ({
          flag: `--${flag.flag}`,
          kind: flag.kind,
          ...(flag.nullable ? { clear: `--no-${flag.flag}` } : {}),
          description: flag.description,
        })),
        steps: spec.steps,
      }));
      if (modeOf(globals) === "plain") {
        for (const entry of surface) io.stdout.write(`${entry.command.padEnd(14)} ${entry.summary}\n`);
      } else {
        io.stdout.write(jsonLine(surface));
      }
    },
  });

  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      // commander already wrote its message. `--help` and `--version` exit 0;
      // a missing subcommand, an unknown option or a missing argument exit 1.
      return error.exitCode === 0 ? EXIT_OK : EXIT_FAILURE;
    }
    fail(error);
  }
  return exitCode;
}
