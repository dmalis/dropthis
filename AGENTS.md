# AGENTS.md — how to think about dropthis

This file is for agents and humans working on the code. It says what the product is, what
makes it different, and the rules that keep it small. Prohibitions are listed only where a
principle is not enough.

## What this is

dropthis turns content an agent produced into a permanent URL on Cloudflare the user owns.
The user never sees Cloudflare after setup, never sees a dashboard, and never touches a
server. The whole product is a contract: **one call in, one URL out**, plus the three
policies every drop carries — expiry, password, noindex — and the pruning that follows.

It is the successor to a hosted SaaS by the same name. The client-facing contract (REST
shapes, SDK, CLI, MCP tool names) is kept compatible on purpose so the published
`@dropthis/sdk`, `@dropthis/cli` and `@dropthis/mcp` keep working with a base-URL change.
Nothing else from that codebase is carried over.

## Principles, in priority order

1. **Least moving parts.** One Worker, one bucket. Every additional binding, service, table
   or build step must be justified against "could a file in the bucket do this?" So far the
   only justified extra is one KV namespace for OAuth sessions.
2. **Files are the database.** One object per entity, never a shared index file. Every hot
   read is a direct `GET` of a key we can compute. `list()` is for the rare "list my drops"
   and for cron, never for lookup.
3. **The agent is the console.** Any operation an operator could want exists as REST, CLI
   and MCP — generated from one operation registry so the three can never drift. If a
   feature needs a UI to be understood, it is out of scope.
4. **The contract is invariant.** Responses, URL shapes and tool semantics are the same for
   every install. A golden HTTP corpus replayed against a deployed instance in CI is the
   proof, not code review.
5. **Old drops never die from a schema change.** See "Data durability" below.
6. **Ship small, measure, then add.** The MVP is frozen in `docs/decisions.md`. New
   features wait for a real user asking.
7. **Documentation is an API.** Structured `--json` output, stable error codes with a
   remediation field, non-interactive operation, idempotent reruns and generated connection
   instructions are product behaviour, not documentation polish. An agent must be able to
   install, operate and administer an instance with no human reading anything.

## Architecture

```
/<slug>/*            viewer: resolve slug → drop → serve file (cache, unlock, headers)
/_api/v1/*           REST; bearer key auth
/_api/mcp            MCP over Streamable HTTP; bearer key or OAuth (workers-oauth-provider)
/_connect            static page: how to connect this instance (URL pre-filled)
/_skill.md           this instance's agent skill, base URL and limits substituted live
cron (daily)         expire + prune
```

Bindings: `BUCKET` (R2), `OAUTH_KV` (KV), secrets `ADMIN_KEY_HASH`, `HMAC_SECRET`.
Everything is declared in `wrangler.jsonc` with binding names and no IDs so `wrangler deploy`
and the Deploy button auto-provision them (JSONC only — TOML does not get IDs written back).

### Key layout (the real schema — never renamed)

```
drops/<id>/meta.json                 schema, slug, current_gen, expires_at, password_hash,
                                     noindex, hostname, key_id, created, updated
drops/<id>/<gen>/<path>              files of one generation
slugs/<slug>                         pointer → id   (created with If-None-Match: * → atomic claim);
                                     customMetadata carries {id, updated, expires, label} so
                                     `list` is ONE list() call — never a get() per drop
hosts/<hostname>                     pointer → id   (root drop for a hostname)
keys/<sha256(key)>.json              label, scope (admin|user), created
expiring/<yyyy-mm-dd>/<id>           marker for the daily cron; one list per day, never a scan
staging/<id>/<gen>/<path>            uploads before commit; R2 lifecycle rule deletes after 1 day
system/config.json                   instance policy (defaults + rules)
system/claim-code                    one-time code for the unclaimed-install flow; deleted on claim
```

No counters are stored anywhere: R2 has no atomic increment, and a read-modify-write counter
corrupts itself the first time two requests race. `usage` computes from `list()` on demand.

- **Updates are a generation flip.** Stage files under a new `<gen>`, then compare-and-swap
  `meta.json` (`If-Match: <etag>`) to point `current_gen` at it. Half-uploaded state is never
  served. Cache keys include the gen, so an update is visible instantly with no purge. The
  old gen is deleted after the flip; a weekly reconcile removes orphans.
- **Uploads are manifest-first.** Client sends `{path, sha256, size}` per file; server
  answers which hashes it lacks; client PUTs only those (one file per request, streamed
  straight into R2 — the Worker request-body cap is therefore the per-file cap); unchanged files are
  R2-copied from the previous gen; client commits. This is the same three-step shape the
  existing SDK/CLI/MCP already speak (create → signed PUT → finalize); the signed PUT URLs
  simply point at the Worker's own HMAC-signed endpoint.
- **R2 facts this relies on** (evidence in `docs/research/`): strong global consistency for
  reads and `list()`; conditional `put` via `onlyIf` / `Headers` (`If-None-Match: *`,
  `If-Match`); a per-key write-rate limit; delete is free; `list()` costs an order of
  magnitude more than a GET. Verify conditional-write behaviour against remote R2 — local
  Miniflare has had reversed condition logic.

### Auth

- Keys are 32 random bytes, shown once, stored as `sha256(key)`; compared with
  `crypto.subtle.timingSafeEqual`. No slow KDF: keys are high-entropy, and the Free plan's
  CPU budget per request is tiny (workerd also caps PBKDF2 iterations).
- Two scopes: `admin` (all tools) and `user` (drop tools). MCP filters its tool list by the
  caller's scope so a user's context carries ~8 tools.
- OAuth on `/_api/mcp` exists only because claude.ai and the Claude desktop app add MCP
  servers as connectors that speak OAuth and cannot send static headers. The authorize page
  is one form — *paste your dropthis key* — so identity stays "the key". Revoking the key
  ends every session behind it.
- Cloudflare Access was evaluated and rejected as the auth layer (50 service-token cap,
  two-header scheme browser clients cannot send, no per-user identity on tokens).

### Instance policy (`system/config.json`)

Two layers: *defaults* applied when the caller says nothing, *rules* enforced regardless.
Example: `expiry: {default: "30d", max: "90d", allow_never: false}`,
`password: {default: "generate", required: true}`, `noindex: {default: true, forced: true}`,
`max_file_bytes`, `auto_index`. dropthis itself never sends messages; password delivery is
the caller's job (a publish webhook is recorded as a post-MVP decision). Policy is per
instance; two groups with different rules get two instances.

### Multi-client hosting

**Instance = client.** No tenant concept. Isolation comes from the bucket and Worker
boundary. An operator hosts many clients on one Cloudflare account
(`npx @dropthis/cf init --name client-x` per client; the per-account Worker limit is in the
hundreds) and invoices them;
or a client runs it on their own account with their own token. Same command, different
token. If cross-client reporting is ever needed, `tenant` is one more field in `meta.json`;
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

Three kinds of garbage, three mechanisms: expired drops → daily cron over
`expiring/<today>/`; abandoned uploads → R2 lifecycle rule on `staging/` (set once by the
installer) plus abort-incomplete-multipart; orphaned generations → weekly reconcile in the
same cron. `prune --dry-run` and `usage` read the same layout. Free-plan cron has a small
CPU and subrequest budget per invocation — batch and chain; measure, do not guess.

## Operation registry

Every operation is defined once (name, input schema, scope, description) and generates the
REST route, the CLI subcommand, the MCP tool and the reference docs. Adding an operation
means adding one entry; the current inventory lives in the generated reference, not here.
Two families: drop operations (user scope) and admin operations (admin scope — users, hosts,
policy, usage, prune, doctor). `user_add` and `user_rotate` return the key together with a
structured `connect` object (per-client MCP snippets) so onboarding a person is one call.
Instance lifecycle (`init`, `upgrade`, `destroy`, `doctor`) lives in the installer CLI only —
it needs the Cloudflare token, not an instance key.

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
- **Unclaimed, fail-closed bootstrap for the button path.** With no admin secret set, every
  route but health and `/claim` returns 503; the Worker writes a one-time claim code to
  `system/claim-code` (never to a response or a log); `npx @dropthis/cf claim` reads it with
  the operator's own Cloudflare token and exchanges it for the admin key. Ownership is proved
  by holding an account token, never by being the first HTTP caller.
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

`RESERVED_PREFIXES` is a list of literal path strings (`/_api`, `/_connect`, …) checked with
`startsWith`. Validation regexes are separate values and never enter routing. Every new
control-plane prefix adds a viewer-collision test (a slug must never shadow it).

### Release trust

Published npm packages and release archives carry an SPDX or CycloneDX SBOM and a provenance
attestation. GitHub Actions dependencies are pinned to commit SHAs. The release gate verifies
both. Deployments carry a versioned release manifest; `upgrade` refuses an instance whose
schema is newer than it understands.

## Non-goals (decided, do not reopen without a user asking)

Revision history and rollback · dashboard, console, admin UI · accounts, teams, workspaces,
invitations · plans, billing, quotas beyond instance policy · email or SMS sending ·
analytics · charset detection (UTF-8 is assumed) · SQLite/D1/Postgres · multi-node ·
Cloudflare Access as auth · executing published code.

## Glossary

**Drop** — a published file set at one URL. **Slug** — the path segment identifying a drop.
**Generation (gen)** — one immutable set of a drop's files; `current_gen` is what is served.
**Key** — a bearer credential with a label and a scope. **Instance** — one Worker + bucket
+ config; the unit of isolation and of hosting a client. **Policy** — the instance's
defaults and rules for expiry, password, noindex. **Prune** — deleting expired drops,
abandoned uploads and orphaned generations.

## Working rules for this repo

- Test-first for every behaviour. Contract tests run against a real deployed Worker in CI
  (a free Cloudflare account suffices). Unit tests cover policy resolution, key layout,
  conditional-write handling and schema tolerance.
- `wrangler.jsonc`, never TOML. Bindings top-level, no IDs, so both `wrangler deploy` and
  the Deploy button provision them.
- Secrets are never printed to logs and never re-revealed by a rerun. A missing key file
  fails loudly; rotation is explicit.
- Docs are generated from the operation registry wherever possible. Hand-written prose is
  limited to README, this file and `docs/decisions.md`.
- No plan files or status notes in the repo. Decisions go in `docs/decisions.md` with a date
  and a reason; superseded entries are marked, not deleted.
