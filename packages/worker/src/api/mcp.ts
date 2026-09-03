/**
 * `POST /_api/mcp` — MCP over Streamable HTTP, bearer (AGENTS.md, "Auth").
 *
 * The route does four things and nothing else: authenticate before the body
 * is read (a stranger's payload costs nothing); read the instance config;
 * bound and parse the body with the same cap REST uses; hand the parsed
 * JSON-RPC message to a fresh, stateless transport wired to a server built for
 * this caller. There is no session: a Worker keeps nothing between requests,
 * so `GET` (the server-to-client stream) and `DELETE` (session end) are
 * refused with `405`, as the MCP transport spec allows.
 *
 * An unauthenticated call answers `401` with the catalogue object AND a
 * `WWW-Authenticate` header naming the protected-resource metadata, which is
 * what a browser client needs to start OAuth (issue #12 serves the document;
 * the spike proved claude.ai reads this header first).
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { resolveMcpCaller } from "../auth/caller.js";
import type { Env } from "../bindings.js";
import type { DevHooks } from "../dev/hooks.js";
import { ERRORS, errorBody } from "../errors.js";
import { loadInstanceConfig } from "../instance-config.js";
import { readJsonBody } from "../registry/invoke.js";
import type { SelfFetch } from "../registry/invoke.js";
import { mcpServer } from "../mcp/server.js";
import { errorResponse, toApiError } from "./errors.js";

export const MCP_PATH = "/_api/mcp";

/** Where a client that cannot send a header learns how to log in. */
export function resourceMetadataUrl(origin: string): string {
  return `${origin}/.well-known/oauth-protected-resource${MCP_PATH}`;
}

export function mcpRoutes(hooks: DevHooks, self: SelfFetch) {
  const routes = new Hono<{ Bindings: Env }>();

  routes.onError((error, c) => errorResponse(c, error));

  routes.all("/", async (c) => {
    const request = c.req.raw;

    if (request.method !== "POST") {
      return c.json(
        { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null },
        405,
        { Allow: "POST" },
      );
    }

    try {
      const caller = await resolveMcpCaller(request, c.env.BUCKET);
      const config = await loadInstanceConfig(c.env.BUCKET, request.url);
      const parsedBody = await readJsonBody(request, config.policy.max_request_bytes);

      const server = mcpServer({ env: c.env, config, caller, request, hooks, self });
      // No `sessionIdGenerator` = stateless; JSON answers, never an SSE stream.
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      await server.connect(transport);
      return await transport.handleRequest(request, { parsedBody });
    } catch (error) {
      const api = toApiError(error);
      if (api.code !== "UNAUTHENTICATED") throw api;
      const origin = new URL(request.url).origin;
      return c.json(errorBody(api.code, api.message), ERRORS.UNAUTHENTICATED.status as 401, {
        "WWW-Authenticate": `Bearer realm="dropthis", resource_metadata="${resourceMetadataUrl(origin)}"`,
      });
    }
  });

  return routes;
}
