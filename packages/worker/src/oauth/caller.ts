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
import type { Bucket } from "../bindings.js";
import { parseKeyRecord, pointerId } from "../auth/caller.js";
import type { Caller } from "../auth/caller.js";
import { ApiError } from "../errors.js";
import { keyHashKey, keyRecordKey } from "../storage/keys.js";

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
