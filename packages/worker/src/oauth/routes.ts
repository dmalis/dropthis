/**
 * Where OAuth meets the router — the ONE file that wires `/_api/mcp`, the
 * `/_oauth/*` endpoints and the `/.well-known/oauth-*` discovery documents.
 *
 * The rule on `/_api/mcp` (AGENTS.md, "Auth"): the bearer header wins if it
 * holds a key; otherwise the request is an OAuth request and the provider
 * decides. Both presentations end in the same place — the MCP surface with a
 * resolved `Caller` — and both refusals are the same `401 UNAUTHENTICATED`,
 * with the discovery pointer the MCP specification requires so a browser
 * client can find the authorize page.
 *
 * Issuer, resource and discovery name the canonical origin only; a GET on an
 * alias origin is redirected there, as the viewer does for drops.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { errorResponse } from "../api/errors.js";
import { bearerKey, resolveKey } from "../auth/caller.js";
import type { Env } from "../bindings.js";
import type { DevHooks } from "../dev/hooks.js";
import { errorBody } from "../errors.js";
import { loadInstanceConfig } from "../instance-config.js";
import type { InstanceConfig } from "../instance-config.js";
import { MCP_PATH, buildProvider } from "./provider.js";
import type { McpHandler } from "./provider.js";

/** Paths the provider owns, besides `/_api/mcp` itself. */
const PROVIDER_PATHS = [
  "/_oauth/*",
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-authorization-server/*",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/*",
];

export function oauthRoutes(hooks: DevHooks, mcp: McpHandler) {
  const routes = new Hono<{ Bindings: Env }>();
  routes.onError((error, c) => errorResponse(c, error));

  const viaProvider = async (c: Context<{ Bindings: Env }>, config: InstanceConfig) => {
    const provider = buildProvider({
      config,
      hooks,
      mcp,
      bucket: c.env.BUCKET,
      accessTokenTtl: hooks.accessTokenTtl(c.req.raw, c.env),
    });
    // A COPY of the env: the provider installs its helpers on the object it
    // is given, and the Worker's env outlives this request and this config.
    return provider.fetch(c.req.raw, { ...c.env }, executionContext(c));
  };

  routes.all(MCP_PATH, async (c) => {
    const config = await loadInstanceConfig(c.env.BUCKET, c.req.url);

    const key = bearerKey(c.req.raw);
    if (key !== null) {
      const caller = await resolveKey(key, c.env.BUCKET).catch(() => null);
      if (caller !== null) {
        return mcp(c.req.raw, {
          env: c.env,
          bucket: c.env.BUCKET,
          config,
          caller,
          hooks,
          now: hooks.now(c.env, c.req.raw),
        });
      }
    }

    const response = await viaProvider(c, config);
    return response.status === 401 ? unauthenticated(response) : response;
  });

  for (const path of PROVIDER_PATHS) {
    routes.all(path, async (c) => {
      const config = await loadInstanceConfig(c.env.BUCKET, c.req.url);
      return aliasRedirect(c.req.raw, config) ?? viaProvider(c, config);
    });
  }

  return routes;
}

/**
 * The provider's own 401 carries the right headers (`WWW-Authenticate` with
 * the `resource_metadata` pointer) and an OAuth-shaped body. On `/_api/mcp`
 * the body becomes the product's frozen error object; the headers stay.
 */
function unauthenticated(from: Response): Response {
  const headers = new Headers(from.headers);
  headers.set("content-type", "application/json; charset=UTF-8");
  headers.delete("content-length");
  return new Response(
    JSON.stringify(errorBody("UNAUTHENTICATED", "This instance needs a valid key.")),
    { status: 401, headers },
  );
}

function aliasRedirect(request: Request, config: InstanceConfig): Response | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const url = new URL(request.url);
  if (!config.aliasOrigins.includes(url.origin)) return null;
  // Not `Response.redirect`: its headers are immutable, and the noindex
  // middleware still has to stamp this response.
  return new Response(null, {
    status: 301,
    headers: { location: `${config.canonicalUrl}${url.pathname}${url.search}` },
  });
}

/**
 * The execution context the provider sets `props` on. Hono throws when a
 * request was made without one (a unit test calling `app.fetch` directly),
 * and the provider only needs an object it can write to.
 */
function executionContext(c: Context): object {
  try {
    return c.executionCtx;
  } catch {
    return { waitUntil() {}, passThroughOnException() {} };
  }
}
