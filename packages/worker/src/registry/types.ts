/**
 * What an operation IS (AGENTS.md, "Operation registry").
 *
 * One entry per operation: its name, its place on the wire, the scope it
 * needs, one zod schema for its input and one handler. The REST router is
 * generated from these entries; the MCP tool list (issue #8) and the CLI
 * (issue #9) read the same entries, so the three surfaces cannot drift —
 * adding an operation is adding one entry, never three.
 *
 * The handler never sees HTTP. It takes the parsed input and a context, and
 * returns the object the surface will render — or, for a file body, a
 * `Response` the router passes through untouched.
 */
import type { z } from "zod";
import type { Scope } from "../auth/key.js";
import type { Caller } from "../auth/caller.js";
import type { Bucket, Env } from "../bindings.js";
import type { DevHooks } from "../dev/hooks.js";
import type { InstanceConfig } from "../instance-config.js";

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/** `public` is health and nothing else; the rest need a key. */
export type OperationScope = Scope | "public";

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
};

export type Operation<I = never> = {
  /** The registry name: `publish`, `user.add`. MCP prefixes it `dropthis_`. */
  name: string;
  method: HttpMethod;
  /** The path under `/_api/v1`, in Hono's grammar (`:slug`, `*`). */
  path: string;
  scope: OperationScope;
  /** One sentence, written for an agent. It becomes the MCP tool description. */
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
   * REST-only: a raw file body, not something an MCP tool can return. Issue #8
   * skips these when it generates the tool list.
   */
  restOnly?: boolean;
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
