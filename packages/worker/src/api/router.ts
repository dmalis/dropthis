/**
 * The REST surface, generated from the operation registry.
 *
 * Nothing here knows what any operation does. It does the four things every
 * REST call needs and then gets out of the way:
 *
 *   1. authenticate (every route but `health`) and check the scope, BEFORE the
 *      body is read — a stranger's oversized payload costs us nothing;
 *   2. read the instance config, which carries the body cap and the canonical
 *      origin;
 *   3. fold the path parameters, the query and the body into ONE object and
 *      validate it with the operation's own schema;
 *   4. render the result: the object itself with the operation's status, or a
 *      `Response` a handler built (a file body), passed through untouched.
 *
 * Adding an operation is adding a registry entry. There is no route to write.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { requireScope, resolveCaller } from "../auth/caller.js";
import type { Caller } from "../auth/caller.js";
import type { Env } from "../bindings.js";
import type { DevHooks } from "../dev/hooks.js";
import { ApiError } from "../errors.js";
import { loadInstanceConfig } from "../instance-config.js";
import type { InstanceConfig } from "../instance-config.js";
import { INITIAL_POLICY } from "../policy/defaults.js";
import { OPERATIONS } from "../registry/index.js";
import { operationContext, parseInput, readJsonBody } from "../registry/invoke.js";
import type { Operation } from "../registry/types.js";
import { errorResponse } from "./errors.js";

/** Methods that carry a request body. */
const WITH_BODY = new Set(["POST", "PATCH", "PUT"]);

/** The caller of an unauthenticated operation; `health` never reads it. */
const NOBODY: Caller = { id: "", label: "", scope: "user" };

export function apiRoutes(hooks: DevHooks) {
  const routes = new Hono<{ Bindings: Env }>();

  routes.onError((error, c) => errorResponse(c, error));

  for (const op of OPERATIONS) {
    if (op.handler === undefined) continue;
    routes.on(op.method, op.path, (c) => run(op as Operation<never>, c, hooks));
  }

  return routes;
}

async function run(
  op: Operation<never>,
  c: Context<{ Bindings: Env }>,
  hooks: DevHooks,
): Promise<Response> {
  const open = op.scope === "public";

  let caller = NOBODY;
  if (op.scope !== "public") {
    caller = await resolveCaller(c.req.raw, c.env.BUCKET);
    requireScope(caller, op.scope);
  }

  // `health` reads nothing: `init` polls it while a deploy propagates, and a
  // liveness probe that touches the bucket is not a liveness probe.
  const config = open
    ? unreadConfig(c.req.url)
    : await loadInstanceConfig(c.env.BUCKET, c.req.url);

  const raw = await collect(op, c, config.policy.max_request_bytes);
  const input = parseInput(op, raw);

  const context = operationContext({ env: c.env, config, caller, request: c.req.raw, hooks });

  const result = await op.handler!(input, context);
  if (result instanceof Response) return result;

  const status = result.status ?? op.status ?? 200;
  if (status === 204) return c.body(null, 204);
  return c.json(result.value as Record<string, unknown>, status as 200);
}

/**
 * One input object out of three sources. Path parameters and the query are
 * strings, so the schemas that read them accept both a string and the value
 * (see `registry/params.ts`); the body wins nothing — a field it shares with a
 * path parameter would be an ambiguity, so the path parameter is applied last.
 */
async function collect(
  op: Operation<never>,
  c: Context<{ Bindings: Env }>,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  const raw: Record<string, unknown> = {};

  if (WITH_BODY.has(op.method)) {
    const body = await readJsonBody(c.req.raw, maxBytes);
    if (body !== undefined) {
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw new ApiError("INVALID_INPUT", "The request body must be a JSON object.");
      }
      Object.assign(raw, body);
    }
  }

  for (const name of op.query ?? []) {
    const value = c.req.query(name);
    if (value !== undefined) raw[name] = value;
  }

  for (const name of op.params ?? []) {
    const value = c.req.param(name);
    if (value !== undefined) raw[name] = value;
  }

  return raw;
}

/**
 * The config an OPEN route runs with. It reads nothing: `health` must answer
 * while `init` is still polling a propagating deploy, possibly before
 * `system/config.json` exists at all, so it falls back to the frozen initial
 * policy and the request's own origin.
 */
function unreadConfig(requestUrl: string): InstanceConfig {
  return {
    policy: { ...INITIAL_POLICY },
    canonicalUrl: new URL(requestUrl).origin,
    aliasOrigins: [],
    instanceName: "main",
  };
}
