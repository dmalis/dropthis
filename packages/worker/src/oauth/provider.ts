/**
 * The OAuth provider, configured (AGENTS.md, "Auth"; decisions #53, #72).
 *
 * `@cloudflare/workers-oauth-provider` does the protocol: discovery documents,
 * dynamic client registration, Client ID Metadata Documents (how claude.ai
 * identifies itself), PKCE, the token endpoint, refresh-token rotation, and
 * the grant records in `OAUTH_KV`. dropthis contributes three things:
 *
 *   - the authorize page (`authorize.ts`), which turns a pasted key into a
 *     grant whose `props` hold the KEY ID and nothing else;
 *   - the protected handler for `/_api/mcp`, which resolves that key id
 *     against the bucket on EVERY request (`caller.ts`) before the MCP surface
 *     runs — a removed key is refused on the next request whatever the token
 *     says;
 *   - the binding rule that a connection never expires on its own: the grant
 *     and the refresh token carry no expiry, a DCR client record carries no
 *     expiry, and a refresh is refused only when the key behind it is gone.
 *
 * The provider is built per request from the instance config, because the
 * issuer, the resource and the discovery documents must name the CANONICAL
 * origin, and that is a value in the bucket, not in the code.
 */
import { OAuthError, OAuthProvider } from "@cloudflare/workers-oauth-provider";
import type { OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import type { Caller } from "../auth/caller.js";
import type { Bucket, Env } from "../bindings.js";
import type { DevHooks } from "../dev/hooks.js";
import type { InstanceConfig } from "../instance-config.js";
import { authorizeApp } from "./authorize.js";
import { resolveOAuthCaller } from "./caller.js";

/** What the MCP surface receives once the caller is known, by either presentation. */
export type McpContext = {
  env: Env;
  bucket: Bucket;
  config: InstanceConfig;
  caller: Caller;
  hooks: DevHooks;
  now: Date;
};

export type McpHandler = (request: Request, context: McpContext) => Promise<Response>;

export const AUTHORIZE_PATH = "/_oauth/authorize";
export const TOKEN_PATH = "/_oauth/token";
export const REGISTER_PATH = "/_oauth/register";
export const MCP_PATH = "/_api/mcp";

export type ProviderInput = {
  config: InstanceConfig;
  hooks: DevHooks;
  mcp: McpHandler;
  /** The bucket the refresh check reads; the same one the request carries. */
  bucket: Bucket;
  /** This request's access-token lifetime, when the dev build shortens it. */
  accessTokenTtl?: number | undefined;
};

export function buildProvider({ config, hooks, mcp, bucket, accessTokenTtl }: ProviderInput) {
  const authorize = authorizeApp(config);

  const options: OAuthProviderOptions<Env> = {
    apiRoute: MCP_PATH,
    apiHandler: {
      fetch: async (request: Request, env: Env, ctx: { props?: unknown }) => {
        const caller = await resolveOAuthCaller(env.BUCKET, ctx.props);
        return mcp(request, {
          env,
          bucket: env.BUCKET,
          config,
          caller,
          hooks,
          now: hooks.now(env, request),
        });
      },
    },
    defaultHandler: {
      fetch: (request: Request, env: Env, ctx: object) =>
        authorize.fetch(request, env as never, ctx as never),
    },
    authorizeEndpoint: AUTHORIZE_PATH,
    tokenEndpoint: TOKEN_PATH,
    // DCR stays on for clients that do not speak CIMD (decision #72).
    clientRegistrationEndpoint: REGISTER_PATH,
    clientIdMetadataDocumentEnabled: true,
    resourceMetadata: {
      resource: `${config.canonicalUrl}${MCP_PATH}`,
      authorization_servers: [config.canonicalUrl],
      bearer_methods_supported: ["header"],
      resource_name: "dropthis",
    },
    ...(accessTokenTtl === undefined ? {} : { accessTokenTTL: accessTokenTtl }),
    /**
     * A refresh is the one moment the provider would mint a token without
     * the bucket being consulted, so the key is checked here too: a grant
     * whose key was removed is refused with 401 and the client is told to
     * connect again. Everything else about the grant is left as it is.
     */
    tokenExchangeCallback: async ({ grantType, props }) => {
      if (grantType !== "refresh_token") return;
      try {
        await resolveOAuthCaller(bucket, props);
      } catch {
        throw new OAuthError("invalid_grant", {
          description: "The key behind this connection was removed. Connect again.",
          statusCode: 401,
        });
      }
    },
    // Expected refusals (a bad token, a wrong code) are not worth a log line each.
    onError: () => undefined,
  };

  // The library reads an EXPLICIT `undefined` as "never expires" (its default
  // is 30 days for refresh tokens and 90 for registered clients). Under
  // `exactOptionalPropertyTypes` that cannot be written as a literal, so the
  // two properties are assigned after the fact; the unit test pins that the
  // grant is then put with no expiration at all.
  Object.assign(options, { refreshTokenTTL: undefined, clientRegistrationTTL: undefined });

  return new OAuthProvider<Env>(options);
}
