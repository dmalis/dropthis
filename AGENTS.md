# AGENTS.md — how to think about dropthis

This file is for agents and humans working on the code. It says what the product is, what
makes it different, and the rules that keep it small. Prohibitions are listed only where a
principle is not enough. Every decision here has a dated entry with its reason in
`docs/decisions.md`; the evidence is in `docs/research/`.

## What this is

dropthis turns content an agent produced into a permanent URL on Cloudflare the user owns.
The user never sees Cloudflare after setup, never sees a dashboard, and never touches a
server. The whole product is a contract: **one call in, one URL out**, plus the three
policies every drop carries — expiry, password, noindex — and the pruning that follows.

**Agents are the only callers.** A human never runs a command by hand; the human talks to
an agent (Claude Code, claude.ai, Cursor, n8n, a script) and the agent calls dropthis. Every
surface, message and error is written for that agent, and the human sees only what the
agent relays: a URL, a password, a ready-to-send "here is how to connect" message.

It is a new project. A hosted SaaS by the same name preceded it; that codebase and its
published clients are archived and nothing is carried over except lessons, recorded in
`docs/decisions.md` #42 and `docs/research/`. The contract, the CLI and the MCP tools are
designed fresh for agents.

## Principles, in priority order

1. **Least moving parts.** One Worker, one bucket. Every additional binding, service, table
   or build step must be justified against "could a file in the bucket do this?" So far the
   only justified extra is one KV namespace for OAuth sessions.
2. **Files are the database.** One object per entity, never a shared index file. Every hot
   read is a direct `GET` of a key we can compute. `list()` is for the rare "list my drops"
   and for cron, never for lookup.
3. **Agents are the only callers, and they are stateless.** An agent that made a drop five
   days ago remembers nothing. So the URL is the identity, and a drop is its own memory:
   `get(url)` returns everything the agent needs to continue — title, settings, files and
   the agent's own `meta`. Any operation an operator could want exists as REST, CLI and MCP,
   generated from one operation registry so the three can never drift. If a feature needs a
   UI to be understood, it is out of scope.
4. **The contract is invariant.** Responses, URL shapes and tool semantics are the same for
   every install. A golden HTTP corpus replayed against a deployed instance is the proof,
   not code review.
5. **Old drops never die from a schema change.** See "Data durability" below.
6. **Ship small, measure, then add.** v1 is frozen in `docs/decisions.md`. New features
   wait for a real user asking.
7. **Documentation is an API.** Structured `--json` output, stable error codes with a
   remediation field, non-interactive operation, idempotent reruns and generated connection
   instructions are product behaviour, not documentation polish. An agent must be able to
   install, operate and administer an instance with no human reading anything.
8. **Industry standard unless there is a reason.** Where big tools agree (CLI grammar,
   credential env vars, `--json`, exit codes, expiry grace, object shapes) we copy them and
   cite the example. We deviate only when the agent-first lens says so, and we write the
   reason down.

## Architecture

```
/<slug>/*            viewer: resolve slug → drop → serve file (cache, unlock, headers)
/_api/v1/health      unauthenticated liveness `{ok: true}`: init's propagation poll, the
                     after-v1 unclaimed bootstrap's one open route (#71)
/_api/v1/*           REST; bearer key auth
/_api/mcp            MCP over Streamable HTTP; bearer key, or OAuth (workers-oauth-provider)
/_oauth/*            OAuth endpoints + the one authorize page (paste your key)
/_connect            static page: how to connect this instance (URL pre-filled)
/_skill.md           this instance's agent skill (`skills/instance-skill.md`, bundled as a
                     text module), base URL, live policy and the tool text substituted
cron (hourly)        expire + prune, resumable
```

Bindings: `BUCKET` (R2), `OAUTH_KV` (KV), one secret `HMAC_SECRET`. The admin key is an
ordinary key record written into the bucket by the installer before the first deploy — there
is no admin secret and no live-but-unusable window.
The repo's `wrangler.jsonc` declares bindings by name with no IDs (for the Deploy-button
path after v1, where Wrangler auto-provisions; whether TOML also gets ids written back is
unverified — see `docs/research/2026-09-01-cli-conventions.md`). `init` does not deploy
from it: it reconciles the bucket and the KV namespace by name through the Cloudflare API,
renders a per-instance config with the bucket name and the KV **id** filled in (an existing
KV namespace cannot be bound by name, and id-less provisioning would create a second one),
and deploys from that.

### Key layout (the real schema — never renamed)

```
drops/<id>/meta.json                 the ONLY truth: schema, id, slug, title, meta, access,
                                     current_gen, manifest, expires_at, noindex, created_by
                                     {id,label}, created, updated
drops/<id>/blobs/<sha256>            file bodies, content-addressed per drop. A generation is the
                                     manifest inside meta.json (path → {sha256, size, content_type});
                                     <gen> = sha256 of that manifest. Unchanged files are never
                                     re-uploaded or copied (the R2 binding has no copy); an update
                                     writes new blobs + one meta.json CAS; unreferenced blobs are
                                     deleted after the flip and by the reconcile
slugs/<slug>                         pointer → id, claimed with If-None-Match: * BEFORE meta.json
                                     exists; every lookup is a direct GET of this key. A staged
                                     publish marks it {pending_upload, expires}; the reconcile
                                     removes a meta-less pointer only when no live session owns it
list/<inv-created-ms>-<slug>         listing pointer; the ms come from the drop id (a ULID), not
                                     from `created` — `created` is RFC 3339 at SECOND precision, so
                                     a batch published inside one second would sort by its random
                                     slug. customMetadata (strings only) {id, created, updated,
                                     expires_at, title, noindex, has_password, created_by_id,
                                     created_by_label} — every field of the listing row, so a page
                                     costs ONE list() and no meta.json reads; state is derived at
                                     list time. R2 lists keys in order, so ONE list() over this
                                     prefix is newest-first with a cursor. A pointer is deleted by
                                     a reader only on PROOF its record is gone (it names an id and
                                     the id has no meta.json); one this reader cannot interpret is
                                     skipped, never destroyed
keys/<id>.json                       {id, label, scope, hash, created}; the admin key is one of these
keyhash/<sha256(key)>                pointer → key id (the auth lookup)
users/<normalized-label>             pointer → key id, claimed with If-None-Match: * → labels unique
expiring/<yyyy-mm-dd>/<id>           marker for the hourly cron, dated expires_at + grace;
                                     the cron walks these KEYS in order (R2 key order IS date
                                     order), so empty days cost nothing and no day is ever
                                     listed on its own; a HINT — cron re-reads meta.json
requests/<hash>/claim, …/result     idempotency: two keys, each written ONCE (1 write/s per key).
                                     The claim fixes the identity {drop_id, slug, gen, generated
                                     password (encrypted)} BEFORE side effects, so retries converge;
                                     result put at the end, AES-GCM-encrypted (key via HKDF from
                                     HMAC_SECRET); lifecycle 7 days
uploads/<id>/session.json, commit,   staged-upload session (CLI and MCP): three write-once keys
  result                             (session at creation; commit = fenced claim with payload +
                                     state hash; result = encrypted Drop); lifecycle 1 day. Staged
                                     PUTs write blobs straight to drops/<id>/blobs/ — nothing is ever
                                     copied; abandoned blobs are unreferenced, the reconcile removes them
system/config.json                   policy (defaults + rules) + canonical_url + alias_origins + instance_name
system/prune-state.json              cron cursors: oldest pending expiry date, reconcile cursor
hosts/<hostname>                     pointer → id   (root drop for a hostname; after v1)
system/claim-code                    one-time code for the unclaimed-install flow (after v1)
```

No counters are stored anywhere: R2 has no atomic increment, and a read-modify-write counter
corrupts itself the first time two requests race. `usage` computes from `list()` on demand.

- **Updates are a generation flip; `meta.json` is the only truth.** Write order: (0) resolve
  content first — decode inline entries, fetch `url` entries, write new blobs under
  `drops/<id>/blobs/<sha256>` (unreachable until referenced; one R2 op per new file, none
  for unchanged; R2 verifies the hash via its `sha256` put option, the Worker never hashes
  streamed bodies) and compute the manifest; (1) put the idempotency claim (identity: drop
  id, slug, gen, manifest, `state_hash` of the whole desired `meta.json`, `created`,
  the resolved `expires_at`, generated
  password) if a key was given — a retry that finds the claim resumes with that identity,
  re-fetching a missing `url` blob only if its hash still matches. **The claim fixes every
  clock-derived value, not only the id and the slug** (#74): `"30d"` resolved a second later
  is a different instant, so a retry that re-resolved it would build a different desired
  state and turn convergence into `UPDATE_CONFLICT`; (2) on publish, claim
  `slugs/<slug>` (a pointer already holding this id counts); (4) compare-and-swap
  `meta.json` (`If-Match: <etag>`; `If-None-Match: *` on create; a CAS failure where the
  stored `meta.json` hashes to the claim's `state_hash` is success — `current_gen` alone
  proves nothing about settings; on failure during a fresh publish, delete the slug claim); (5) write `list/` and `expiring/` (a changed expiry
  writes the new marker and deletes the old one); (6) put the idempotency result; (7) delete unreferenced blobs with one batched `delete()`.
  Fault-injection tests abort after each step and assert the retry converges. Half-uploaded state is never served. Equality for the no-op rule
  is canonical `meta.json` minus `updated`. `slugs/` is never repaired lazily — it exists
  before `meta.json` by construction; a pointer with no `meta.json` is 404 and the reconcile
  removes it. `list/` and `expiring/` are repaired both ways: an entry without `meta.json`
  is deleted by whoever reads it; a missing or stale entry (compared on `updated`) is
  repaired by the next `get`/`update` and by the reconcile. A CAS failure is `409
  UPDATE_CONFLICT` (retryable).
- **Idempotency is explicit.** `publish`, `update` and `user add` accept `idempotency_key`
  (Stripe pattern). The claim is put with `If-None-Match: *` before any side effect and
  carries the identity, so concurrent or later retries converge on one outcome; an
  identical retry returns the stored, encrypted-at-rest result; a different payload under
  the same key is `409 IDEMPOTENCY_MISMATCH`. "A generated password is returned once" means: to the
  original call and to identical retries under the same key within 7 days, never from `get`
  or `list`. `password: "generate"` without a key is documented as non-idempotent. A generated
  slug that loses its claim is simply generated again, so only a CHOSEN slug can be
  `409 SLUG_TAKEN` (#94); the skill tells agents to `update`, not re-publish. The chosen
  slug is part of the payload hash, so the same key with a different slug is
  `IDEMPOTENCY_MISMATCH`.
- **The viewer never trusts a cache for truth.** Every viewer response first reads the slug
  pointer and `meta.json` (R2 is strongly consistent), checks expiry, then the unlock cookie
  when a password is set — and only then may it resolve `path → sha256` through the manifest
  and look up the body in the Cache API under a synthetic `{id, sha256}` key that no request
  URL can address. Protected bodies
  may therefore be cached (amends #23): the cache sits behind the check, never in front of
  it. Browsers get `Cache-Control: no-cache, must-revalidate`, so an update or an expiry is
  visible on the next request.
- **One call uploads a drop.** `publish` and `update` take `files: [{path, text} | {path,
  base64, sha256?} | {path, url, sha256?, size?}]` — exactly one of the three per entry, never
  guessed from the bytes. A base64 entry may carry its own digest; a mismatch is
  `HASH_MISMATCH` and nothing is stored (the CLI always sends it, #85). A `url` entry with a digest streams to R2 (R2 verifies, no Worker
  CPU, up to `max_file_bytes`); without one the Worker must hash in-stream, so it is capped
  by `max_unhashed_bytes` (2 MB default) — the CLI always sends digests. Limits come from the Free subrequest budget (50 external, 1,000 internal; R2
  binding calls are internal): ≤ 500 files per call; `url` entries ≤ 20 per call and
  fetches including redirects ≤ 45, ≤ 3 redirects followed manually and re-validated,
  `http`/`https` on 80/443 only, no loopback/link-local/private/metadata targets,
  `global_fetch_strictly_public` on, size ≤ `max_file_bytes`, 20 s each. Paths: relative,
  `/`-separated, NFC, no `.`/`..` segments, no backslash or control characters, unique after
  normalisation. Content type from a frozen extension table (`application/octet-stream`
  fallback); text-typed = `text/*`, JSON, JavaScript, XML, SVG and `+json`/`+xml` types. The
  single-call ceiling is policy `max_request_bytes` — **4 MiB by default, measured**
  (`docs/research/2026-09-03-free-plan-measurements.md`): inline entries are JSON-parsed,
  base64-decoded and hashed by the Worker, and on the Free plan 4 MiB passes 10/10 at
  254 ms median with 6 and 8 MiB passing above it. That holds only with
  `Uint8Array.fromBase64`; with the portable `atob` loop the same size passed 2/10, so
  `publish` decodes natively. Free's CPU allowance refills rather than capping each
  request, so the failure (Cloudflare error 1102) is load-dependent, not a clean size
  ceiling — the measurement shuffles sizes to keep the two apart. `url` and staged
  entries stream to R2 with R2 verifying the hash and cost almost no CPU. `/_skill.md`
  prints the current value and says: text inline, files by `url`, `dropthis_upload` + `curl`
  for the rest. Above it **the CLI, and any MCP agent whose environment can run `curl`** — use
  `POST /_api/v1/uploads` (`{target?, manifest: [{path, size, sha256}], idempotency_key?}`
  → `{upload_id, drop_id, slug, missing, put_urls, expires}`: drop id and slug allocated
  and the slug claimed now — pointer body = the id, `customMetadata {pending_upload,
  expires}` — or, with `target`, the drop's `meta.json` etag fixed; content types from the
  frozen table; a rerun under the same key returns the same session with a fresh `missing`)
  → streamed `PUT` per missing blob **straight to `drops/<id>/blobs/<sha256>`** through an
  HMAC-signed 1-hour URL that is the PUT's only credential (registry scope `signed`,
  `rawBody`), `Content-Length` checked against the manifest and the digest verified by R2 —
  either wrong is `HASH_MISMATCH` and the key stays absent → `POST
  /_api/v1/uploads/<id>/commit` (carries the settings — `title?, meta?, password?, expires?,
  noindex?` — exactly as `publish`/`update` take them, so a drop too large for one call is
  not one the instance's password policy cannot reach; fenced by the write-once `commit` claim that
  fixes `payload_hash`, `state_hash`, `created` and `expires_at` (#74); verifies every blob
  exists, naming the missing hashes as `INVALID_INPUT`; then steps (4)–(7) of the write
  order, an update CASing against the session's etag; replays the sealed `result` on
  repeat; a different payload is `IDEMPOTENCY_MISMATCH`, another key `FORBIDDEN_SCOPE`,
  a session past its day or unknown `UPLOAD_EXPIRED`). Nothing is ever copied. Of the three
  routes only the blob PUT is `restOnly` — its credential is the HMAC in its own URL, so an
  agent curls it rather than calling it; the session and the commit are also MCP tools,
  `dropthis_upload` and `dropthis_commit` (user scope), because a browser agent that cannot
  type a photo as base64 can still `curl -T` it (#93, superseding the `restOnly` half of #85).
- **R2 write rate.** Measured against remote R2 (`docs/research/2026-09-03-free-plan-measurements.md`):
  writes to one key that are **in flight at once** are refused with
  `Reduce your concurrent request rate for the same object. (10058)` — roughly half of ten
  concurrent writes fail — while five writes issued one after another at full speed all
  succeed. `meta.json` and `slugs/<slug>` are single keys; a refused write returns `429`
  `R2_RATE_LIMIT` with `Retry-After: 1` and is never retried inside the Worker. Serialising through a Durable Object was considered
  and rejected — one drop updated twice a second is not the product.
- **R2 facts this relies on** (evidence in `docs/research/`): strong global consistency for
  reads and `list()`; conditional `put` via `onlyIf` (`If-None-Match: *`, `If-Match`) —
  **proven against remote R2** by `contract-tests/storage.test.ts`, which also pins that a
  digest R2 rejects leaves the key absent; a per-key concurrent-write refusal; delete is
  free; `list()` costs an order of magnitude more than a GET. Never assert R2 behaviour from
  Miniflare — it has shipped reversed condition logic.

### The drop model

- **Slug = identity = URL.** Generated unless the caller chose one, immutable either way.
  A generated slug is 10 characters from `a-z0-9`; a chosen one (`publish({slug})`, #94) is
  3-40 characters of `a-z0-9-` starting with a letter or digit, lower-cased and NFC-normalised
  before validation, never a reserved prefix. One predicate (`domain/slug.ts`, `isSlug`)
  answers "could a drop live at this path segment?" for routing, the viewer and targets; the
  generated form is a subset of the chosen one, and nothing ever has to tell them apart.
  `get`, `update` and `delete` accept the slug or a URL whose origin is this
  instance's `canonical_url` or one of its `alias_origins`; any other origin is
  `WRONG_INSTANCE`. Rename is a non-goal: a URL is permanent.
- **One canonical origin.** `init` stores `canonical_url` (the custom domain, else the
  `*.workers.dev` URL) and `alias_origins`. Drop URLs, OAuth issuer/resource/discovery and
  `/_skill.md` use the canonical origin; viewer requests on an alias redirect (301) to it.
- **`title`** — short (≤ 200 bytes UTF-8), optional, human-readable. In `list`, on the
  auto-index page, on the password page. The skill tells agents to always set it.
- **`meta`** — a JSON object the agent owns (≤ 16 KB): what the drop is, where the source
  data came from, which workflow made it, who it was sent to. Stored verbatim in
  `meta.json`, returned by `get`, never in `list`. `update({meta})` merges at the top level;
  a key set to `null` is removed. Values are any JSON — the old product advertised JSON and
  rejected non-strings, and agents got 422s.
- **`access`** — the unlock rule. Today `access.password = {algorithm: "pbkdf2-sha256",
  iterations, salt, hash, version, nonce}`. It is an object, not a bare field, so a paid
  unlock (`{price, currency, …}`) can be added later without touching the layout; that door
  is deliberately open and deliberately empty (#54).
- **Expiry.** `expires: "7d" | "2026-12-31" (= `T00:00:00Z`) | RFC 3339 | "never"`; default
  from policy (30 days); policy `max` and `allow_never` enforced; a past value is
  `POLICY_VIOLATION` (so no marker ever lands behind the cron cursor); stored as RFC 3339
  `expires_at` (`null` = never).
  Four states, one table (tests cover every row):

  | state | condition | viewer | `get` | `update` | `list` | cron |
  |---|---|---|---|---|---|---|
  | `live` | before `expires_at` | serves | 200 | ok | shown | — |
  | `expired_grace` | `expires_at ≤ now < expires_at + 7d` | 410 | 200 + `state` | only with a future `expires`, else `409 EXPIRED_NEEDS_EXPIRES` | shown + `state` | — |
  | `expired_final` | `now ≥ expires_at + 7d`, not pruned | 410 | `410 EXPIRED_FINAL` | `410 EXPIRED_FINAL` | hidden | deletes |
  | deleted | pruned or `delete` | 404 | `404 NOT_FOUND` | `404 NOT_FOUND` | hidden | — |

  "The link died, bring it back" is one call inside grace. Markers are hints: cron re-reads
  `meta.json` and deletes only if `expires_at + grace ≤ now`.
- **Password.** `password: "generate"` returns a 16-character random password once in the
  response — the agent's default, the skill says so. A chosen password needs ≥ 8 characters.
  Stored as PBKDF2-SHA256 at policy `pbkdf2_iterations` (**25,000 by default, measured**:
  6.1 ms per derive on Free, the highest count inside the 8 ms unlock budget — 50,000 costs
  12.5 ms and workerd refuses 200,000 outright; `doctor`'s `pbkdf2_benchmark` times 8 derives
  inside a bracket closed by an R2 read, minus the same bracket with no derives, best of two —
  and on Cloudflare it answers `inconclusive`, because a Worker's clock advances by what its
  I/O cost and NEVER by the CPU burned before it, so a derive cannot be timed from inside the
  request that runs it (#16, pinned by `contract-tests/worker-clock.test.ts`). Only a
  subrequest that spends the CPU in ANOTHER request makes it visible; whether `doctor` should
  pay a network round trip for that is open. Until then the reference measurement, not the
  instance, is what an operator raises `pbkdf2_iterations` against). Unlock = an HMAC cookie
  signed over `{slug, nonce, expires_at}`: host-only, `Secure`, `HttpOnly`,
  `SameSite=Lax`, `Path=/<slug>/`. `nonce` rotates only when effective access changes (new, generated or removed password;
  re-sending the current password is a no-op), so a real change invalidates every cookie. No attempt rate limiting in v1; `SECURITY.md`
  says so plainly. `password: null` removes it.
- **`noindex`** on by default: `X-Robots-Tag: noindex, nofollow` on every response.
- **`created_by`** — `{id, label}` of the key that made the drop, a snapshot. Attribution,
  not a wall.
- **Serving matrix.** Single-file drop: the file at `/<slug>/` and at `/<slug>/<path>`.
  Folder drop: `/<slug>/` from `index.html` when present, else the generated list
  (`auto_index: list`); `/<slug>/<dir>/` from `<dir>/index.html` when present, else 404;
  missing paths 404. `Content-Disposition: inline` by default, `?download=1` for attachment.

### Responses and errors

- One `Drop` shape from `publish`, `update`, `get` and each `list` item: `url, slug, title,
  created_by, created, updated, expires_at, noindex, has_password, state`; `files[]`
  (`path, size, sha256, content_type`) on `get`/`publish`/`update`; `meta` everywhere except
  `list`. `password` appears once, only in the response that set or generated it. Same
  shape in REST, CLI `--json` and MCP.
- `get(target, files: true)` adds `content` to text-typed files up to 1 MB total in manifest
  order, password or not; binaries and anything past the budget carry `download_url`
  (`GET /_api/v1/drops/<slug>/files/<encoded-path>`, bearer auth, Range). Pull → edit →
  `update` needs no local state.
- Errors: one object `{code, message, remediation, retryable}` from a frozen catalogue, on the
  wire as REST `{error: {…}}`, MCP `isError: true` with that object, CLI `--json` the same
  object on stderr — (`INVALID_INPUT`,
  `INVALID_PATH`, `POLICY_VIOLATION`, `UNAUTHENTICATED`, `FORBIDDEN_SCOPE`, `NOT_FOUND`,
  `WRONG_INSTANCE`, `EXPIRED_NEEDS_EXPIRES`, `UPDATE_CONFLICT`, `IDEMPOTENCY_MISMATCH`,
  `LABEL_TAKEN`, `SLUG_TAKEN`, `NAME_TAKEN`, `EXPIRED_FINAL`, `UPLOAD_EXPIRED`,
  `PAYLOAD_TOO_LARGE`, `HASH_MISMATCH`, `FETCH_FAILED`, `R2_RATE_LIMIT` with `Retry-After`,
  `INTERNAL`), each with HTTP status and retryability. The remediation is the
  only hint dropthis ever sends, and only off-path. No `next` hints on success: the URL is
  the id, there is nothing to re-teach, and every sentence costs context on every call.
- `list`: one R2 `list()` over `list/` per page (≤ 1,000, key order = newest-first), cursor,
  `has_more`, optional `q` = substring over `title` after NFC normalisation and Unicode case
  folding, applied within the page — a page can be empty while `has_more` is true, and the
  skill says so. No search index.

### Auth

- **One key, two presentations, never a third.** The key travels as `Authorization: Bearer`
  from anything without a browser (CLI, SDK, CI, Agent SDK, Claude Code and Cursor via
  `.mcp.json`) and is typed into one OAuth page by browser clients that cannot send headers
  (claude.ai, Claude desktop). Behind both is the same `sha256(key)` lookup, the same
  identity, the same one-call revocation. On `/_api/mcp`: header if present, else OAuth.
  Key-in-URL (`/_api/mcp/<key>`) was rejected: secrets in URLs fail security reviews,
  connector directories require OAuth, and non-technical users paste URLs into chat.
- Keys are 32 random bytes, shown once, stored as `sha256(key)`; compared with
  `crypto.subtle.timingSafeEqual`. No slow KDF: keys are high-entropy, and the Free plan's
  CPU budget per request is tiny (workerd also caps PBKDF2 iterations).
- Two scopes: `admin` (all tools) and `user` (drop tools). MCP filters its tool list by the
  caller's scope so a user's context carries seven tools.
- OAuth on `/_api/mcp` exists only because claude.ai and the Claude desktop app add MCP
  servers as connectors that speak OAuth and cannot send static headers. The authorize page
  is one form — *paste your dropthis key* — so identity stays "the key". Revoking the key
  ends every session behind it: every OAuth token resolves to a key id and is checked
  against `keys/<id>.json` on each request. `@cloudflare/workers-oauth-provider` does the
  protocol; a recorded spike against a real claude.ai connector is **phase zero** — it runs
  before any OAuth code lands (issue #12) and gates the auth contract; storage and bearer
  slices proceed in parallel with it, and if it fails the auth contract is revised before
  #12 starts (#71). On
  claude.ai Team/Enterprise only an Owner can add a custom connector; members then
  log in with their own key — onboarding messages say so.
- Cloudflare Access was evaluated and rejected as the auth layer (50 service-token cap,
  two-header scheme browser clients cannot send, no per-user identity on tokens).

### Team model

**Instance = team.** Every `user` key sees and edits every drop in the instance; `created_by`
records who made it. Labels are unique per instance on their normalized form (NFKC → case
fold → trim → whitespace to `-`, must match `^[a-z0-9][a-z0-9._-]{0,62}$`; one function in
the registry, every surface uses it); `LABEL_TAKEN` otherwise; a removed label can be
reused and gets a new key id. `user add`: key record → `keyhash/` → label claim (undo on
clash). `user remove <label>`: delete `keyhash/` first (access ends), then the record, then
the label; every step tolerates 404 so a rerun finishes it. An agent handed a colleague's URL never hits a permission wall
inside its own team; a wall is a second instance. The admin key is a key record with label
`admin` — one listing, rotation and revocation path for every credential. There is no
per-key ownership, no roles beyond `admin`/`user`, no workspaces.

### Instance policy (`system/config.json`)

Two layers: *defaults* applied when the caller says nothing, *rules* enforced regardless.
Example: `expiry: {default: "30d", max: "90d", allow_never: false}`,
`password: {default: "generate", required: true}`, `noindex: {default: true, forced: true}`,
`max_file_bytes` (≤ 100 MB, the request-body cap), `max_request_bytes` (4 MiB by default,
hard ceiling ≤ 64 MB encoded so the decoded body fits the isolate), `auto_index`
(`list` only in v1),
`pbkdf2_iterations`, `cron_ops_budget`; `config set` rejects values above the hard
ceilings. `init` writes frozen Free-safe initial values; nothing is measured during `init`. **Prospective only:** `config set`
changes what future calls resolve to: defaults fill omitted fields on `publish` only, rules
are enforced on the fields a call provides, and an existing drop's omitted, now
non-compliant field is grandfathered until the caller next sets it. The response says so. dropthis itself never sends messages; password
delivery is the caller's job — the agent hands the human a ready-to-send message. Policy is
per instance; two groups with different rules get two instances.

### Multi-client hosting

**Instance = client = team.** No tenant concept. Isolation comes from the bucket and Worker
boundary: a key from instance A does not exist in instance B's `keys/`. An operator hosts
many clients on one Cloudflare account (`npx dropthis init --name client-x` per client) and
holds every instance's admin key in their own `~/.config/dropthis/instances.json`; or a
client runs it on their own account with their own token. Same command, different token.
`--name` is optional and defaults to `main` (most accounts hold one instance; a rerun
without a name reconciles `main` and says "pass `--name <other>` for a separate instance" —
a second instance always needs an explicit name, never an invented one, #69).
`init --name <name>` derives every resource from the normalised name (`[a-z0-9-]`, 3–30):
Worker `dropthis-<name>`, bucket `dropthis-<name>-drops`, KV `dropthis-<name>-oauth`;
reruns reconcile by these names, a clash with another instance is `NAME_TAKEN`. Five cron
triggers per account on the Free plan means the sixth instance needs Workers Paid.
If cross-client reporting is ever needed, `tenant` is one more field in `meta.json`;
tolerant readers already handle it.

### Data durability

- `meta.json` carries `schema: <n>`. Readers ignore unknown fields and default missing
  ones, so a newer Worker serves an older drop unchanged.
- Upgrades are lazy read-repair: a drop is rewritten to the current schema only when it is
  next updated. There is no migration job.
- The contract tests keep one fixture per historical schema version, forever.
- The bucket is plain files and S3-compatible: `rclone sync` copies an entire instance. The
  same layout on a disk is a filesystem adapter, so leaving Cloudflare is a storage-shell
  swap, not a data migration.

### Pruning

Three kinds of garbage, three mechanisms: expired drops (after grace) → daily cron;
abandoned uploads → R2 lifecycle rules on `uploads/` (1 day) and `requests/` (7 days), set
once by the installer, plus abort-incomplete-multipart, and unreferenced blobs older than a
day removed by the reconcile; orphaned generations and stale
projections → weekly reconcile in the same cron. **The cron is hourly and resumable.**
`system/prune-state.json` holds `oldest_pending_date`, a per-day cursor and a reconcile
cursor and is written once per invocation, at the end (one key, one write); every run works
from the oldest pending date up to today (UTC), re-reads each `meta.json`, leaves
not-yet-due entries in place, deletes markers that disagree with `meta.json`, never
checkpoints past a day that is not yet over, stops at policy `cron_ops_budget` (40 R2 ops by
default — derived from the Free plan's 50-subrequest limit with headroom, ≈ 8 drops per run,
≈ 190 per day; still provisional, the cron has no code yet). A crash before the checkpoint replays
harmlessly next hour (every step re-reads `meta.json`; a deleted drop reads as 404) — a
missed run is caught up, never stranded. Every 7th day the budget goes to the reconcile:
unreferenced blobs, orphan pointers and entries, missing entries. `prune --dry-run` and `usage` share one result shape: counts and bytes per
`live | expired_grace | expired_final | staging | orphan`, plus `incomplete` + cursor when
the budget ran out.

## Operation registry

Every operation is defined once (name, input schema, scope, description) and generates the
REST route, the CLI subcommand and the MCP tool (the reference-docs generator comes after
v1). Adding an operation
means adding one entry.

**Drop operations (user scope), exactly five — plus the two staged-upload steps below:**

| op        | does                                                                                   |
|-----------|----------------------------------------------------------------------------------------|
| `publish` | create: `files`, `title?`, `meta?`, `password?`, `expires?`, `noindex?`, `slug?`, `idempotency_key?` → `Drop` + URL. Always a new drop; the slug is generated unless `slug` chose one (`SLUG_TAKEN` if it is held). A retry with the same `idempotency_key` returns the same drop. |
| `update`  | change only what is given: `files?` (replaces the whole set, one new generation), `title?`, `meta?` (merge), `password?` (`"…"`, `"generate"`, `null`), `expires?`, `noindex?`, `idempotency_key?`. Same resulting state = no-op. |
| `get`     | by slug or URL; `files: true` adds content. Replaces the old `resolve` and `get_content`. |
| `list`    | one page of `Drop`s, newest-first, `cursor`, `limit`, `q` → `{drops, cursor, has_more}`. |
| `delete`  | immediate, files and pointers.                                                          |

The staged-upload path adds `upload.create` and `upload.commit` to the same user scope, named
`dropthis_upload` and `dropthis_commit` as tools (#93). They are the same publish, split so the
bytes travel outside the call: manifest in, one signed PUT URL per missing blob out, then the
settings. The blob PUT itself is REST-only and signed.

**Admin operations (admin scope, instance key):** `user add|list|remove`, `config get|set`,
`usage`, `prune [--dry-run]`, `doctor`. `user add` returns the key once together with a
structured `connect` object (per-client MCP snippets and a ready-to-send message) so
onboarding a person is one call. `doctor` is a named check registry (#29), instance key only:
`hello_drop`, `mcp_initialize`, `policy_readable`, `cron_state`, `canonical_origin`,
`pbkdf2_benchmark`, `admin_rotation_clean`; `doctor --list --json` lists ids, `doctor
--json` returns `{ok, checks: [{id, status: pass|fail|skip|inconclusive, evidence,
remediation}]}` (`inconclusive` never makes `ok` false). Account-level checks
(`lifecycle_rules`, `kv_bound`, `domain_attached`) belong to `init --check`, which needs the
Cloudflare token. `host_*` comes after v1.

**Instance lifecycle** lives in the CLI only — it needs the Cloudflare token, not an instance
key: `init` (account preflight, provisioning, deploy; `--dry-run` = preflight only) and
`connect` in v1; `upgrade` with the first release after v1; `destroy`, `claim` later. MCP
tool names carry the `dropthis_` prefix so they stay distinct when an agent has several
servers connected.

### CLI conventions (industry standard; evidence in `docs/research/2026-09-01-cli-conventions.md`)

- **One package, one binary, bare name:** `dropthis` on npm. Installer, client and stdio
  MCP proxy (`dropthis mcp`) are subcommands of the same binary — sst, convex, flyctl,
  railway, pocketbase do the same; no version skew between installer and client.
- **Grammar:** bare verbs for the hot path — `init`, `publish`, `update`, `get`, `list`,
  `delete`, `doctor`, `connect` — and `noun verb` for administration — `user add`,
  `config set`, `usage`, `prune`.
- **Two credentials, two env names, env beats file:** `CLOUDFLARE_API_TOKEN` (+
  `CLOUDFLARE_ACCOUNT_ID`) for `init` only (automation; an interactive human may
  browser-login instead, #67); `DROPTHIS_URL` + `DROPTHIS_KEY` for everything
  else, `doctor` included. `init` writes `~/.config/dropthis/instances.json`
  (`{default?: name, instances: {name: {url, key}}}`, under `$XDG_CONFIG_HOME` when set);
  `default` names the instance used when nothing selects one — an only instance is the
  default by itself — and `--instance <name>` / `DROPTHIS_INSTANCE` select, the env pair
  overrides all of it (CI, n8n) and must be complete (one half alone is an error naming
  the other). An unknown instance name errors with the known names; no credentials at all
  exits 4 naming both variables. A drop URL given as a target must be on the configured
  instance's origin, else `WRONG_INSTANCE` (the CLI knows no aliases, #85).
- **`connect [--instance x] --client claude-code|cursor|codex|claude-ai --json`** applies
  the per-client registration with the key in neither argv nor any config file: Claude Code
  gets a `headersHelper` (`dropthis auth-header --instance x` reads `instances.json`);
  Cursor and Codex get a reference to `DROPTHIS_KEY_<NAME>` plus the one-line export to add
  to the shell profile; claude.ai gets the connector URL and the paste-key message.
- **Non-interactive by default** when stdin or stdout is not a TTY or an agent is detected
  (Vercel's `@vercel/detect-agent` pattern); `--yes` is the explicit form; never a prompt an
  agent can hang on — a non-interactive run proceeds as if every question were answered
  yes. The only prompts are `delete` and `prune --no-dry-run`; they write to stderr, and
  "no", Ctrl-C or SIGINT exit 2. `DROPTHIS_INTERACTIVE=1|0` forces prompts on or off (as
  `GH_FORCE_TTY`), which is how the prompt path is tested through a pipe. Secrets via env or
  stdin, never flags: a drop's `password` takes only `generate` on the command line, and a
  chosen one arrives through `--password-stdin` (Docker's `--password-stdin`), so it is in
  neither the shell history nor `ps` (#85m). Boolean flags map 1:1 to the schema and are
  never inverted by the CLI: `prune` is a dry run unless `--no-dry-run` (#78d holds on
  every surface).
- **Output contract:** `--json` = exactly one deterministic JSON document, always (for
  `init`, a result object with a `steps[]` array); `--jsonl` streams live step events where
  a command has them (`init`; `usage` and `prune`, which follow the scan cursor to the end,
  one object per call, and end with the summed report `--json` prints; elsewhere it equals
  `--json`); stdout carries the result (on `publish` and `update`, only the URL; on `delete`,
  nothing — `--json` gives `{slug, deleted: true}`), stderr everything else; errors are the
  frozen object on stderr, as JSON under `--json`; exit codes documented: `0` ok, `1`
  failure, `2` cancelled, `4` auth required (as `gh`). `dropthis commands --json` lists the
  surface: every command with its arguments and typed options, generated from the registry
  (`user add <label>` and `config set <json>` are the two positional body fields).
- **`npx dropthis@latest` only on the one-shot `init` line**; pinned afterwards.

### Installer principles (learned from 15 Cloudflare-hosted projects, `docs/research/`)

- **Two credential modes, one rule: never guess the account.** Automation (agents, CI,
  n8n) sets `CLOUDFLARE_API_TOKEN` (+ `CLOUDFLARE_ACCOUNT_ID`); an env token always wins.
  An interactive human with no token gets browser login instead (wrangler's OAuth, one
  Allow click) — allowed only when exactly one account is visible; more than one → stop
  and ask for `--account-id` or a token (#67). Whichever credential is active is pinned
  into wrangler's environment so a deploy cannot land in the wrong account, and `init`
  prints which source it came from. Non-interactive with no token exits 4 with the exact
  token URL and the four permissions in the remediation.
- **Guided preflight: open the exact page, wait, resume.** Interactive `init` opens the
  browser at each human-only wall instead of printing instructions: not signed in → login;
  R2 not enabled (`code: 10042`) → open `https://dash.cloudflare.com/<account-id>/r2`,
  poll until enabled, continue. Non-interactive runs print the same exact URLs in the
  error remediation and never block. Only Cloudflare can create the account and take the
  card; everything else is the tool's job (#67).
- **Reconcile by name, self-heal.** Bucket and KV: saved id → match by name → create. A
  re-run after a dashboard deletion repairs instead of failing. Provisioning goes through the
  Cloudflare REST API (ids come back as JSON); never parse wrangler's stdout for ids or URLs.
- **Credential before deploy.** `init` mints the admin key and writes its records
  (`keys/`, `keyhash/`, `users/admin`) into the bucket through the Cloudflare R2 API before
  the first deploy; `HMAC_SECRET` ships via `wrangler deploy --secrets-file`. Refuse to
  deploy if no admin record exists and none can be written. `--rotate-admin-key` is
  crash-safe: new record + `keyhash/` → CAS `users/admin` to `{id: new, previous: old}`
  (its one write this run) → delete old `keyhash/` (revocation) → delete old record;
  `previous` is cleared by a later writer (`init` rerun, `doctor`, next rotation), never in
  the same second; a rerun finishes the deletes first. `canonical_url` and `alias_origins` are written to
  `system/config.json` in the same run.
- **Preflight names the dashboard permission, not the HTTP code.** Token verify, account
  pin (refuse to guess between several), R2-subscription check (`code: 10042` → "enable R2 at
  …"), one cheap read per permission.
- **`doctor` proves the deploy with a real drop**: publish → fetch → delete a hello drop, and
  MCP `initialize` must answer — a version-correct deploy with a dead MCP endpoint is a broken
  deploy. `init` polls for propagation, then runs it with the instance key.
- **Unclaimed, fail-closed bootstrap for the button path (after v1).** With no admin secret
  set, every route but health and `/claim` returns 503; the Worker writes a one-time claim
  code to `system/claim-code` (never to a response or a log); `npx dropthis claim` reads it
  with the operator's own Cloudflare token and exchanges it for the admin key. Ownership is
  proved by holding an account token, never by being the first HTTP caller.
- **Serve the agent skill from the instance** at `/_skill.md` with base URL and limits
  substituted from that deployment's own config — one URL onboards any agent correctly.
- **Zone matching:** longest zone name that is a suffix of the hostname, within the pinned
  account; refuse if a CNAME already exists there.

### Bootstrap invariants

Bootstrap exists only in the installer; no public request can create or claim the first
administrator. `init --json` returns the new admin key exactly once and persists it
atomically before reporting success. Diagnostic output and Worker logs never contain it. A
missing credential fails with a recovery instruction; rotation requires an explicit command.
Tests cover concurrent bootstrap, interruption, rerun, missing credentials and secret redaction.

### Shared-origin boundary (accepted, #28)

All drops of an instance share one origin, so active HTML in one drop can request another
drop's path and the browser attaches that path's unlock cookie if the visitor unlocked it.
`SECURITY.md` says so: a convenience boundary, not a security one. Per-drop origin
isolation is a door kept open, not v1. A contract test pins the documented behaviour.

### Reserved paths

`RESERVED_PREFIXES` is a list of literal path strings (`/_api`, `/_oauth`, `/.well-known`,
`/_connect`, …) checked with `startsWith`. Generated slugs never start with `_`. Validation regexes are
separate values and never enter routing. Every new control-plane prefix adds a
viewer-collision test (a slug must never shadow it).

### Release phases and trust

v1 is used privately from the repo build (`npx ./packages/dropthis`); nothing is on npm.
The **first public release** is its own milestone: `dropthis@1.0.0` on npm with an SPDX or
CycloneDX SBOM and a provenance attestation, GitHub Actions pinned to commit SHAs, a release
gate that verifies both, CI running the contract corpus, and a versioned release manifest.
`upgrade` (after that) refuses an instance whose schema is newer than it understands.

## Kept open, deliberately empty

These are not non-goals; they are doors the layout leaves open at zero cost, to be built
only when a real user asks: `webhook_url` as an event
bus (`published`, `paid`, `expired` with `{url, slug, title, meta, …}`) so a Telegram bot or
n8n can deliver passwords or invitations; paid unlock through the operator's own Stripe
Checkout (`access: {price, currency}`, orders as `orders/<session_id>.json`, dropthis never
touches money); the Deploy button + `claim`; `host_*` root-domain drops; `upgrade`/`destroy`;
gallery auto-index; `llms.txt`; a generated reference.

## Non-goals (decided, do not reopen without a user asking)

Revision history and rollback · slug rename · dashboard, console, admin UI · accounts,
teams, workspaces, invitations, roles beyond admin/user · plans, billing, quotas beyond
instance policy · email or SMS sending · analytics · search index · charset detection (UTF-8
is assumed) · SQLite/D1/Postgres · multi-node · Cloudflare Access as auth · key-in-URL auth ·
executing published code · compatibility with the archived hosted product's clients.

## Glossary

**Drop** — a published file set at one URL. **Slug** — the generated, immutable path segment
that identifies a drop; the URL is the id. **Title** — the drop's short human name.
**Meta** — the JSON the agent stores on a drop to remember what it is. **Access** — the
drop's unlock rule (password today). **Grace** — the 7 days after expiry in which a drop
answers 410 publicly but can still be revived. **Generation (gen)** — one immutable set of a
drop's files; `current_gen` is what is served. **Key** — a bearer credential with a label
and a scope. **Instance** — one Worker + bucket + config; one team; the unit of isolation and
of hosting a client. **Policy** — the instance's defaults and rules for expiry, password,
noindex. **Prune** — deleting expired drops, abandoned uploads and orphaned generations.

## Stack (#70 — library over hand-rolled wherever a maintained standard exists)

Worker: **Hono** (routing) · **@modelcontextprotocol/sdk** (MCP over Streamable HTTP through
its own web-standard transport, one stateless server per request; `@hono/mcp` was dropped,
#80) · **@cloudflare/workers-oauth-provider** (OAuth, #53) · **zod** (one schema per
operation in the registry drives REST validation, the MCP tool schemas and CLI parsing) ·
**canonicalize** (RFC 8785) · WebCrypto built-ins for sha256/HMAC/PBKDF2/AES-GCM (no lib).
CLI/installer: **cloudflare** (official typed SDK — all provisioning calls) · **wrangler**
bundled (deploy + browser login, never reimplemented) · **commander** · **@vercel/detect-agent** ·
**@clack/prompts**. Tests: **vitest**; Hono again for `test/fake-cloudflare/`; the MCP SDK's
client drives `/_api/mcp` in the corpus. Deliberately no library: storage (the R2 binding is
the API), slugs/paths/policy/expiry (pure functions — the product itself), no ORM, no
framework beyond the above. Exact versions are pinned and re-verified the day a slice starts;
if a listed library turns out unmaintained or unfit, replace it and update this block + a
decision entry in the same commit.

## Working rules for this repo

- The dev credential: contract tests and `init` read `CLOUDFLARE_API_TOKEN` and
  `CLOUDFLARE_ACCOUNT_ID` from the environment; on the maintainer's machine they live in
  `~/.config/dropthis/dev.env` (mode 600, outside the repo) — `source` it before any slice
  work. The file never enters the repo.
- Test-first for every behaviour. Four seams: (1) a golden HTTP corpus against a real
  deployed `dev` Worker on the developer's own account, bucket reset through the R2 API
  before every run, expiry driven by a clock override that exists only in the `dev` build;
  (2) the `dropthis` binary as a subprocess — instance commands against `dev`, `init`
  against a local fake of the Cloudflare management API for every failure path; (3) a few
  pure unit modules (policy, expiry parsing, slug, path validation, manifest hashing, schema
  tolerance, `meta` merge, error catalogue completeness); (4) manual, recorded acceptance:
  the claude.ai spike and the two milestone runs. No CI before the first public release.
- One monorepo: `packages/worker` (the deployed Worker), `packages/dropthis` (the one npm
  package: installer, CLI, stdio MCP, bundles the built Worker for `init`), `skills/`,
  `contract-tests/`, `test/fake-cloudflare/`. Every change is made in a worktree at
  `.worktrees/<issue-or-name>/` on its own branch and lands on `main` by fast-forward merge;
  the main checkout receives merges and nothing else. No PRs and no CI before the first
  public release.
- `wrangler.jsonc`, never TOML. The repo file has bindings by name and no IDs (button path);
  `init` renders the per-instance config with the reconciled ids and deploys from that.
- Secrets are never printed to logs and never re-revealed by a rerun. A missing key file
  fails loudly; rotation is explicit.
- Docs are generated from the operation registry wherever possible. Hand-written prose is
  limited to README, this file, `SECURITY.md`, `docs/decisions.md` and `docs/spec-v1.md`
  (the v1 spec, committed by owner decision #65; code beats it on conflict).
- Several worktrees share this machine. Never kill a test process by name (`pkill vitest`,
  `killall node`); kill only the PID of the run you started.
- No plan files or status notes in the repo. Decisions go in `docs/decisions.md` with a date
  and a reason; superseded entries are marked, not deleted.

## Agent skills

### Issue tracker

Issues live in GitHub Issues for `dmalis/dropthis`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles use their default names (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: the glossary is in `AGENTS.md`, decisions in `docs/decisions.md`. See `docs/agents/domain.md`.
