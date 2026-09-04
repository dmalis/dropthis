/**
 * `meta.json` — the only truth about a drop — and the one `Drop` shape every
 * surface returns (AGENTS.md, "Key layout" and "Responses").
 *
 * Two hashes are computed here and nowhere else:
 *
 *   `current_gen`  the sha256 of the canonical manifest. Identical content
 *                  yields the same generation id, which is what makes an
 *                  unchanged file free to re-publish.
 *   `state_hash`   the sha256 of the whole desired `meta.json` minus `updated`.
 *                  A retry compares against this, not against `current_gen`:
 *                  the same files with a different title are a different state.
 *
 * Canonicalisation is RFC 8785 (JCS), which sorts object keys and leaves array
 * order alone. It does NOT normalise strings — paths and titles are already NFC
 * by the time they get here, at input validation.
 */
import canonicalizeModule from "canonicalize";
import { contentTypeForPath } from "./content-type.js";
import { dropState } from "./expiry.js";
import type { DropState } from "./expiry.js";
import { dropUrl } from "./target.js";

/** The published `meta.json` version. Readers tolerate older ones forever. */
export const META_SCHEMA = 1;

export type ManifestEntry = {
  sha256: string;
  size: number;
  content_type: string;
};

/** `path → entry`, in the order the caller sent the files. */
export type Manifest = Record<string, ManifestEntry>;

export type CreatedBy = { id: string; label: string };

export type DropMeta = {
  schema: number;
  id: string;
  slug: string;
  title: string | null;
  meta: Record<string, unknown>;
  access: Record<string, unknown>;
  current_gen: string;
  manifest: Manifest;
  expires_at: string | null;
  noindex: boolean;
  created_by: CreatedBy;
  created: string;
  updated: string;
};

export type DropFile = {
  path: string;
  size: number;
  sha256: string;
  content_type: string;
};

export type Drop = {
  url: string;
  slug: string;
  title: string | null;
  meta?: Record<string, unknown>;
  created_by: CreatedBy;
  created: string;
  updated: string;
  expires_at: string | null;
  noindex: boolean;
  has_password: boolean;
  state: DropState;
  files?: DropFile[];
  /**
   * The password, in the ONE response that set or generated it, and in an
   * identical idempotent retry of that call. Never from `get` or `list`.
   */
  password?: string;
};

const canonicalize = canonicalizeModule as unknown as (value: unknown) => string;

export function canonicalJson(value: unknown): string {
  return canonicalize(value);
}

const encoder = new TextEncoder();

export async function sha256Hex(input: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const bytes = typeof input === "string" ? encoder.encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The generation id: the digest of the manifest, independent of key order. */
export function manifestGen(manifest: Manifest): Promise<string> {
  return sha256Hex(canonicalJson(manifest));
}

/** The digest of the desired state — everything but `updated`. */
export function stateHash(meta: DropMeta): Promise<string> {
  const { updated: _updated, ...rest } = meta;
  return sha256Hex(canonicalJson(rest));
}

export type NewDropInput = {
  id: string;
  slug: string;
  title: string | null;
  meta: Record<string, unknown>;
  manifest: Manifest;
  expiresAt: string | null;
  noindex: boolean;
  createdBy: CreatedBy;
  /** The unlock rule. `{}` is an open drop; `{password: {…}}` a locked one. */
  access?: Record<string, unknown>;
  now: Date;
  /**
   * The drop's birth instant, when it is already fixed — an idempotent retry
   * reuses the first attempt's `created` so that its `state_hash` and its
   * `list/` key come out identical.
   */
  created?: string;
};

/**
 * A fresh `meta.json`. The key order is fixed because the canonical hash is
 * taken over the object we write, and a reader comparing bytes should see the
 * same document twice.
 */
export async function newDropMeta(input: NewDropInput): Promise<DropMeta> {
  const created = input.created ?? `${input.now.toISOString().slice(0, 19)}Z`;
  return {
    schema: META_SCHEMA,
    id: input.id,
    slug: input.slug,
    title: input.title,
    meta: input.meta,
    access: input.access ?? {},
    current_gen: await manifestGen(input.manifest),
    manifest: input.manifest,
    expires_at: input.expiresAt,
    noindex: input.noindex,
    created_by: input.createdBy,
    created,
    updated: created,
  };
}

/**
 * THE reader of `meta.json` — the one place a stored record becomes a
 * `DropMeta` (AGENTS.md, "Data durability").
 *
 * `JSON.parse(...) as DropMeta` was a promise the type system cannot keep: a
 * record written by another version of this Worker has no reason to carry
 * today's field set, and the cast turned that into `undefined` reaching code
 * that had no idea it could. This does the two things a cast cannot:
 *
 *   - a MISSING field gets the value the product documents. `noindex` defaults
 *     to true because that is the product default and the safe answer; a
 *     manifest entry with no `content_type` is typed from its path, by the same
 *     frozen table that typed it when it was published.
 *   - an UNKNOWN field is CARRIED. "Readers ignore unknown fields" means they
 *     do not act on them — not that they throw them away. A record a newer
 *     Worker wrote must survive being read and rewritten by an older one.
 *
 * `null` is the one refusal: a record with no `id` or no `slug` cannot name its
 * own drop, and a reader that invented one would serve the wrong bytes.
 */
export function parseDropMeta(text: string): DropMeta | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;

  const id = str(record.id);
  const slug = str(record.slug);
  if (id === null || slug === null) return null;

  return {
    // Unknown keys first, so every field this Worker knows wins over them and
    // one it does not know rides along untouched.
    ...record,
    schema: typeof record.schema === "number" ? record.schema : META_SCHEMA,
    id,
    slug,
    title: str(record.title),
    meta: obj(record.meta),
    access: obj(record.access),
    current_gen: str(record.current_gen) ?? "",
    manifest: parseManifest(record.manifest),
    expires_at: str(record.expires_at),
    noindex: typeof record.noindex === "boolean" ? record.noindex : true,
    created_by: parseCreatedBy(record.created_by),
    created: str(record.created) ?? "",
    updated: str(record.updated) ?? str(record.created) ?? "",
  };
}

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

const obj = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

function parseManifest(value: unknown): Manifest {
  const manifest: Manifest = {};
  for (const [path, entry] of Object.entries(obj(value))) {
    const fields = obj(entry);
    const sha256 = str(fields.sha256);
    // No digest, no body to fetch: the entry names nothing this drop holds.
    if (sha256 === null) continue;
    manifest[path] = {
      sha256,
      size: typeof fields.size === "number" ? fields.size : 0,
      content_type: str(fields.content_type) ?? contentTypeForPath(path),
    };
  }
  return manifest;
}

function parseCreatedBy(value: unknown): CreatedBy {
  const fields = obj(value);
  return { id: str(fields.id) ?? "", label: str(fields.label) ?? "" };
}

export function dropFiles(manifest: Manifest): DropFile[] {
  return Object.entries(manifest).map(([path, entry]) => ({
    path,
    size: entry.size,
    sha256: entry.sha256,
    content_type: entry.content_type,
  }));
}

export type ToDropOptions = {
  canonicalUrl: string;
  now: Date;
  /** `list` items carry neither the manifest nor the agent's own `meta`. */
  files?: boolean;
  meta?: boolean;
};

export function toDrop(meta: DropMeta, options: ToDropOptions): Drop {
  const drop: Drop = {
    url: dropUrl(meta.slug, options.canonicalUrl),
    slug: meta.slug,
    title: meta.title,
    ...(options.meta === false ? {} : { meta: meta.meta }),
    created_by: meta.created_by,
    created: meta.created,
    updated: meta.updated,
    expires_at: meta.expires_at,
    noindex: meta.noindex,
    has_password: meta.access.password !== undefined,
    state: dropState(meta.expires_at, options.now),
    ...(options.files === false ? {} : { files: dropFiles(meta.manifest) }),
  };
  return drop;
}

/**
 * `update({meta})` — a top-level merge in which `null` deletes a key
 * (docs/spec-v1.md, "`update` semantics").
 *
 * Top-level is the whole rule: a nested object is replaced, not merged, so an
 * agent can always tell what it will get. `null` deletes only where it appears
 * as a top-level value; inside an object or an array it is ordinary JSON and is
 * stored as it is — `meta` holds any JSON, because the archived product
 * accepted only strings and agents got 422s for it.
 */
export function mergeAgentMeta(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}
