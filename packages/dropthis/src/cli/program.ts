/**
 * The commander program, built from the generated surface. Nothing here
 * names an operation: each command spec says its words, its positional
 * arguments and its flags, and the action hands what commander parsed to
 * `runCommand`.
 */
import { Command, CommanderError } from "commander";
import type { Readable, Writable } from "node:stream";
import { commandSurface } from "./surface.js";
import type { ArgSpec, CommandSpec, FlagSpec } from "./surface.js";
import type { Globals, Invocation } from "./run.js";

export type ProgramIo = {
  stdin: Readable & { isTTY?: boolean };
  stdout: Writable & { isTTY?: boolean };
  stderr: Writable;
};

export type Handlers = {
  command(invocation: Invocation): Promise<void>;
  commands(globals: Globals): Promise<void>;
};

const GLOBAL_FLAGS: Array<[string, string]> = [
  ["--json", "Print exactly one JSON document."],
  ["--jsonl", "Stream one JSON object per step where a command has steps; else as --json."],
  ["--instance <name>", "Use this instance from ~/.config/dropthis/instances.json."],
  ["--yes", "Never prompt; answer yes."],
];

function argumentSyntax(arg: ArgSpec): string {
  const name = arg.variadic ? `${arg.name}...` : arg.name;
  return arg.required ? `<${name}>` : `[${name}]`;
}

function argumentHelp(arg: ArgSpec): string {
  switch (arg.kind) {
    case "target":
      return "The drop's slug or its URL on this instance.";
    case "files":
      return "Files and directories to publish; a directory becomes its relative paths.";
    case "json":
      return "A JSON object.";
    default:
      return `The ${arg.name}.`;
  }
}

function addFlag(command: Command, flag: FlagSpec): void {
  if (flag.kind === "boolean") {
    command.option(`--${flag.flag}`, flag.description);
    command.option(`--no-${flag.flag}`);
    return;
  }
  command.option(`--${flag.flag} <value>`, flag.description);
  if (flag.nullable) command.option(`--no-${flag.flag}`);
}

function withGlobals(command: Command): Command {
  for (const [syntax, help] of GLOBAL_FLAGS) command.option(syntax, help);
  return command;
}

function globalsOf(command: Command): Globals {
  const opts = command.optsWithGlobals<Record<string, unknown>>();
  return {
    json: opts.json === true,
    jsonl: opts.jsonl === true,
    instance: typeof opts.instance === "string" ? opts.instance : undefined,
    yes: opts.yes === true,
  };
}

/** commander camelCases `--idempotency-key` to `idempotencyKey`; the field is `idempotency_key`. */
const camel = (flag: string) => flag.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

function mount(parent: Command, spec: CommandSpec, handlers: Handlers): void {
  const [first, ...rest] = spec.words;
  let target = parent;
  if (rest.length > 0) {
    target =
      parent.commands.find((command) => command.name() === first) ??
      parent.command(first!).description(`${first} operations.`);
  }
  const command = target.command(rest.length > 0 ? rest.join(" ") : first!).description(spec.op.summary);
  for (const arg of spec.args) command.argument(argumentSyntax(arg), argumentHelp(arg));
  for (const flag of spec.flags) addFlag(command, flag);
  withGlobals(command);
  command.action(async (...received: unknown[]) => {
    // commander passes the positionals, then the options object, then the command.
    const positionals = received.slice(0, spec.args.length);
    const opts = command.opts<Record<string, unknown>>();
    const flags: Record<string, unknown> = {};
    for (const flag of spec.flags) {
      const value = opts[camel(flag.flag)];
      if (value !== undefined) flags[flag.field] = value;
    }
    await handlers.command({ spec, args: positionals, flags, globals: globalsOf(command) });
  });
}

export function buildProgram(version: string, io: ProgramIo, handlers: Handlers): Command {
  const program = new Command("dropthis")
    .description("Publish content an agent produced to a permanent URL you own.")
    .version(version, "-V, --version", "Print the version.")
    .exitOverride()
    .configureOutput({
      writeOut: (text) => io.stdout.write(text),
      writeErr: (text) => io.stderr.write(text),
    });
  withGlobals(program);

  for (const spec of commandSurface()) mount(program, spec, handlers);

  withGlobals(program.command("commands").description("List every command, with its arguments and options.")).action(
    async function (this: Command) {
      await handlers.commands(globalsOf(this));
    },
  );

  return program;
}

export { CommanderError };
