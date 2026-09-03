/**
 * Where OAuth meets the router — the ONE file that wires the `/_oauth/*`
 * endpoints and the `/.well-known/oauth-*` discovery documents. `/_api/mcp`
 * itself stays with `api/mcp.ts`, which asks `resolveMcpCaller` (in
 * `oauth/caller.ts`) for the caller: bearer header if present, else OAuth.
 *
 * Issuer, resource and discovery name the canonical origin only; a GET on an
 * alias origin is redirected there, as the viewer does for drops.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { errorResponse } from "../api/errors.js";
import type { Env } from "../bindings.js";
import type { DevHooks } from "../dev/hooks.js";
import { ApiError } from "../errors.js";
import { loadInstanceConfig } from "../instance-config.js";
import type { InstanceConfig } from "../instance-config.js";
import { buildProvider } from "./provider.js";

/** Paths the provider owns. */
const PROVIDER_PATHS = [
  "/_oauth/*",
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-authorization-server/*",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/*",
];

export function oauthRoutes(hooks: DevHooks) {
  const routes = new Hono<{ Bindings: Env }>();
  routes.onError((error, c) => errorResponse(c, error));

  const viaProvider = async (c: Context<{ Bindings: Env }>, config: InstanceConfig) => {
    const provider = buildProvider({
      config,
      bucket: c.env.BUCKET,
      accessTokenTtl: hooks.accessTokenTtl(c.req.raw, c.env),
      // Never reached from these paths: `/_api/mcp` is not routed here.
      protectedHandler: async () => {
        throw new ApiError("INTERNAL", "The OAuth routes do not serve /_api/mcp.");
      },
    });
    // A COPY of the env: the provider installs its helpers on the object it
    // is given, and the Worker's env outlives this request and this config.
    return provider.fetch(c.req.raw, { ...c.env }, executionContext(c));
  };

  for (const path of PROVIDER_PATHS) {
    routes.all(path, async (c) => {
      const config = await loadInstanceConfig(c.env.BUCKET, c.req.url);
      return aliasRedirect(c.req.raw, config) ?? viaProvider(c, config);
    });
  }

  return routes;
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
