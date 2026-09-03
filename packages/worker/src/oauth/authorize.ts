/**
 * The authorize endpoint — the only OAuth code dropthis writes itself
 * (decision #53: the provider library does the protocol, we do the paste-key
 * page).
 *
 *   GET  /_oauth/authorize?…   validate the request, render the one form
 *   POST /_oauth/authorize?…   re-validate the SAME request, check the key,
 *                              complete the authorization, redirect with a code
 *
 * The pasted key goes through `resolveKey` — the exact lookup the bearer
 * header uses — so the two presentations can never accept different keys. A
 * wrong key re-renders the form with an error line and issues nothing: no
 * code, no redirect, no grant. Every request-validation failure the provider
 * reports without a validated redirect is answered locally as `400
 * INVALID_INPUT`; one with a validated redirect goes back to the client as
 * the OAuth error redirect the standard requires.
 */
import { AuthorizationError } from "@cloudflare/workers-oauth-provider";
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import type { Context } from "hono";
import { resolveKey } from "../auth/caller.js";
import { errorResponse } from "../api/errors.js";
import type { Env } from "../bindings.js";
import { publicHttpsUrlProblem } from "../domain/public-url.js";
import { ApiError, errorBody } from "../errors.js";
import type { InstanceConfig } from "../instance-config.js";
import { authorizePage } from "./page.js";
import type { OAuthProps } from "./caller.js";

/** The provider installs its helpers on the env it hands to handlers. */
type AuthorizeEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

const WRONG_KEY = "That key was not recognised. Try again.";

export function authorizeApp(config: InstanceConfig) {
  const app = new Hono<{ Bindings: AuthorizeEnv }>();
  app.onError((error, c) => errorResponse(c, error));

  const host = new URL(config.canonicalUrl).host;
  const action = (c: Context) => {
    const url = new URL(c.req.url);
    return `${url.pathname}${url.search}`;
  };

  app.get("/_oauth/authorize", async (c) => {
    guardClientId(c.req.url);
    const parsed = await parse(c);
    if (parsed instanceof Response) return parsed;
    return c.html(authorizePage({ host, action: action(c) }));
  });

  app.post("/_oauth/authorize", async (c) => {
    guardClientId(c.req.url);
    const parsed = await parse(c);
    if (parsed instanceof Response) return parsed;

    const form = await c.req.formData();
    const key = form.get("key");
    const caller =
      typeof key === "string" && key.length > 0
        ? await resolveKey(key, c.env.BUCKET).catch(() => null)
        : null;
    if (caller === null) {
      return c.html(authorizePage({ host, action: action(c), error: WRONG_KEY }), 401);
    }

    const props: OAuthProps = { keyId: caller.id };
    const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
      request: parsed,
      userId: caller.id,
      metadata: { label: caller.label },
      scope: parsed.scope,
      props,
    });
    return c.redirect(redirectTo, 302);
  });

  app.all("*", (c) => c.json(errorBody("NOT_FOUND", "No such route."), 404));

  return app;
}

/**
 * A `client_id` that is a URL names a Client ID Metadata Document the
 * provider will fetch. It passes the same guard as every URL the Worker
 * fetches on a caller's behalf — before the provider sees it, so a private
 * target is refused without a network round trip.
 */
function guardClientId(requestUrl: string): void {
  const clientId = new URL(requestUrl).searchParams.get("client_id");
  if (clientId === null || !clientId.includes("://")) return;
  const problem = publicHttpsUrlProblem(clientId);
  if (problem !== null) {
    throw new ApiError("INVALID_INPUT", `client_id: ${problem}`);
  }
}

async function parse(c: Context<{ Bindings: AuthorizeEnv }>): Promise<AuthRequest | Response> {
  try {
    return await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error;
    // No validated redirect URI: answer here, never redirect.
    if (!error.redirectUri) {
      throw new ApiError("INVALID_INPUT", `OAuth request: ${error.description}`);
    }
    const redirect = new URL(error.redirectUri);
    redirect.searchParams.set("error", error.code);
    redirect.searchParams.set("error_description", error.description);
    if (error.state) redirect.searchParams.set("state", error.state);
    if (error.issuer) redirect.searchParams.set("iss", error.issuer);
    return c.redirect(redirect.toString(), 302);
  }
}
