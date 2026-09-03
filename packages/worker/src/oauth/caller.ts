/**
 * Who is behind an OAuth token (AGENTS.md, "Auth" — the OAuth half of "one
 * key, two presentations").
 *
 * A token is an alias for a key, never a second identity. The grant the
 * provider stores in `OAUTH_KV` carries the key ID and nothing else (`props`),
 * and this resolves that ID on EVERY request:
 *
 *   props.keyId → `keys/<id>.json` → `{label, scope, hash}`
 *              → `keyhash/<hash>` must exist and name the same id.
 *
 * The second read is what makes revocation instant and identical to the
 * bearer path: `user remove` deletes the `keyhash/` pointer first, so the
 * very next request with a token — whatever the token's own expiry — is
 * refused at the same write that refuses the raw key. Scope is read from the
 * record now, not from the grant, so it can never be stale.
 */
import type { Bucket, Env } from "../bindings.js";
import { bearerKey, parseKeyRecord, pointerId, resolveKey } from "../auth/caller.js";
import type { Caller } from "../auth/caller.js";
import type { DevHooks } from "../dev/hooks.js";
import { ApiError } from "../errors.js";
import type { InstanceConfig } from "../instance-config.js";
import { keyHashKey, keyRecordKey } from "../storage/keys.js";
import { buildProvider } from "./provider.js";

/** What the authorize page proves and the grant remembers: a key ID only. */
export type OAuthProps = { keyId: string };

function unauthenticated(): ApiError {
  return new ApiError("UNAUTHENTICATED", "This instance needs a valid key.");
}

export function isOAuthProps(value: unknown): value is OAuthProps {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { keyId?: unknown }).keyId === "string" &&
    (value as { keyId: string }).keyId.length > 0
  );
}

export async function resolveOAuthCaller(bucket: Bucket, props: unknown): Promise<Caller> {
  if (!isOAuthProps(props)) throw unauthenticated();

  const record = await bucket.get(keyRecordKey(props.keyId));
  if (record === null) throw unauthenticated();
  const parsed = parseKeyRecord(await record.text());
  if (parsed === null || parsed.id !== props.keyId) throw unauthenticated();

  const pointer = await bucket.get(keyHashKey(parsed.hash));
  if (pointer === null) throw unauthenticated();
  if (pointerId(await pointer.text()) !== parsed.id) throw unauthenticated();

  return { id: parsed.id, label: parsed.label, scope: parsed.scope };
}

/**
 * The caller of `/_api/mcp` — the ONE function the MCP route asks (AGENTS.md
 * "Auth": header if present, else OAuth).
 *
 * The bearer value is tried as a raw key first (one `keyhash/` GET); anything
 * else is handed to the OAuth provider, which checks the token's hash, expiry
 * and audience and, if it passes, exposes the grant's `props`. Those props
 * name a key id, resolved above. The route and the tool layer never learn a
 * second identity: both presentations end in the same `Caller`, and both
 * refusals are the same `UNAUTHENTICATED`.
 *
 * The provider's own fetch is used for the token check — not a helper that
 * would re-implement part of it — so a token passes here exactly when it
 * passes on a stock deployment. The handler it runs reads nothing from the
 * request; the body is still unread for the route to parse.
 */
export async function resolveMcpCaller(
  request: Request,
  env: Env,
  config: InstanceConfig,
  hooks: DevHooks,
): Promise<Caller> {
  const key = bearerKey(request);
  if (key === null) throw unauthenticated();

  const asKey = await resolveKey(key, env.BUCKET).catch(() => null);
  if (asKey !== null) return asKey;

  let props: unknown;
  let seen = false;
  const provider = buildProvider({
    config,
    bucket: env.BUCKET,
    accessTokenTtl: hooks.accessTokenTtl(request, env),
    protectedHandler: async (_request, _env, ctx) => {
      seen = true;
      props = ctx.props;
      return new Response(null, { status: 204 });
    },
  });
  // A COPY of the env: the provider installs its helpers on the object it is
  // given, and the Worker's env outlives this request and this config.
  const checked = await provider.fetch(request, { ...env }, {
    waitUntil() {},
    passThroughOnException() {},
  } as never);
  if (!seen || checked.status !== 204) throw unauthenticated();

  return resolveOAuthCaller(env.BUCKET, props);
}
