/**
 * What an operation IS (AGENTS.md, "Operation registry").
 *
 * One entry per operation: its name, its place on the wire, the scope it
 * needs, one zod schema for its input and one handler. The REST router is
 * generated from these entries; the MCP tool list (`mcp/tools.ts`) and the CLI
 * (issue #9) read the same entries, so the three surfaces cannot drift —
 * adding an operation is adding one entry, never three.
 *
 * The handler never sees HTTP. It takes the parsed input and a context, and
 * returns the object the surface will render — or, for a file body, a
 * `Response` the router passes through untouched.
 *
 * What an operation SAYS to an agent — its MCP title, description and
 * annotations — lives beside it in `registry/tools.ts`, keyed by name.
 */
import type { z } from "zod";
import type { Scope } from "../auth/key.js";
import type { Caller } from "../auth/caller.js";
import type { Bucket, Env } from "../bindings.js";
import type { DevHooks } from "../dev/hooks.js";
import type { InstanceConfig } from "../instance-config.js";

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/**
 * `public` is health and nothing else. `signed` is the staged-upload PUT, whose
 * only credential is the HMAC in its own URL (the handler verifies it); the
 * rest need a key.
 */
export type OperationScope = Scope | "public" | "signed";

export type OperationContext = {
  env: Env;
  bucket: Bucket;
  config: InstanceConfig;
  /** Absent only for `health`, the one operation that runs unauthenticated. */
  caller: Caller;
  now: Date;
  hooks: DevHooks;
  /** The raw request, for the few handlers that need a header or a raw path. */
  request: Request;
  /** `HMAC_SECRET`, resolved on demand so a route that does not sign is not blocked. */
  secret(): string;
  /**
   * This Worker, called in-process: the request never leaves the isolate and
   * needs no binding. `doctor` uses it to prove its own MCP endpoint answers.
   */
  self(request: Request): Promise<Response>;
};

/**
 * The ONE line a text-only MCP client must see: what happened, in words, above
 * the same JSON structured clients read. It is a field on the operation and not
 * a map keyed by operation name, because a second table keyed by name is a
 * second registry, and the one that drifts is the one nobody remembers.
 *
 * It never tells the agent what to call next (#51).
 */
export type ResultLine = (input: Record<string, unknown>, value: unknown) => string;

/**
 * What an operation is on the command line (AGENTS.md, "CLI conventions").
 *
 * Everything the CLI cannot read off the zod schema lives here, on the entry,
 * and not in a table keyed by operation name inside `cli/surface.ts`: a second
 * table keyed by name is a second registry, and adding an operation would mean
 * editing the CLI too — which is exactly what the registry exists to prevent
 * (issue #28, the same finding `resultLine` answered for MCP in #24).
 */
export type CliSurface = {
  /**
   * Not a command. `health` and the raw download are not things a person
   * types; the staged-upload path is how `publish` and `update` move large
   * files, never a command of its own; `doctor.checks` is `doctor --list`.
   */
  command?: false;
  /** Path parameters that take a slug OR a drop URL of this instance. */
  target?: readonly string[];
  /** Body fields the grammar puts first: `user add <label>`. */
  positional?: readonly string[];
  /** The operation pages with a cursor: `--jsonl` streams one object per call. */
  paged?: true;
  /**
   * REST answers with no body (`204`), so the CLI has nothing to print and
   * `--json` would print `null` — which is not the one deterministic document
   * the output contract promises. This builds it from the input instead.
   */
  result?: (input: Record<string, unknown>) => unknown;
  /**
   * Plain mode: the one line to write instead of the pretty-printed JSON, and
   * where it goes. `publish` writes its URL on stdout so it pipes; `delete`
   * and `user remove` have nothing a pipe wants, so their note goes to stderr
   * and stdout stays empty.
   */
  plain?: { line: (value: unknown) => string; stream: "stdout" | "stderr" };
};

export type Operation<I = never> = {
  /** The registry name: `publish`, `user.add`. MCP prefixes it `dropthis_`. */
  name: string;
  method: HttpMethod;
  /** The path under `/_api/v1`, in Hono's grammar (`:slug`, `*`). */
  path: string;
  scope: OperationScope;
  /** One sentence, written for an agent: the CLI's help line and the docs' table row. */
  summary: string;
  schema: z.ZodType<I>;
  /** Rules the schema cannot express (byte budgets, cross-field checks). */
  parse?: (raw: unknown) => I;
  /** Path parameters folded into the input object before validation. */
  params?: readonly string[];
  /** Query parameters folded into the input object before validation. */
  query?: readonly string[];
  /** The success status. `201` on create, `204` on delete, `200` otherwise. */
  status?: number;
  /**
   * Absent while another slice owns the operation: the entry declares the
   * contract, the router does not mount it, and wiring it is one line.
   */
  handler?: (input: I, context: OperationContext) => Promise<OperationResult | Response>;
  /**
   * REST-only: a raw file body, or the staged blob PUT whose credential is the
   * HMAC in its own URL — nothing an MCP tool returns or an agent is told
   * about. `mcp/tools.ts` skips these when it generates the tool list.
   */
  restOnly?: boolean;
  /**
   * The MCP tool name, when the generated one would be wrong for an agent:
   * `upload.create` is `dropthis_upload`, not `dropthis_upload_create`
   * (decision #93). Every other operation takes the generated name.
   */
  toolName?: string;
  /**
   * The body is bytes the handler streams (a staged blob PUT), not JSON the
   * router parses. The router leaves `request.body` untouched.
   */
  rawBody?: boolean;
  /**
   * The MCP result's opening line. Required of every operation that IS a tool;
   * `mcp-results.test.ts` pins that.
   */
  resultLine?: ResultLine;
  /** What this operation is on the command line; see `CliSurface`. */
  cli?: CliSurface;
};

/**
 * What a handler returns: the value every surface renders, plus the status
 * REST should use when the operation has more than one (`publish` is `201` on
 * create and `200` on an idempotent replay).
 */
export type OperationResult = { value: unknown; status?: number };

/** `METHOD /_api/v1/<path>` — the string the frozen route table is written in. */
export function routeOf(op: Operation<never>): string {
  return `${op.method} /_api/v1${op.path}`;
}
