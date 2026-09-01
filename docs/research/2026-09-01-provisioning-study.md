# Cloudflare self-host provisioning study → dropthis agent-first setup

15 repos shallow-cloned to `scratchpad/cf-repos/` and read from source; Cloudflare claims carry doc
URLs. `UNVERIFIED` = inferred, not read.

## 1 — What each project makes a human do

Steps counted to a *working* instance. br = browser-only, tm = terminal.

| Project | Human steps | How CF resources get created | Admin secret | Bootstrap / domain / machine-readable |
|---|---|---|---|---|
| **pagevault** | **3** (2 br: account, token · 1 tm: `npm i -g pagevault && pagevault init`) | CF **REST API** from the CLI: list → reuse-by-title → create; self-healing. Token-only, never ambient `wrangler login` | `randomBytes(32).hex()` set over the API, printed once, mirrored to gitignored `.env.local` (`cli/lib/provision/deploy.mjs:335-350`) | `verify` publishes a real welcome doc · writes `routes:[{pattern,custom_domain:true}]` after matching a real zone · `status/verify/health --json`, non-zero exit, polls, asserts `/mcp` |
| **sharehtml** | 4 (1 br token, 3 tm) — `pnpm run setup` TUI | R2 + DOs implicit from **id-less bindings** on `wrangler deploy` | `randomBytes(32).hex()` piped into `wrangler secret put`, **never printed** (`apps/worker/scripts/setup.ts:478-485`) | DO SQLite tag `v1` · no domain docs · none |
| **agent2web** | 6 (4 br, 2 tm) — `npm run gen-secrets` **before** the button | Deploy button; `"database_id": "placeholder-replaced-on-provision"` | `scripts/secrets.mjs:9-19` prints `A2W_SECRET`, `A2W_API_TOKEN`, PBKDF2 hash + a random password **once** | `migrate(sql)` on first request; public URL learned from the **first authenticated** request (`src/public-url.ts:5-23,48-56`) · `/healthz` · every MCP tool takes `response_format` |
| **open-artifacts** | 5 (1 br, 4 tm) | `wrangler d1 create` + `r2 bucket create`, then **hand-paste `database_id`** | `wrangler secret put CREATE_TOKEN`, human invents it; **unset = open instance** | D1 schema self-applies on first request · `PUBLIC_URL` secret pins links · no doctor |
| **agentic-inbox** (CF's own) | 6 (5 br, 1 tm) — button, Access, Email Routing catch-all, all dashboard | Button, from **id-less bindings**: R2 by `bucket_name`, DOs by class, `"ai":{"binding":"AI"}` (`wrangler.jsonc:25-50`) | none minted — human pastes `POLICY_AUD`/`TEAM_DOMAIN`; **prod refuses to boot without them** (`workers/app.ts:54-60`) | DO migrations in config · zone must pre-exist · `/mcp`, 13 tools (`workers/mcp/index.ts:86-431`), **no client snippet**, no doctor |
| **emailflare** | 6 (5 tm, 1 br DNS) | `scripts/setup.mjs:198-270` runs `wrangler d1/kv create`, **regex-parses ids from stdout**, string-replaces `REPLACE_WITH_D1_DATABASE_ID` | `openssl rand -hex 32`, masked prompt or `scripts/config.toml`, then `wrangler secret put` (`setup.mjs:284-330`) | `d1 migrations apply --remote` + seed · DNS records pasted by hand · `/health` + `getCloudflareTokenStatus()` doctor (`cloudflare.ts:233-291`) |
| **email-explorer** | 5 (2 br, 3 tm) or `npm create cloudflare@latest -- --template=…` | id-less bindings (`template/wrangler.jsonc:22-40`) | **first registered user becomes admin**, registration then closes (`routes/auth.ts:117-136`) | mailboxes self-init on first inbound email (`src/index.ts:1687-1698`) · dashboard · none |
| **Sink** | 7 (all br bar config edit) | **Manual dashboard**; ids pasted as Workers Builds vars | human sets `NUXT_SITE_TOKEN`; README warns a **random one is invented at build time** if omitted | HTTP **423 until** the operator opens Dashboard→Links once · dashboard · OpenAPI |
| **UptimeFlare** | 3 (2 br, 1 tm push) | Fully automated: `deploy/init_d1.py` raw REST + **Terraform** import-then-apply | none — page password is **plaintext in `uptime.config.ts`** (CVE-2026-29779, cited in its own README) | `init.sql` every deploy · CNAME manual · `/api/data` JSON |
| **CloudFlare-ImgBed** | 4 (all br) | **Manual dashboard**; GH Action only templates existing ids | auth code set in the app's own settings UI, hashed into KV/D1 | `init.sql` + migrations replayed every boot · dashboard · none |
| **R2-Explorer** | 3 tm (template) or 2 br (GH-Action vars) | R2 from an id-less binding | none by default; `basicAuth` is plaintext, compared with `===` | stateless · `R2EXPLORER_DOMAIN` → generated `custom_domain` route · OpenAPI |
| **pastebin-worker** | 6 (all tm) | `wrangler kv namespace create PB` + `r2 bucket create`, **hand-paste into TOML** | bcrypt hashes **in `wrangler.toml` vars**, from `scripts/bcrypt.js` | none · `[[routes]] custom_domain` must match `DEPLOY_URL` · serves a per-deployment agent skill |
| **workers-mcp** | 1 (`npx workers-mcp setup`) — **deprecated**, README points at remote MCP | n/a | `randomBytes(32)` → `.dev.vars` → piped to `wrangler secret put SHARED_SECRET`; static bearer | writes Claude Desktop config (macOS path only) |
| **cloudflare/templates** | 1 br click | Button provisions KV/R2/D1/DO/AI/Queues and **rewrites the ids** | per-template `.dev.vars.example` | `cli/src/validateD2CButtons.ts:21-22` asserts every README has the exact button string |
| **workers-oauth-provider** | library | needs one KV binding named `OAUTH_KV` | none; tokens hashed into KV, `props` AES-GCM encrypted | ships **no** consent UI on purpose (`README.md:237`) |

## 2 — Steal

1. **Token-only, never ambient `wrangler login`.** pagevault exports `CLOUDFLARE_API_TOKEN` into the
   child process so wrangler cannot silently deploy to the wrong account (`context.mjs:322-342`,
   `tier0.mjs:182`), and **prints which source the token came from** — "because the loser is silent".
2. **Reconcile-by-name, self-healing.** List → match saved id → else match by title → else create
   (`provision.mjs:144-199`). Re-running after a dashboard deletion repairs instead of failing.
3. **Ask for the credential BEFORE deploying.** pagevault moved the bearer decision ahead of
   `wrangler deploy` because a non-interactive run used to leave a live, unusable Worker
   (`deploy.mjs:43-72`). Refusing costs nothing and leaves the account untouched.
4. **A doctor that publishes something real — and checks `/mcp`.** `verify` publishes a bundled
   welcome doc and prints its link; `health` fails when `/health` matches but `/mcp` is dead — "a
   version-correct deploy with a dead `/mcp` is still a broken deploy" (`cli/lib/ops/health.mjs`).
   Both poll for propagation first.
5. **Ship the agent a per-deployment skill.** pastebin-worker serves `doc/skill.md` from the Worker
   with `{{BASE_URL}}`, `{{MAX_EXPIRATION}}` substituted live from that deployment's own vars
   (`worker/pages/docs.ts:9-18`), content-negotiated on User-Agent so curl gets raw markdown
   (`handleRead.ts:154-169`). One URL onboards any agent, per instance, correctly.
6. **One domain layer for humans and agents.** agentic-inbox's MCP tools are thin wrappers over the
   same `lib/tools.ts` the REST API and UI call (`workers/mcp/index.ts`) — no parallel agent API.

Runners-up: UptimeFlare auto-discovers the account id from the token (`deploy.yml:27-40`); agent2web
drives the Deploy-button form from a `"cloudflare".bindings` block in `package.json`; sharehtml
matches the R2-not-enabled error explicitly (`"Please enable R2 through the Cloudflare Dashboard"` /
`[code: 10042]`, `apps/worker/scripts/setup.ts:573-589`); pagevault ships
`docs/setup/ai-guided-setup.md`, a runbook addressed to the assistant rather than the human.

## 3 — Avoid

- **A live resource id committed in the template** — open-artifacts ships the maintainer's real
  `"database_id": "a01d21cd-…"`; a `git clone` fork gets no button to rewrite it.
- **Hand-copying ids between two commands** (pastebin-worker, open-artifacts) — and emailflare's
  automation of it, **regex over `wrangler` stdout** (`scripts/setup.mjs:198-270`). Use the REST API,
  which returns the id as JSON. Same for the deploy URL: workers-mcp regexes the first `https://` in
  wrangler's output (`src/scripts/setup.ts:210-213`) and any other logged link wins.
- **Secrets in tracked config** — pastebin bcrypt hashes in `wrangler.toml`; UptimeFlare's plaintext
  password in `uptime.config.ts`, which its own README ties to CVE-2026-29779.
- **Open-by-default reads** — R2-Explorer's `readonly:true` blocks writes, not reads; a bare deploy
  publishes a world-readable bucket browser (`packages/worker/src/index.ts:44,54,79-84`).
- **Inventing a password the operator omitted** (Sink) · **`--yes` that deploys with no credential**
  (pagevault's fixed bug) · **first-registered-user-becomes-admin** (email-explorer `auth.ts:117-136`).
- **Token scopes stated three different ways in one repo** — emailflare `docs/CLOUDFLARE.md:57-58`
  vs `domains.ts:69` vs `.env.example:27` — and a drifted `AGENTS.md`: email-explorer's still says
  "The application currently has no authentication" (`AGENTS.md:82`) beside a full auth system.

## 4 — Email on Cloudflare (facts only)

- **Classic Email Routing.** Inbound = a Worker `email()` export (agentic-inbox `workers/app.ts:113-126`).
  Outbound = the `send_email` binding: `"send_email":[{"name":"EMAIL","remote":true}]` (agentic-inbox
  `wrangler.jsonc:19-24`), `"send_email":[{"name":"SEND_EMAIL"}]` (email-explorer
  `template/wrangler.jsonc:28-32`). Neither uses `destination_address`,
  `allowed_destination_addresses` or `allowed_sender_addresses`; email-explorer also sets
  `compatibility_flags:["enable_email_sending_queuing"]`.
- **Email Service REST API, no binding.** emailflare POSTs `/accounts/{id}/email/sending/send` with a
  bearer CF token (`services/worker/src/services/cloudflare.ts:195-205`) and creates sending
  subdomains via `POST /zones/{zoneId}/email/sending/subdomains` (`cloudflare.ts:126-136`).
- **Dashboard-only.** Enabling Email Routing on a zone is Compute → Email Service → Email Routing →
  Onboard Domain; Cloudflare adds MX + SPF TXT + DKIM TXT itself, and a destination address is
  verified by clicking a link in an email it sends
  (https://developers.cloudflare.com/email-routing/get-started/enable-email-routing/). agentic-inbox
  (`README.md:27`) and email-explorer (`README.md:101`) both say so; neither automates it. Send
  errors: `E_SENDER_NOT_VERIFIED`, `E_RECIPIENT_NOT_ALLOWED`, `E_RECIPIENT_SUPPRESSED`
  (https://developers.cloudflare.com/email-routing/email-workers/send-email-workers/).
- **For dropthis** (fact, not recommendation): emailing a drop link would add a dashboard-only,
  per-operator step nobody here managed to script — zone onboarding, DNS propagation, click-to-verify
  — on top of a 4-step install. emailflare's `eftest_` keys, which capture sends into a local Test
  Mailbox with no Cloudflare call (`docs/SELF_HOSTING.md:110-122`), are the only safe non-prod send
  path anyone shipped.

## 5 — Auth + MCP wiring worth stealing

Only pagevault, agent2web and agentic-inbox expose MCP. sharehtml, pastebin-worker, R2-Explorer and
email-explorer have no MCP surface.

- **Bearer-or-OAuth on one route — the shape to copy.** pagevault intercepts `/mcp` *before*
  `OAuthProvider`: a matching static bearer short-circuits OAuth, anything else falls through
  (`worker/src/index.ts:136-161`). agent2web does it in one handler — bearer first, then
  `oauth.verifyAccessToken()` + scope, else 401 carrying the RFC 9728 `WWW-Authenticate` header that
  points a client at discovery (`src/http/mcp.ts:29-45,73-89`). The static key keeps Claude Code and
  CI working; OAuth is what the claude.ai connector form requires.
- **Token crypto.** pagevault derives a per-scope HMAC-SHA256 key from one root secret, encoding
  `{b64url(json)}.{b64url(sig)}` (`worker/src/token.ts:30-50,74-98`) — scope confusion impossible by
  construction; rotating the root invalidates everything free; every bearer compare goes through
  `timingSafeEqual` (`auth.ts:48-57`). open-artifacts stores only `sha256` of its 32-byte `wt_` tokens
  (`src/tokens.ts:26-54`) — correct for high-entropy tokens, no salt. agent2web's admin *password* is
  PBKDF2-SHA256 chained 6×100k because a Worker refuses >100k iterations per call
  (`src/core/crypto.ts:114-132`). Anti-patterns: `workers-oauth-provider` compares client secrets with
  plain `!==` (`src/oauth-provider.ts:2072-2077`); email-explorer uses unsalted SHA-256 and `===`.
- **Nobody filters the tool list per caller.** All three register every tool unconditionally.
  `readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint` (`pagevault/worker/src/mcp.ts:281,414,463`)
  are **client UI hints, not authorization** — the real check lives in `canView()`. agentic-inbox
  admits the gap: anyone past its shared Access policy can operate on any mailbox via MCP
  (`README.md:79`). A read-only dropthis agent key has no prior art; we'd write it.
- **Consent pages are tiny** — pagevault ~85 lines of template-literal HTML, zero deps
  (`worker/src/oauth.ts:93-177`); agent2web 61 lines (`src/core/views/oauth.ts`). Budget one file.
## 6 — SQL vs KV vs R2: what pushed each project to a database (facts)

**The two poles.** open-artifacts uses D1 for metadata + R2 for bodies, and says why verbatim
(`docs/architecture.md:40-43`): *"KV was rejected: eventual consistency up to 60 s cross-colo, 1
write/s/key, 1,000 writes/day free — wrong for frequently-updated artifacts. D1 is strongly
consistent (metadata, pointers), R2 is strongly consistent read-after-write via bindings (bodies).
D1's 2 MB row cap forbids storing HTML in D1."* pagevault is the opposite and equally explicit
(`docs/architecture.md:83-85`): *"No database. KV is the whole persistence layer. Nothing to
provision, back up separately, or pay for… The cost is real: no transactions, no queries, and ~60s
eventual consistency that the code has to assume everywhere."* Its listing rule is the discipline
that makes it work (`architecture.md:207-212`): *"Listing is list({prefix:…}) with KV key metadata
for titles and dates. Never a read per document — an N+1 passes every functional test and silently
eats the 100k/day read quota. There is a test asserting one list() and zero get()s."* And
`architecture.md:227`: *"No index array. It is a read-modify-write on every publish and it corrupts
itself the first time two publishes race."*

**The query patterns that forced SQL**, each with the file it lives in:

| Pattern | Repo | Query |
|---|---|---|
| Atomic publish-swap, no half-published read | agent2web | `db.batch()` writes version+file rows then `UPDATE sites SET current_version_id=?` (`src/store.ts:199-207,366-383`) |
| Atomic view/download counter | agent2web `view_count=view_count+1` (`store.ts:653`) — vs pastebin-worker's **1 %-probability** KV counter that swallows 429s (`worker/storage/storage.ts:82-95`) and R2-Explorer's racy read-modify-write past `maxDownloads` (`getShareLink.ts:80-131`) |
| OAuth code single-use | agent2web `UPDATE oauth_codes SET used=1` + revoke the whole chain on replay (`src/oauth.ts:346-397`); workers-oauth-provider does it on **KV** instead by field presence — "the absence of `authCodeWrappedKey` marks the code as used" (`storage-schema.md`) |
| Idempotency-key dedupe | emailflare partial unique index `ON email_logs(idempotency_key) WHERE … NOT NULL` (`migrations/0001_schema.sql`) |
| Sorted, filtered, keyset-paginated listing | Sink `d1ListLinks` (`server/services/link-store/d1.ts:328-361`); sharehtml `LIMIT ? OFFSET ?` + `COUNT(*)` (`registry.ts:194-209`) |
| Search across fields + joined tags | Sink `LIKE` on 4 columns + `EXISTS(SELECT 1 FROM link_tags …)` (`d1.ts:395-412`) |
| Version-history index | open-artifacts `SELECT … FROM versions WHERE artifact_id=? ORDER BY version` (`src/store.ts:532`) |
| Uniqueness under concurrency | open-artifacts `CREATE UNIQUE INDEX idx_artifacts_channel_hash` — "concurrent first publishes to one channel can only mint one artifact" (`store.ts:175-179`); sharehtml `UNIQUE(author_email, emoji, anchor)` |
| Thread/conversation rollups | agentic-inbox CTE + `ROW_NUMBER() OVER (PARTITION BY conversation_id …)` + 3 joins (`durableObject/index.ts:243-371`) |

**Negative examples of files-only.** R2-Explorer's share listing is `bucket.list(prefix)` then a
`bucket.get()` **per object** (`packages/worker/src/modules/buckets/listShares.ts:44-88`);
pastebin-worker's cron GC pages `R2.list({limit:1000})` and falls back to a KV lookup per object
that lacks `customMetadata.willExpireAtUnix`, deleting in 1000-object batches (`storage.ts:239-282`).
UptimeFlare uses D1 as a **single-key blob store** — one row, `INSERT … ON CONFLICT DO UPDATE`
(`worker/src/store.ts:15-19`) — no WHERE, no index, no join; its README only says the KV→D1 move
"resolve[d] long-standing performance issues" (`README.md:12`), reason UNVERIFIED.

**For dropthis, files-in-R2-only** (facts, no recommendation): R2 gives strong read-after-write via
the binding, which removes pagevault's hardest constraint. What has no R2 equivalent in this study:
an atomic counter, a single-use token consumption, a uniqueness constraint under concurrent writes,
a secondary index (list-by-owner / sort-by-updated / filter-by-tag without an N+1), and
cross-document search. Each was either given to SQL, approximated (pastebin's 1 % counter), or left
racy (R2-Explorer's download limit). agent2web's atomic publish-swap is the one dropthis most
directly needs an answer for — a version pointer that never shows a half-published drop.
## 7 — A. `npx @dropthis/cf init`

Every step checks before it acts and converges on re-run. Under `--json`, one NDJSON line per step
(`{"ok":bool,"step":"…","detail":"…","hint":"…"}`), then one result object; non-zero exit on the
first `ok:false`. Flags: `--cf-token --account-id --name --domain --json --yes --dry-run --rotate-admin-key`.

| # | step | checks first | call | hint on failure |
|---|---|---|---|---|
| 1 | `node_version` | `>= 22` | local | "wrangler 4 needs Node 22+" |
| 2 | `token_source` | `--cf-token` → `$CLOUDFLARE_API_TOKEN` → `~/.dropthis/.env.local`; **prints which won** | local | the scope table below |
| 3 | `token_valid` | — | `GET /user/tokens/verify` → `result.status=="active"` | recreate the token |
| 4 | `account` | 1 → pin; >1 non-interactive → **refuse, never guess** | `GET /accounts` | "pass `--account-id`; the token reaches N accounts" |
| 5 | `scopes` | 4 probes (below) | cheap GETs | names the dashboard permission verbatim |
| 6 | `r2_subscription` | 403 / `code: 10042` on the bucket list | `GET /accounts/{id}/r2/buckets?per_page=1` | "R2 is not enabled. Open `https://dash.cloudflare.com/{account_id}/r2` → Enable R2 (free tier, but Cloudflare wants a card on file), then re-run." |
| 7 | `bucket` | saved id → match by name → create | `GET/POST /accounts/{id}/r2/buckets` | "check Workers R2 Storage — Edit" |
| 8 | `kv` | same reconcile, title `dropthis-oauth` | `GET/POST /accounts/{id}/storage/kv/namespaces?per_page=100` | "check Workers KV Storage — Edit" |
| 9 | `subdomain` | `GET /accounts/{id}/workers/subdomain`; if absent `PUT` | same | "that name is taken — pass `--subdomain`" |
| 10 | `config` | render `wrangler.jsonc` into `~/.dropthis/<name>/` with the ids from 7–8 | local | — |
| 11 | `secrets` | `GET …/workers/scripts/{name}/secrets` — reuse if present, **never rotate silently** | see below | refuses *before* deploying if there is no key and none can be minted |
| 12 | `deploy` | — | `wrangler deploy --config <gen> --secrets-file <tmp>`, `CLOUDFLARE_ACCOUNT_ID` pinned in env | wrangler stderr verbatim |
| 13 | `url` | from the API, never stdout: `https://{name}.{subdomain}.workers.dev` | step 9 | — |
| 14 | `lifecycle` | `wrangler r2 bucket lifecycle list` for rule `dropthis-staging-expiry` | `wrangler r2 bucket lifecycle add dropthis-drops dropthis-staging-expiry staging/ --expire-days 7` | non-fatal warning |
| 15 | `domain` *(`--domain` only)* | zone match (below) | add `routes:[{pattern,custom_domain:true}]`, redeploy | "no zone in this account serves X — zones here: …" |
| 16 | `doctor` | publish → GET → DELETE a hello drop; MCP `initialize` must return `serverInfo.name=="dropthis"` | HTTPS | polls 11×5 s first — propagation ≠ bad deploy |
| 17 | `clients` | write `.mcp.json`, print Claude Code / Cursor / Codex snippets | local | — |

**Scope preflight (5).** No endpoint returns a token's own policy list (UNVERIFIED — I found none),
so probe with the cheapest read per permission and report the *dashboard* name, not the HTTP code:
`GET /accounts` → Account Settings — Read · `…/workers/scripts?per_page=1` → Workers Scripts — Edit ·
`…/storage/kv/namespaces?per_page=1` → Workers KV Storage — Edit · `…/r2/buckets?per_page=1` →
Workers R2 Storage — Edit (+ subscription) · `GET /zones?name=<apex>` → Zone DNS — Edit **and** Zone
Workers Routes — Edit. A read probe cannot prove *Edit*: report `read-probe passed; Edit is proven at
step 7` and let 7–8 surface the real 403. Names from
https://developers.cloudflare.com/fundamentals/api/reference/permissions/ ; the two Zone strings are
UNVERIFIED (from pagevault's README table).

**The config (10)** — top-level, no `env.*`, so the button (B) reads the same file:

```jsonc
{ "$schema": "node_modules/wrangler/config-schema.json",
  "name": "dropthis", "main": "worker.js",
  "compatibility_date": "2026-07-01", "compatibility_flags": ["nodejs_compat"],
  "r2_buckets":    [{ "binding": "DROPS", "bucket_name": "dropthis-drops" }],
  "kv_namespaces": [{ "binding": "OAUTH_KV" }],
  "triggers": { "crons": ["17 3 * * *"] },
  "observability": { "enabled": true }, "workers_dev": true }
```

Wrangler ≥ 4.45.0 auto-provisions KV/R2/D1 from **id-less bindings**, writes the ids back, and keeps
them linked on later deploys even when the ids never reach the file; prompts are skipped in CI;
`--no-x-provision` disables it
(https://developers.cloudflare.com/changelog/post/2025-10-24-automatic-resource-provisioning/).
Steps 7–8 should still reconcile explicitly over the API: idempotent against a config we regenerate,
self-heals a dashboard-deleted bucket, no dependence on one wrangler version's beta.
Auto-provisioning is the mechanism for the **button** path, where there is no CLI.

**Admin key (11).** 32 random bytes → base64url → shown exactly once. The Worker never sees the
plaintext: store `sha256(key)`, compare in constant time. Deliver in the *same* deploy, so there is
no live-but-unusable window:

```bash
umask 077; f=$(mktemp)
printf 'DROPTHIS_ADMIN_KEY_SHA256=%s\nDROPTHIS_HMAC_SECRET=%s\n' "$sha" "$hmac" > "$f"
wrangler deploy --config "$cfg" --secrets-file "$f"; rm -f "$f"
```

`--secrets-file` takes JSON or `.env`, the same formats as `wrangler secret bulk`
(https://developers.cloudflare.com/workers/configuration/secrets/). The stdin path also works and is
documented — `secret put` "can also receive piped input"
(https://developers.cloudflare.com/workers/wrangler/commands/workers/) — so use
`printf %s "$sha" | wrangler secret put DROPTHIS_ADMIN_KEY_SHA256` for `--rotate-admin-key`.

**Zone matching (15).** Never split the hostname. Page `GET /zones`, keep zones whose `account.id` ==
the pinned account, take the **longest** zone name that is a suffix of the host (pagevault
`context.mjs:429` `pickZone`; `listZones` pages 10 deep because stopping at 50 hid people's domains).
Refuse when a CNAME already exists at the host — Cloudflare cannot put a custom domain over one;
`wrangler deploy` then creates the DNS record and issues the cert
(https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).

**Lifecycle (14).** `wrangler r2 bucket lifecycle add [BUCKET] [NAME] [PREFIX] --expire-days N`
(https://developers.cloudflare.com/r2/reference/wrangler-commands/). Objects go "typically within 24
hours" of expiry, 1000-rule cap (https://developers.cloudflare.com/r2/buckets/object-lifecycles/) —
say "eventual", never promise a hard TTL.

**Result object** (stdout, after the NDJSON stream):

```json
{ "ok": true, "url": "https://dropthis.acme.workers.dev",
  "mcp_url": "https://dropthis.acme.workers.dev/mcp",
  "admin_key": "K7…",                      // ONLY on the run that minted it
  "admin_key_fingerprint": "sha256:9f2c…", // always, safe to log
  "first_drop": "https://dropthis.acme.workers.dev/d/hello-3fKx",
  "account_id": "…", "bucket": "dropthis-drops", "kv_namespace_id": "…",
  "custom_domain": null, "lifecycle": { "prefix": "staging/", "expire_days": 7 },
  "worker_version": "0.1.0+ab12cd", "mcp_config_written": ".mcp.json",
  "steps": [ { "ok": true, "step": "token_valid" } ] }
```

**Re-run.** A second `init` reconciles, redeploys, and reports `"admin_key": null,
"admin_key_status": "existing"` — it *cannot* re-print the key, secrets are write-only.
`--rotate-admin-key` mints a new one, prints once, warns that every stored client config must change.
`--dry-run` stops after step 6.

## 8 — B. The Deploy-to-Cloudflare button path

The button clones the repo into the user's GitHub/GitLab, reads the Wrangler config, "provision[s]
any necessary resources and update[s] the Wrangler configuration … for newly created resources (e.g.
database IDs and namespace IDs)", and wires Workers Builds. Repo must be public, GitHub or GitLab.
Supports KV, R2, D1, DOs, Hyperdrive, Vectorize, Queues, Workers AI, Secrets Store. Secrets "can be
defined in a `.dev.vars.example` or `.env.example` file with a dotenv format". Verbatim requirement:
"please make sure your source repository includes default values for resource names, resource ID and
any other properties for each binding"
(https://developers.cloudflare.com/workers/platform/deploy-buttons/).

Note the tension — the button docs want default names **and ids**, the auto-provisioning changelog
wants ids omitted. Follow the button docs here: agent2web ships
`"database_id": "placeholder-replaced-on-provision"` (`agent2web/wrangler.jsonc:19-31`) and the button
overwrites it. So the same top-level JSONC plus a placeholder id per binding, and

```
# .dev.vars.example — leave blank to install unclaimed, then run `npx @dropthis/cf claim`
DROPTHIS_ADMIN_KEY_SHA256=
DROPTHIS_HMAC_SECRET=
```

Button: `[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/<org>/dropthis-cf)`
— shape confirmed by `cloudflare/templates/cli/src/validateD2CButtons.ts:21-22`, which asserts every
template README carries exactly that string. Copy that as a CI guard on our own README.

**First-run with no admin secret — and not "first caller wins".** Deploy **unclaimed and fail
closed**: with `DROPTHIS_ADMIN_KEY_SHA256` empty, every route except `GET /healthz` and `POST /claim`
returns `503 {"error":"unclaimed"}`, and `/healthz` reports `{"claimed":false}`. On first boot the
Worker mints a one-time claim code and writes it to R2 at `_system/claim-code` and nowhere else —
never a response body, never a log. `npx @dropthis/cf claim` uses **the operator's own Cloudflare API
token** to read that object over the R2 API, POSTs it to `/claim`, receives the admin key once; the
Worker deletes the object and stores the hash. Ownership is proved by holding an API token for the
account, not by being the first HTTP request. 24 h expiry on the code, `_system/claimed-at` marker so
re-claiming needs `--force`. Two guards to copy alongside: agent2web records its canonical public URL
only after an **authenticated** request (`src/public-url.ts:5-23,48-56`), closing the same TOFU hole
for the OAuth issuer/audience; and Sink's HTTP **423 while storage is not ready** — a visible
bootstrap gate beats a silent half-working install.

## 9 — C. Minimal human steps, honestly counted

**CLI path — 4 steps, 2 browser-only** (3 if the account and R2 already exist):
1. `[browser]` Create a Cloudflare account — https://dash.cloudflare.com/sign-up
2. `[browser]` Enable R2 + add a payment method — `https://dash.cloudflare.com/<account>/r2`. Free
   tier, nothing charged at our volumes, but the card is unavoidable. This is the seam; name it.
3. `[browser]` Create an API token — https://dash.cloudflare.com/profile/api-tokens → Create Custom
   Token, name `dropthis`: Workers Scripts — Edit · Workers KV Storage — Edit · Workers R2 Storage —
   Edit · Account Settings — Read (+ Zone DNS — Edit and Zone Workers Routes — Edit for `--domain`).
4. `[terminal]` `npx @dropthis/cf init --cf-token <paste>` → URL, first drop, admin key, MCP config.

Optional 5th `[browser]`: move a domain's nameservers to Cloudflare if the zone isn't already there —
Cloudflare has no free path to delegate one subdomain, the whole apex moves.

**Button path — 5 steps, 4 browser-only:** sign-up → enable R2 → click the button (approve the repo
clone, pick the account) → wait for the build → `[terminal]` `npx @dropthis/cf claim`. It *looks*
shorter and is not: it adds a GitHub account and a repo clone, and still ends in a terminal. Lead
with the CLI; keep the button for people who want Workers Builds CI.

## 10 — D. MCP connect snippets the installer emits

```bash
# Claude Code — verified https://code.claude.com/docs/en/mcp   (--scope local|project|user;
# `claude mcp login dropthis` (v2.1.186+) drives OAuth instead)
claude mcp add --transport http --scope user dropthis https://<host>/mcp \
  --header "Authorization: Bearer $DROPTHIS_ADMIN_KEY"

# Any stdio-only client, no code of ours — pagevault docs/setup/connect-mcp.md:69
npx mcp-remote https://<host>/mcp --header "Authorization: Bearer <DROPTHIS_ADMIN_KEY>"
```
```json
// .mcp.json (project scope) — verified, same doc. ${VAR} expansion here is UNVERIFIED:
// write the literal with chmod 600, or emit the `claude mcp add` line instead.
{ "mcpServers": { "dropthis": { "type": "http", "url": "https://<host>/mcp",
  "headers": { "Authorization": "Bearer <DROPTHIS_ADMIN_KEY>" } } } }
// .cursor/mcp.json — verified https://cursor.com/docs/context/mcp
{ "mcpServers": { "dropthis": { "url": "https://<host>/mcp",
  "headers": { "Authorization": "Bearer ${env:DROPTHIS_ADMIN_KEY}" } } } }
```
```toml
# ~/.codex/config.toml — verified https://learn.chatgpt.com/docs/extend/mcp?surface=cli
# (or: codex mcp add dropthis --url https://<host>/mcp)
[mcp_servers.dropthis]
url = "https://<host>/mcp"
bearer_token_env_var = "DROPTHIS_ADMIN_KEY"
```

claude.ai / Claude Desktop — verified
https://support.claude.com/en/articles/11175166-about-custom-connectors-remote-mcp-servers :
Customize → Connectors → **+** → Add custom connector → paste `https://<host>/mcp` → Add (OAuth
client id/secret optional under Advanced). Free plan allows one custom connector; Team/Enterprise
owners add it under Organization settings → Connectors → Add → Custom → Web. **This path needs the
OAuth 2.1 server** (`@cloudflare/workers-oauth-provider`, KV binding `OAUTH_KV`) — a static bearer
cannot be pasted into that form. It is the only reason we need the KV namespace at all.
ChatGPT connector: Settings → Connectors → add a remote MCP server by URL, OAuth-authenticated —
**UNVERIFIED**, I did not confirm the menu path or whether a bearer-only server is accepted.
