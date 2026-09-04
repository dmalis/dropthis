/**
 * What every surface does between "a request arrived" and "the handler runs":
 * validate the raw input with the operation's own rules, and build the
 * context the handler needs. REST (`api/router.ts`) and MCP (`mcp/server.ts`)
 * both call these, so a validation message or a context field can never
 * differ between the two.
 */
import type { Caller } from "../auth/caller.js";
import type { Env } from "../bindings.js";
import type { DevHooks } from "../dev/hooks.js";
import { ApiError } from "../errors.js";
import type { InstanceConfig } from "../instance-config.js";
import type { Operation, OperationContext } from "./types.js";

export function parseInput(op: Operation<never>, raw: unknown): never {
  if (op.parse !== undefined) return op.parse(raw);
  const parsed = op.schema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError("INVALID_INPUT", describeZodIssue(parsed.error.issues[0]));
  }
  return parsed.data;
}

type Issue = { path: PropertyKey[]; message: string; code?: string; keys?: string[] };

/** zod's first issue, as one sentence naming the field an agent must fix. */
export function describeZodIssue(issue: Issue | undefined): string {
  if (issue === undefined) return "The request body is not valid.";
  if (issue.code === "unrecognized_keys" && issue.keys !== undefined) {
    return `Unknown field${issue.keys.length > 1 ? "s" : ""}: ${issue.keys.join(", ")}.`;
  }
  const where = issue.path.length > 0 ? issue.path.map(String).join(".") : "the request body";
  return `${where}: ${issue.message}`;
}

/** The Worker's own fetch handler, for the in-process call `self` makes. */
export type SelfFetch = (request: Request, env: Env) => Promise<Response>;

export type ContextInput = {
  env: Env;
  config: InstanceConfig;
  caller: Caller;
  request: Request;
  hooks: DevHooks;
  self: SelfFetch;
};

export function operationContext(input: ContextInput): OperationContext {
  return {
    env: input.env,
    bucket: input.env.BUCKET,
    config: input.config,
    caller: input.caller,
    now: input.hooks.now(input.env, input.request),
    hooks: input.hooks,
    request: input.request,
    secret: () => requireSecret(input.env),
    self: (request) => input.self(request, input.env),
  };
}

export function requireSecret(env: Env): string {
  if (typeof env.HMAC_SECRET !== "string" || env.HMAC_SECRET.length === 0) {
    throw new ApiError("INTERNAL", "This instance has no HMAC_SECRET; redeploy it.");
  }
  return env.HMAC_SECRET;
}

/**
 * The body, refused before it is parsed when it is over the instance's
 * `max_request_bytes` (AGENTS.md: "the single-call ceiling is policy
 * `max_request_bytes`").
 *
 * The declared length is checked first, so an oversized call that announces
 * itself costs nothing. A client that streams announces nothing, so the read
 * itself is bounded: chunks are counted in BYTES — the unit the policy is
 * written in, and the unit `String.length` is not — and the stream is dropped
 * the moment the count passes the cap rather than buffered to the end
 * (issue #24, finding 15).
 */
export async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ApiError(
      "PAYLOAD_TOO_LARGE",
      `The request body is ${declared} bytes; this instance accepts ${maxBytes}.`,
    );
  }

  const text = await readCappedText(request, maxBytes);
  if (text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError("INVALID_INPUT", "The request body is not valid JSON.");
  }
}

/** The body as text, or `PAYLOAD_TOO_LARGE` at the byte the cap is passed. */
async function readCappedText(request: Request, maxBytes: number): Promise<string> {
  const body = request.body;
  if (body === null) return "";

  const decoder = new TextDecoder();
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  let total = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new ApiError(
          "PAYLOAD_TOO_LARGE",
          `The request body is over ${maxBytes} bytes, which is all this instance accepts.`,
        );
      }
      // `stream: true` so a character split across two chunks survives.
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    // Whether we finished or refused, nothing else reads this body.
    await reader.cancel().catch(() => {});
  }
  return text + decoder.decode();
}
