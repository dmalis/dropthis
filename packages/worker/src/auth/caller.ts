/**
 * Who is calling (AGENTS.md, "Auth" — the bearer half of "one key, two
 * presentations").
 *
 * Two computed reads and one constant-time compare:
 *
 *   `Authorization: Bearer <key>` → `sha256(key)` → `keyhash/<hash>` → key id
 *   → `keys/<id>.json` → `{label, scope}`.
 *
 * `keyhash/` is a pointer, not the record, and that is what makes revocation
 * one write: `user remove` deletes it first, so the very next request cannot
 * resolve even though the record still exists for a moment.
 *
 * Every refusal is the same `UNAUTHENTICATED` with the same message. A caller
 * is never told which of the two reads failed: "this key existed once" is
 * information a stranger has no business learning.
 */
import type { Bucket } from "../bindings.js";
import type { CreatedBy } from "../domain/meta.js";
import { ApiError } from "../errors.js";
import { keyHashKey, keyRecordKey } from "../storage/keys.js";
import { hashKey, sameHash } from "./key.js";
import type { KeyRecord, Scope } from "./key.js";

export type Caller = CreatedBy & { scope: Scope };

const BEARER = /^bearer[ \t]+(\S+)$/i;

function unauthenticated(): ApiError {
  return new ApiError("UNAUTHENTICATED", "This instance needs a valid key.");
}

/** The key in the `Authorization` header, or `null` if there is none. */
export function bearerKey(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null) return null;
  const match = BEARER.exec(header.trim());
  return match === null ? null : match[1]!;
}

export async function resolveCaller(request: Request, bucket: Bucket): Promise<Caller> {
  const key = bearerKey(request);
  if (key === null) throw unauthenticated();
  return resolveKey(key, bucket);
}

/**
 * The two reads and the compare for a key that arrived by any route: the
 * bearer header, or pasted into the OAuth authorize page. One function, so
 * the two presentations can never accept different keys.
 */
export async function resolveKey(key: string, bucket: Bucket): Promise<Caller> {
  const hash = await hashKey(key);

  const pointer = await bucket.get(keyHashKey(hash));
  if (pointer === null) throw unauthenticated();
  const id = pointerId(await pointer.text());
  if (id === null) throw unauthenticated();

  const record = await bucket.get(keyRecordKey(id));
  if (record === null) throw unauthenticated();

  const parsed = parseKeyRecord(await record.text());
  if (parsed === null) throw unauthenticated();

  // The compare is against the RECORD's hash, not against the pointer's name:
  // the pointer is only a lookup, and a stale one must not authenticate.
  if (!sameHash(parsed.hash, hash)) throw unauthenticated();

  return { id: parsed.id, label: parsed.label, scope: parsed.scope };
}

/**
 * The id a `keyhash/` pointer names. `init` writes it as JSON (`{"id": …}`)
 * through the R2 API; tolerating a bare id as well costs one branch and means
 * a pointer repaired by hand still works.
 */
export function pointerId(body: string): string | null {
  const text = body.trim();
  if (text.length === 0) return null;
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as { id?: unknown };
      return typeof parsed.id === "string" && parsed.id.length > 0 ? parsed.id : null;
    } catch {
      return null;
    }
  }
  return text;
}

/** A key record, or `null` if it is not one this Worker can authenticate. */
export function parseKeyRecord(body: string): KeyRecord | null {
  let parsed: Partial<KeyRecord>;
  try {
    parsed = JSON.parse(body) as Partial<KeyRecord>;
  } catch {
    return null;
  }
  if (typeof parsed.id !== "string" || parsed.id.length === 0) return null;
  if (typeof parsed.label !== "string" || parsed.label.length === 0) return null;
  if (typeof parsed.hash !== "string" || parsed.hash.length === 0) return null;
  // An unrecognised scope is refused rather than downgraded: a record written
  // by a NEWER instance may mean more than this Worker understands, and
  // guessing "user" would be a silent grant.
  if (parsed.scope !== "admin" && parsed.scope !== "user") return null;
  return {
    id: parsed.id,
    label: parsed.label,
    scope: parsed.scope,
    hash: parsed.hash,
    created: typeof parsed.created === "string" ? parsed.created : "",
  };
}

/**
 * The scope gate. `admin` is a superset of `user` — the operator's own key
 * publishes drops — so only "user key, admin operation" is refused.
 */
export function requireScope(caller: Caller, required: Scope): void {
  if (required === "admin" && caller.scope !== "admin") {
    throw new ApiError(
      "FORBIDDEN_SCOPE",
      "This operation needs the admin key of this instance.",
    );
  }
}

/**
 * What gets written into a drop as `created_by` — the id and the label, never
 * the scope. Attribution is a snapshot of who made it, not a permission record:
 * scopes change, and a drop must not carry a stale one forever.
 */
export function attribution(caller: Caller): CreatedBy {
  return { id: caller.id, label: caller.label };
}
