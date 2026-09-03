/**
 * The CLI surface, generated from the operation registry (AGENTS.md,
 * "Operation registry" and "CLI conventions").
 *
 * Every operation's zod schema is read once and turned into a command spec:
 * path parameters become positional arguments, `files` becomes the paths on
 * the command line, every other field becomes a flag typed from its schema.
 * There is no per-command parser to drift from the REST body — a field added
 * to a registry schema is a flag the next build has.
 *
 * Three things are not operations and are mapped by name: `health` and the
 * raw download are not commands; the staged-upload path is how `publish` and
 * `update` move large files, never a command of its own; `doctor.checks` is
 * `doctor --list`.
 */
import type { z } from "zod";
import { OPERATIONS } from "../../../worker/src/registry/index.js";
import type { Operation } from "../../../worker/src/registry/index.js";
import { CliError } from "./errors.js";

export type FieldKind = "string" | "boolean" | "integer" | "json" | "files";

export type FlagSpec = {
  field: string;
  /** The kebab-case flag name without the dashes. */
  flag: string;
  kind: Exclude<FieldKind, "files">;
  /** `--no-<flag>` sends `null` (clears the field). */
  nullable: boolean;
  /**
   * The field's value can be a secret, so the flag takes only the spellings
   * that are not one (`generate`); the secret itself arrives on stdin through
   * the `--<flag>-stdin` companion. AGENTS.md, "CLI conventions": secrets via
   * env or stdin, never flags — a password on argv is in the shell history and
   * in `ps` for every user on the machine.
   */
  secret?: boolean;
  description: string;
};

/** The registry fields whose value may be a secret. */
export const SECRET_FIELDS = new Set(["password"]);

/** The one non-secret spelling `--password` accepts on the command line. */
export const GENERATE = "generate";

export type ArgKind = "string" | "target" | "files" | "json";

export type ArgSpec = {
  /** The input field the value lands in; `*` means "the whole input". */
  field: string;
  name: string;
  kind: ArgKind;
  variadic: boolean;
  required: boolean;
};

export type CommandSpec = {
  words: string[];
  op: Operation<never>;
  args: ArgSpec[];
  flags: FlagSpec[];
  /** The operation pages with a cursor: `--jsonl` streams one object per call. */
  steps: boolean;
};

/** Operations that are not commands, and why (in the module comment). */
const NOT_COMMANDS = new Set(["health", "file_download", "upload.create", "upload.put", "upload.commit", "doctor.checks"]);

/** Path parameters that take a slug OR a drop URL of this instance. */
const TARGET_PARAMS = new Set(["slug"]);

/** Body fields the grammar puts first: `user add <label>`. */
const POSITIONAL_FIELDS = new Set(["label"]);

const PAGED = new Set(["usage", "prune"]);

type Def = {
  type: string;
  shape?: Record<string, z.ZodType>;
  innerType?: z.ZodType;
  options?: z.ZodType[];
  in?: z.ZodType;
  element?: z.ZodType;
};

const defOf = (schema: z.ZodType): Def => (schema as unknown as { _zod: { def: Def } })._zod.def;

type Field = { kind: FieldKind; nullable: boolean };

/**
 * A field's kind from its schema, looking through `optional`, `nullable` and
 * `default`. A union is a coercion pair from `registry/params.ts` — boolean or
 * integer — recognised by the plain member; anything structured is JSON.
 */
function classify(schema: z.ZodType, name: string): Field {
  let def = defOf(schema);
  let nullable = false;
  for (;;) {
    if (def.type === "optional" || def.type === "default" || def.type === "nonoptional") {
      def = defOf(def.innerType!);
      continue;
    }
    if (def.type === "nullable") {
      nullable = true;
      def = defOf(def.innerType!);
      continue;
    }
    break;
  }
  if (name === "files" && def.type === "array") return { kind: "files", nullable };
  switch (def.type) {
    case "string":
    case "literal":
    case "enum":
      return { kind: "string", nullable };
    case "boolean":
      return { kind: "boolean", nullable };
    case "number":
    case "int":
      return { kind: "integer", nullable };
    case "union": {
      const kinds = new Set(def.options!.map((option) => classify(option, name).kind));
      if (kinds.has("boolean")) return { kind: "boolean", nullable };
      if (kinds.has("integer")) return { kind: "integer", nullable };
      return { kind: "string", nullable };
    }
    case "pipe":
      return classify(def.in!, name);
    default:
      return { kind: "json", nullable };
  }
}

const kebab = (name: string) => name.replace(/_/g, "-");

function specFor(op: Operation<never>): CommandSpec {
  const words = op.name === "doctor" ? ["doctor"] : op.name.split(".");
  const args: ArgSpec[] = [];
  const flags: FlagSpec[] = [];
  const def = defOf(op.schema as unknown as z.ZodType);

  if (def.type !== "object") {
    // A free-form input (`config set`'s policy patch) is one JSON argument.
    args.push({ field: "*", name: "json", kind: "json", variadic: false, required: true });
    return { words, op, args, flags, steps: PAGED.has(op.name) };
  }

  const params = new Set(op.params ?? []);
  for (const name of op.params ?? []) {
    args.push({
      field: name,
      name: TARGET_PARAMS.has(name) ? "target" : name,
      kind: TARGET_PARAMS.has(name) ? "target" : "string",
      variadic: false,
      required: true,
    });
  }

  for (const [name, schema] of Object.entries(def.shape ?? {})) {
    if (params.has(name)) continue;
    if (POSITIONAL_FIELDS.has(name)) {
      args.push({ field: name, name, kind: "string", variadic: false, required: true });
      continue;
    }
    const field = classify(schema, name);
    if (field.kind === "files") {
      args.push({
        field: "files",
        name: "paths",
        kind: "files",
        variadic: true,
        required: defOf(schema).type !== "optional",
      });
      continue;
    }
    flags.push({
      field: name,
      flag: kebab(name),
      kind: field.kind,
      nullable: field.nullable,
      ...(SECRET_FIELDS.has(name) ? { secret: true } : {}),
      description: describe(op.name, name, field, schema),
    });
  }

  // One companion per secret field, last so the generated order is stable.
  for (const secret of flags.filter((flag) => flag.secret === true)) {
    flags.push({
      field: `${secret.field}_stdin`,
      flag: `${secret.flag}-stdin`,
      kind: "boolean",
      nullable: false,
      description: `Read the ${secret.field} from stdin (one line), so it stays out of argv.`,
    });
  }

  if (op.name === "doctor") {
    flags.push({
      field: "list",
      flag: "list",
      kind: "boolean",
      nullable: false,
      description: "List the checks instead of running them.",
    });
  }

  return { words, op, args, flags, steps: PAGED.has(op.name) };
}

/**
 * One line per flag, written for an agent reading `--help` — and it is the
 * registry's own sentence. The schema already carries the description the MCP
 * tool and `/_skill.md` show (`registry/fields.ts`); a second list here would
 * be the drift the registry exists to prevent, so the only text this file adds
 * is the `--no-<flag>` clause, which is CLI grammar and exists nowhere else.
 */
function describe(opName: string, field: string, kind: Field, schema: z.ZodType): string {
  let base = descriptionOf(schema) ?? `${field} (${kind.kind})`;
  if (SECRET_FIELDS.has(field)) {
    base = `${base} On the command line only "${GENERATE}"; a chosen one goes on stdin with --${kebab(field)}-stdin.`;
  }
  return kind.nullable && opName === "update" ? `${base} --no-${kebab(field)} clears it.` : base;
}

/** The description, through the wrappers a field may be built from. */
function descriptionOf(schema: z.ZodType): string | undefined {
  const described = schema.description;
  if (described !== undefined) return described;
  const def = defOf(schema);
  if (def.type === "pipe" && def.in !== undefined) return descriptionOf(def.in);
  if (def.innerType !== undefined) return descriptionOf(def.innerType);
  return undefined;
}

let cached: CommandSpec[] | undefined;

export function commandSurface(): CommandSpec[] {
  cached ??= OPERATIONS.filter((op) => !NOT_COMMANDS.has(op.name)).map(specFor);
  return cached;
}

/** A raw flag value, typed as the schema says. */
export function coerceFlag(spec: Pick<FlagSpec, "flag" | "kind">, raw: unknown): unknown {
  switch (spec.kind) {
    case "integer": {
      if (typeof raw === "number") return raw;
      if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
        throw new CliError("INVALID_INPUT", `--${spec.flag} must be a whole number; got ${JSON.stringify(raw)}.`);
      }
      return Number(raw);
    }
    case "json": {
      if (typeof raw !== "string") return raw;
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        throw new CliError("INVALID_INPUT", `--${spec.flag} must be valid JSON; got ${JSON.stringify(raw)}.`);
      }
    }
    default:
      return raw;
  }
}
