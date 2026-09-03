/**
 * The MCP server for one request (AGENTS.md, "Operation registry"; "Auth").
 *
 * It is built per request, for one caller, because the tool list depends on
 * the caller's scope and the transport is stateless: a Worker holds nothing
 * between requests, so a session would be a promise it cannot keep.
 *
 * It is the SDK's low-level `Server`, not `McpServer`: the registry already
 * validates input with its own rules and its own sentences, and `McpServer`
 * would validate first and answer a bad argument with a JSON-RPC error — a
 * second error shape. Here every refusal a tool can produce is the
 * catalogue's object, in-band (`results.ts`).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toApiError } from "../api/errors.js";
import { requireScope } from "../auth/caller.js";
import type { Caller } from "../auth/caller.js";
import type { Env } from "../bindings.js";
import type { DevHooks } from "../dev/hooks.js";
import { resolveTarget } from "../domain/target.js";
import { ApiError } from "../errors.js";
import type { InstanceConfig } from "../instance-config.js";
import { operation } from "../registry/index.js";
import { operationContext, parseInput } from "../registry/invoke.js";
import type { SelfFetch } from "../registry/invoke.js";
import { serverInstructions } from "../registry/tools.js";
import { errorResult, successResult } from "./results.js";
import { toolSurface, toolsFor } from "./tools.js";
import type { Tool } from "./tools.js";

/** The server's own version, as `initialize` reports it. */
export const SERVER_VERSION = "0.1.0";

export type McpInput = {
  env: Env;
  config: InstanceConfig;
  caller: Caller;
  request: Request;
  hooks: DevHooks;
  self: SelfFetch;
};

export function mcpServer(input: McpInput): Server {
  const server = new Server(
    { name: "dropthis", version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions: serverInstructions(input.config.canonicalUrl),
    },
  );

  const visible = toolsFor(input.caller.scope);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: visible.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema as { type: "object"; [key: string]: unknown },
      annotations: tool.annotations,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments ?? {};
    try {
      return await callTool(request.params.name, args, input);
    } catch (error) {
      return errorResult(toApiError(error));
    }
  });

  return server;
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  input: McpInput,
): Promise<CallToolResult> {
  // The whole surface is searched, not the visible part: a user key calling
  // an admin tool is a scope refusal, not an unknown tool — the same answer
  // the REST route gives, and the honest one.
  const tool = toolSurface().find((candidate) => candidate.name === name);
  if (tool === undefined) {
    throw new ApiError("INVALID_INPUT", `No tool named ${name}; list the tools to see this instance's.`);
  }
  requireScope(input.caller, tool.scope);

  const op = operation(tool.operation);
  const raw = tool.takesTarget ? withSlug(args, input.config) : args;
  const parsed = parseInput(op, raw);
  const context = operationContext(input);

  const result = await op.handler!(parsed, context);
  if (result instanceof Response) {
    throw new ApiError("INTERNAL", `${tool.name} produced a raw response; it is not a tool.`);
  }
  return successResult(tool.operation, args, result.value);
}

/**
 * `target` → `slug`, the one translation between a tool call and the
 * operation (`tools.ts`). A URL is checked against this instance's origins
 * here, so `WRONG_INSTANCE` is raised before any storage is touched.
 */
function withSlug(args: Record<string, unknown>, config: InstanceConfig): Record<string, unknown> {
  const { target, ...rest } = args;
  if (typeof target !== "string" || target.length === 0) {
    throw new ApiError("INVALID_INPUT", "target: the drop's URL on this instance, or its slug.");
  }
  const slug = resolveTarget(target, {
    canonicalUrl: config.canonicalUrl,
    aliasOrigins: config.aliasOrigins,
  });
  return { ...rest, slug };
}

export type { Tool };
