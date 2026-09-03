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
 *   - the caller resolution for `/_api/mcp` (`caller.ts`), which runs the
 *     provider's token check and then resolves the key id against the bucket
 *     on EVERY request — a removed key is refused on the next request whatever
 *     the token says;
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
import type { Bucket, Env } from "../bindings.js";
import type { InstanceConfig } from "../instance-config.js";
import { authorizeApp } from "./authorize.js";
import { resolveOAuthCaller } from "./caller.js";

/** What the provider runs once a token checked out: `ctx.props` holds the grant's props. */
export type ProtectedHandler = (request: Request, env: Env, ctx: { props?: unknown }) => Promise<Response>;

export const AUTHORIZE_PATH = "/_oauth/authorize";
export const TOKEN_PATH = "/_oauth/token";
export const REGISTER_PATH = "/_oauth/register";
export const MCP_PATH = "/_api/mcp";

/**
 * An access token lives a year (decision #90d, amended 2026-09-03).
 *
 * The library's default is an hour, and claude.ai answered that hour by
 * sending the human back to `/_oauth/authorize` — observed on 2026-09-03,
 * with no `grant_type=refresh_token` attempt in between (issue #20). A long
 * token is safe here because the token is never the authority: every request
 * on `/_api/mcp` resolves it to a key id and re-reads `keys/<id>.json` and
 * `keyhash/`, so `user remove` still ends the session on the very next call.
 */
export const ACCESS_TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60;

export type ProviderInput = {
  config: InstanceConfig;
  /** The bucket the refresh check reads; the same one the request carries. */
  bucket: Bucket;
  /** Runs behind a valid token on `/_api/mcp`; `oauth/caller.ts` supplies it. */
  protectedHandler: ProtectedHandler;
  /** This request's access-token lifetime, when the dev build shortens it. */
  accessTokenTtl?: number | undefined;
};

export function buildProvider({ config, bucket, protectedHandler, accessTokenTtl }: ProviderInput) {
  const authorize = authorizeApp(config);

  const options: OAuthProviderOptions<Env> = {
    apiRoute: MCP_PATH,
    apiHandler: { fetch: protectedHandler },
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
    accessTokenTTL: accessTokenTtl ?? ACCESS_TOKEN_TTL_SECONDS,
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
