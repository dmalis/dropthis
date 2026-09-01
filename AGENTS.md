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
/_api/v1/*           REST; bearer key auth
/_api/mcp            MCP over Streamable HTTP; bearer key, or OAuth (workers-oauth-provider)
/_oauth/*            OAuth endpoints + the one authorize page (paste your key)
/_connect            static page: how to connect this instance (URL pre-filled)
/_skill.md           this instance's agent skill, base URL and limits substituted live
cron (daily)         expire + prune
```

Bindings: `BUCKET` (R2), `OAUTH_KV` (KV), secrets `ADMIN_KEY_HASH`, `HMAC_SECRET`.
Everything is declared in `wrangler.jsonc` with binding names and no IDs so `wrangler deploy`
auto-provisions them (JSONC is the documented format for id write-back; whether TOML also
gets ids written back is unverified — see `docs/research/2026-09-01-cli-conventions.md`).

### Key layout (the real schema — never renamed)

```
drops/<id>/meta.json                 schema, slug, title, meta, access, current_gen,
                                     expires_at, noindex, created_by, hostname, created, updated
drops/<id>/<gen>/<path>              files of one generation
slugs/<slug>                         pointer → id   (created with If-None-Match: * → atomic claim);
                                     customMetadata carries {id, updated, expires, title, created_by}
                                     so `list` is ONE list() call — never a get() per drop
hosts/<hostname>                     pointer → id   (root drop for a hostname; after v1)
keys/<sha256(key)>.json              label, scope (admin|user), created
expiring/<yyyy-mm-dd>/<id>           marker for the daily cron, dated expires_at + grace;
                                     one list per day, never a scan; a HINT — cron re-reads meta.json
staging/<id>/<gen>/<path>            uploads before commit; R2 lifecycle rule deletes after 1 day
system/config.json                   instance policy (defaults + rules)
system/claim-code                    one-time code for the unclaimed-install flow (after v1)
```

No counters are stored anywhere: R2 has no atomic increment, and a read-modify-write counter
corrupts itself the first time two requests race. `usage` computes from `list()` on demand.

- **Updates are a generation flip.** Stage files under a new `<gen>`, then compare-and-swap
  `meta.json` (`If-Match: <etag>`) to point `current_gen` at it. Half-uploaded state is never
  served. Cache keys include the gen, so an update is visible instantly with no purge. The
  old gen is deleted after the flip; a weekly reconcile removes orphans.
- **One call uploads a drop.** `publish` and `update` take `files: [{path, content}]` (text,
  or base64 for binary) or `{path, url}` (the Worker fetches it). The whole request is one
  HTTP call; the Worker writes each file to R2 and commits. The single-call ceiling is set
  by isolate memory (128 MB) and is measured, not guessed — expected around 50 MB. Above it
  the CLI/SDK silently switch to the staged path: `{path, sha256, size}` manifest → server
  names the missing hashes → one streamed PUT per file → commit; unchanged files are
  R2-copied from the previous gen. MCP and REST callers never see the staged path.
- **R2 write rate.** R2 allows about one write per second to the same key. `meta.json` and
  `slugs/<slug>` are single keys; a second write inside that window returns `429` with
  `Retry-After` and a stable error code. Serialising through a Durable Object was considered
  and rejected — one drop updated twice a second is not the product.
- **R2 facts this relies on** (evidence in `docs/research/`): strong global consistency for
  reads and `list()`; conditional `put` via `onlyIf` / `Headers` (`If-None-Match: *`,
  `If-Match`); a per-key write-rate limit; delete is free; `list()` costs an order of
  magnitude more than a GET. Verify conditional-write behaviour against remote R2 — local
  Miniflare has had reversed condition logic.

### The drop model

- **Slug = identity = URL.** Generated, 10 characters from `a-z0-9`, never starts with `_`,
  immutable. `get`, `update` and `delete` accept the slug or the full URL and nothing else.
  Vanity slugs are one optional field away (the atomic claim already handles them) and wait
  for a user asking. Rename is a non-goal: a URL is permanent.
- **`title`** — short, optional, human-readable. In `list`, on the auto-index page, on the
  password page. The skill tells agents to always set it.
- **`meta`** — a JSON object the agent owns (≤ 16 KB): what the drop is, where the source
  data came from, which workflow made it, who it was sent to. Stored verbatim in
  `meta.json`, returned by `get`, never in `list`. `update({meta})` merges at the top level;
  a key set to `null` is removed. Values are any JSON — the old product advertised JSON and
  rejected non-strings, and agents got 422s.
- **`access`** — the unlock rule. Today `{password_hash, …}`. It is an object, not a bare
  field, so a paid unlock (`{price, currency, …}`) can be added later without touching the
  layout; that door is deliberately open and deliberately empty (#54).
- **Expiry.** `expires: "7d" | "2026-12-31" | "never"`; default from policy (30 days);
  policy `max` and `allow_never` enforced. When `expires_at` passes the viewer answers 410
  at once. The files stay for a **7-day grace** in which `get` and `update({expires})` still
  work — "the link died, bring it back" is one call, not "the files are gone". After grace
  the daily cron deletes. Markers are hints: cron re-reads `meta.json` and deletes only if
  `expires_at + grace <= now`.
- **Password.** `password: "generate"` returns a 16-character random password once in the
  response — the agent's default, the skill says so. A chosen password needs ≥ 8 characters.
  Stored as PBKDF2-SHA256 at the highest iteration count the plan's CPU budget allows
  (measured), unlocked by an HMAC cookie. No attempt rate limiting in v1; `SECURITY.md`
  says so plainly. `password: null` removes it.
- **`noindex`** on by default: `X-Robots-Tag: noindex, nofollow` on every response.
- **`created_by`** — the label of the key that made the drop. Attribution, not a wall.
- **Folder drops** without `index.html` get a generated file list (`auto_index: list`);
  single files (PDF, xlsx, image, one HTML page) are served directly at the URL with the
  right content type.

### Responses and errors

- One `Drop` shape from `publish`, `update`, `get` and each `list` item: `url, slug, title,
  created_by, created, updated, expires, noindex, has_password`; `files[]` (`path, size,
  sha256`) on `get`/`publish`/`update`; `meta` everywhere except `list`. `password` appears
  once, only in the response that set or generated it. Same shape in REST, CLI `--json` and
  MCP.
- `get(target, files: true)` returns text file content inline (≤ 1 MB total), password or
  not, and lists binaries with a bearer-authenticated download path. Pull → edit → `update`
  needs no local state.
- Errors: `{code, message, remediation}` with stable codes. The remediation is the only
  hint dropthis ever sends, and only when the agent is off-path (`SLUG_TAKEN → "call
  update"`, `EXPIRED_GRACE → "call update with expires"`). No `next` hints on success: the
  URL is the id, there is nothing to re-teach, and every sentence costs context on every call.
- `list`: one R2 `list()` per page, ≤ 1,000 entries, cursor, newest-first, optional `q`
  substring over `title` applied in memory within the page. No index, no search. An instance
  with more than 1,000 live drops is a second instance.

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
  caller's scope so a user's context carries five tools.
- OAuth on `/_api/mcp` exists only because claude.ai and the Claude desktop app add MCP
  servers as connectors that speak OAuth and cannot send static headers. The authorize page
  is one form — *paste your dropthis key* — so identity stays "the key". Revoking the key
  ends every session behind it. `@cloudflare/workers-oauth-provider` does the protocol; a
  spike against a real claude.ai connector runs before any OAuth code lands here.
- Cloudflare Access was evaluated and rejected as the auth layer (50 service-token cap,
  two-header scheme browser clients cannot send, no per-user identity on tokens).

### Team model

**Instance = team.** Every `user` key sees and edits every drop in the instance; `created_by`
records who made it. Someone leaves: revoke their key, one call. An agent handed a
colleague's URL never hits a permission wall inside its own team; a wall is a second
instance. There is no per-key ownership, no roles beyond `admin`/`user`, no workspaces.

### Instance policy (`system/config.json`)

Two layers: *defaults* applied when the caller says nothing, *rules* enforced regardless.
Example: `expiry: {default: "30d", max: "90d", allow_never: false}`,
`password: {default: "generate", required: true}`, `noindex: {default: true, forced: true}`,
`max_file_bytes`, `auto_index`. dropthis itself never sends messages; password delivery is
the caller's job — the agent hands the human a ready-to-send message. Policy is per
instance; two groups with different rules get two instances.

### Multi-client hosting

**Instance = client = team.** No tenant concept. Isolation comes from the bucket and Worker
boundary: a key from instance A does not exist in instance B's `keys/`. An operator hosts
many clients on one Cloudflare account (`npx dropthis init --name client-x` per client) and
holds every instance's admin key in their own `~/.config/dropthis/instances.json`; or a
client runs it on their own account with their own token. Same command, different token.
Five cron triggers per account on the Free plan means the sixth instance needs Workers Paid.
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

Three kinds of garbage, three mechanisms: expired drops (after grace) → daily cron over
`expiring/<today>/`; abandoned uploads → R2 lifecycle rule on `staging/` (set once by the
installer) plus abort-incomplete-multipart; orphaned generations → weekly reconcile in the
same cron. `prune --dry-run` and `usage` read the same layout. Free-plan cron has a small
CPU and subrequest budget per invocation — batch and chain; measure, do not guess.

## Operation registry

Every operation is defined once (name, input schema, scope, description) and generates the
REST route, the CLI subcommand, the MCP tool and the reference docs. Adding an operation
means adding one entry.

**Drop operations (user scope), exactly five:**

| op        | does                                                                                   |
|-----------|----------------------------------------------------------------------------------------|
| `publish` | create: `files`, `title?`, `meta?`, `password?`, `expires?`, `noindex?` → `Drop` + URL. Create-only: an existing slug is `409 SLUG_TAKEN → "call update"`. |
| `update`  | change only what is given: `files?` (replaces the whole set, one new generation), `title?`, `meta?` (merge), `password?` (`"…"`, `"generate"`, `null`), `expires?`, `noindex?`. Honestly idempotent. |
| `get`     | by slug or URL; `files: true` adds content. Replaces the old `resolve` and `get_content`. |
| `list`    | one page of `Drop`s, newest-first, `cursor`, `limit`, `q`.                              |
| `delete`  | immediate, files and pointers.                                                          |

**Admin operations (admin scope):** `user add|list|remove`, `config get|set`, `usage`,
`prune [--dry-run]`, `doctor`. `user add` returns the key once together with a structured
`connect` object (per-client MCP snippets and a ready-to-send message) so onboarding a
person is one call. `host_*` comes after v1.

**Instance lifecycle** lives in the CLI only — it needs the Cloudflare token, not an instance
key: `init`, `doctor` in v1; `upgrade` with the first release after v1; `destroy`, `claim`
later. MCP tool names carry the `dropthis_` prefix so they stay distinct when an agent has
several servers connected.

### CLI conventions (industry standard; evidence in `docs/research/2026-09-01-cli-conventions.md`)

- **One package, one binary, bare name:** `dropthis` on npm. Installer, client and stdio
  MCP proxy (`dropthis mcp`) are subcommands of the same binary — sst, convex, flyctl,
  railway, pocketbase do the same; no version skew between installer and client.
- **Grammar:** bare verbs for the hot path — `init`, `publish`, `update`, `get`, `list`,
  `delete`, `doctor`, `connect` — and `noun verb` for administration — `user add`,
  `config set`, `usage`, `prune`.
- **Two credentials, two env names, env beats file:** `CLOUDFLARE_API_TOKEN` (+
  `CLOUDFLARE_ACCOUNT_ID`) for `init`/`doctor`; `DROPTHIS_URL` + `DROPTHIS_KEY` for
  everything else. `init` writes `~/.config/dropthis/instances.json` (`name → {url, key}`);
  one instance is the default, `--instance <name>` / `DROPTHIS_INSTANCE` selects, the env
  pair overrides all of it (CI, n8n). An unknown instance name errors with the known names.
- **`connect [--instance x] --client claude-code|cursor|codex|claude-ai --json`** prints or
  applies the per-client registration; for Claude Code it runs `claude mcp add` itself so
  the key never lands in a repo file.
- **Non-interactive by default** when stdin is not a TTY or an agent is detected (Vercel's
  `@vercel/detect-agent` pattern); `--yes` is the explicit form; never a prompt an agent can
  hang on. Secrets via env or stdin, never flags.
- **Output contract:** `--json` = one deterministic JSON document (NDJSON only for streams
  such as `init`'s step log); stdout carries the result (on `publish`, only the URL), stderr
  everything else; exit codes documented: `0` ok, `1` failure, `2` cancelled, `4` auth
  required (as `gh`). `dropthis commands --json` lists the surface.
- **`npx dropthis@latest` only on the one-shot `init` line**; pinned afterwards.

### Installer principles (learned from 15 Cloudflare-hosted projects, `docs/research/`)

- **Token-only, never ambient `wrangler login`.** The installer pins `CLOUDFLARE_API_TOKEN`
  and `CLOUDFLARE_ACCOUNT_ID` into wrangler's environment so it cannot deploy to the wrong
  account, and prints which source the token came from.
- **Reconcile by name, self-heal.** Bucket and KV: saved id → match by name → create. A
  re-run after a dashboard deletion repairs instead of failing. Provisioning goes through the
  Cloudflare REST API (ids come back as JSON); never parse wrangler's stdout for ids or URLs.
- **Credential before deploy, secrets in the same deploy.** Refuse to deploy if there is no
  admin key and none can be minted; ship the hashed key via `wrangler deploy --secrets-file`
  so there is no live-but-unusable window.
- **Preflight names the dashboard permission, not the HTTP code.** Token verify, account
  pin (refuse to guess between several), R2-subscription check (`code: 10042` → "enable R2 at
  …"), one cheap read per permission.
- **`doctor` proves the deploy with a real drop**: publish → fetch → delete a hello drop, and
  MCP `initialize` must answer — a version-correct deploy with a dead MCP endpoint is a broken
  deploy. Poll for propagation first.
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

### Reserved paths

`RESERVED_PREFIXES` is a list of literal path strings (`/_api`, `/_oauth`, `/_connect`, …)
checked with `startsWith`. Generated slugs never start with `_`. Validation regexes are
separate values and never enter routing. Every new control-plane prefix adds a
viewer-collision test (a slug must never shadow it).

### Release trust (from the first public release)

Published npm packages and release archives carry an SPDX or CycloneDX SBOM and a provenance
attestation. GitHub Actions dependencies are pinned to commit SHAs. The release gate verifies
both. Deployments carry a versioned release manifest; `upgrade` refuses an instance whose
schema is newer than it understands.

## Kept open, deliberately empty

These are not non-goals; they are doors the layout leaves open at zero cost, to be built
only when a real user asks: vanity slugs (one field on `publish`); `webhook_url` as an event
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

## Working rules for this repo

- Test-first for every behaviour. Contract tests run against a real deployed Worker — a
  throwaway `dev` instance on the developer's own account, wiped at the start of every run
  (`npm test`, Cloudflare token from the environment). No CI before the first public
  release. Unit tests cover policy resolution, key layout, conditional-write handling and
  schema tolerance.
- One monorepo: `packages/worker` (the deployed Worker), `packages/dropthis` (the one npm
  package: installer, CLI, stdio MCP, bundles the built Worker for `init`), `skills/`,
  `contract-tests/`. Commits go straight to `main`; no branches, PRs or worktrees unless
  asked.
- `wrangler.jsonc`, never TOML. Bindings top-level, no IDs, so `wrangler deploy` provisions
  them.
- Secrets are never printed to logs and never re-revealed by a rerun. A missing key file
  fails loudly; rotation is explicit.
- Docs are generated from the operation registry wherever possible. Hand-written prose is
  limited to README, this file, `SECURITY.md` and `docs/decisions.md`.
- No plan files or status notes in the repo. Decisions go in `docs/decisions.md` with a date
  and a reason; superseded entries are marked, not deleted.
