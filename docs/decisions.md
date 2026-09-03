# Decisions

Dated log of product and architecture decisions with the reason for each. Append; when a
decision is reversed, mark the old entry `superseded by #n` rather than deleting it.

All entries below: **2026-09-01**, from the design session that founded this repo. Evidence
for Cloudflare facts is in `docs/research/` (same date).

## Product

1. **Cloudflare-only, in the user's own account, instead of self-hosting on a NAS/server.**
   Removes the entire operations bar (images, Docker EOL, reverse proxies, TLS, backups,
   migration locks) that makes self-hosted OSS decay. Accepts vendor lock in exchange;
   mitigated by plain-file storage that is S3-compatible (see #11).
2. **Fresh repo, not a fork of the hosted codebase.** The hosted product is FastAPI +
   Postgres + Cloud Run with ~35k source lines and features with no users (workspaces, OAuth
   server, admin SPA, blog). Only the viewer's pure policy (~1,700 lines) and the client
   contract are worth carrying.
3. **Name stays `dropthis`; repo `dmalis/dropthis`; npm: bare `dropthis` (already owned; the
   `@dropthis` scope is not used — superseded in part by #43).**
   A personal-account repo transfers to an org later with permanent redirects.
4. **Agent-first, no dashboard.** Every operation exists as REST, CLI and MCP from one
   registry. Even a human uses it through an agent. The only HTML pages are the OAuth
   login form and a static `/_connect` help page.
5. **Two front doors: Deploy-to-Cloudflare button (human) and `npx dropthis init --json`
   (agent).** Both end by publishing a hello drop and returning its URL. The button comes
   after v1 (#44); the package name changed in #43.
6. **The human loop is exactly Cloudflare's three steps** — account, card for R2, first API
   token — and nothing of ours. Automating account creation with a browser agent was
   rejected: fragile behind Turnstile, likely against Cloudflare terms, and it puts card
   data and a root login in an agent's hands.
7. ~~**Client contract kept compatible with the hosted product**~~ — superseded by #42.
8. **Managed hosting is architected for, not built.** Anyone running the code can host
   clients: instance per client on one account, invoiced. A $5/month anonymous plan by the
   author is possible later (same Worker + Stripe Checkout → key) but is not in scope.
9. **Licence Apache-2.0.** For a deploy-to-your-own-account tool, adoption matters more than
   clone defence. (The hosted product's AGPL reasoning does not apply here.)

## Architecture

10. **One Worker serves API and content on one host.** API under the reserved prefix
    `/_api`; content at `/<slug>/`. Works on the free `*.workers.dev` hostname with no
    domain. A second `api.` hostname was rejected as an extra moving part.
11. **R2 is the only store — files are the database.** One object per entity; direct GET on
    the hot path; `slugs/<slug>` claimed with `If-None-Match: *`; `meta.json` updated with
    `If-Match` CAS. R2 is strongly consistent globally. D1 and KV as an index were rejected:
    an extra resource to create, an extra migration step, and KV's 1,000 free writes/day.
    A single Durable Object was considered as a serializer and not needed.
12. **One KV namespace is the only extra binding, for OAuth session storage** required by
    `@cloudflare/workers-oauth-provider` (see #17). Auto-provisioned; costs the installer
    nothing.
13. **Updates are atomic generation flips; no revision history.** Users update the same
    drop repeatedly; they do not need rollback. Old generation deleted after the flip.
14. ~~**Manifest-first, per-file upload.**~~ — superseded by #47: one call for every agent,
    the manifest path only inside the CLI/SDK for large sets.
15. **Instance = client = team. No tenant field.** (Team semantics in #45.) Isolation by Worker + bucket boundary; multiple
    instances per account are free (500 Workers on Paid). `tenant` can be added as one
    `meta.json` field if cross-client reporting is ever requested.
16. **Own API keys, not Cloudflare Access.** Keys: 32 random bytes, `sha256` stored,
    timing-safe compare, two scopes (`admin`, `user`). Access rejected: 50 service tokens
    per account, two headers browser MCP clients cannot send, no per-user identity.
17. **OAuth on `/_api/mcp`, via `@cloudflare/workers-oauth-provider`, in the MVP.** Forced
    by the primary users (a client team on claude.ai and the Claude desktop app) — their
    connectors speak OAuth only. Identity remains the key: the authorize page asks the
    user to paste their key. Hand-rolled OAuth rejected (the hosted product's 6,200-line
    hand-written server was a lesson).
18. **MCP transport: Streamable HTTP via `createMcpHandler`.** SSE is deprecated;
    `McpAgent` is marked for deprecation. stdio `@dropthis/mcp` stays as an alternative.
19. **Default expiry 30 days; `never` allowed unless policy forbids.** Agents forget to
    clean up; a self-hoster's bucket should not fill with dead previews.
20. **Pruning is a feature.** Daily cron over `expiring/<date>/` markers; R2 lifecycle rule
    on `staging/`; weekly orphan reconcile; `prune --dry-run` and `usage` for visibility.
21. **Expiry enforced on read (410) independent of cleanup lag.**
22. **`noindex` via `X-Robots-Tag` header, not HTML rewriting.** Works for files too.
23. **Password = HMAC unlock cookie (reused from the hosted viewer).** ~~Protected responses
    bypass the edge cache.~~ (Amended by #60: the body cache sits behind the password check.) Generated passwords are returned once in the publish response;
    delivery (SMS/email) is the caller's job (the `webhook_url` idea is post-v1, #32).
24. **Instance policy = defaults + enforced rules in `system/config.json`**, set via
    `config_set`. Per instance, not per user.
25. **Files are first-class drops.** A single PDF/xlsx/image is served at its URL with the
    right content type, `Content-Disposition: inline` by default, download on request.
26. **Schema tolerance is mandatory.** `schema` field in `meta.json`; unknown fields
    ignored, missing defaulted; lazy read-repair; one contract fixture per historical schema
    version, kept forever. Key layout is never renamed.
27. **Hostnames per drop via `hosts/<hostname>` + Workers routes/custom domains**; for
    domains outside the account, Cloudflare for SaaS (100 hostnames free, then $0.10/mo).
28. **Never put drops on a subdomain of a site whose cookies matter** (cookie scope leaks
    to parent domains). Documented for operators; a shared hostname's path-scoped unlock
    cookies are convenience, not a security boundary.

29. **`doctor` is a named check registry.** Installer and instance checks have stable IDs;
    `doctor --list --json` lists them; `doctor --json` returns ID, status, evidence and
    remediation. CLI, MCP, REST and generated reference share the registry. Reason: support
    can name one check and agents can act without parsing prose.
30. **Deployments carry a versioned release manifest.** The Deploy button points at an
    immutable release; `upgrade` refuses an instance whose deployment or data schema is newer
    than it understands; every release names data-affecting changes and its rollback floor.
    Reason: unattended upgrades must fail closed rather than guess across versions.
31. **Folder drops auto-index by policy.** `auto_index: list | gallery | off`, default
    `list` (v1 ships `list` only — #44/#60). Without `index.html`, `list` links filenames, `gallery` adds image thumbnails,
    `off` returns 404. The publish skill ships a gallery template for agents that want a
    stored, customisable `index.html`. Reason: a valid folder publish must produce a useful
    URL without a repair call. (Amends the MVP scope below.)
32. **Publish webhook is post-MVP.** Optional `webhook_url` in policy, POSTing
    `{url, slug, password, expires_at, title, meta}` on publish so external automation can deliver
    passwords by SMS/email. Not built until a first client needs it.
33. **Standard policy files ship with v1:** `SECURITY.md` (active-content boundary,
    operator abuse controls, reporting), `TRADEMARKS.md` (name and logo permissions,
    separate from Apache-2.0; plain wording, no counsel — #52). Legal notes for operators hosting
    third parties (DSA, DMCA, CRA) are not repo material until counsel has reviewed them.
34. **Carried over from the hosted-edition study** and placed by an independent Codex
    consult (2026-09-01): bootstrap invariants, reserved-path handling and release trust →
    `AGENTS.md`; doctor registry and release manifest → this log; a CI-tested lifecycle
    script (`examples/agent-lifecycle.sh`: init → publish → host → user → revoke → destroy)
    → added once the installer exists; go-to-market tactics → not repo material; the missing
    LICENSE text in the published `@dropthis/*` packages → fixed in their own repo.

35. **Listing without an N+1.** `slugs/<slug>` pointer objects carry `customMetadata`
    (`id, updated, expires, title, created_by`); `list` is one R2 `list()` call with metadata
    included and never a `get()` per drop. Sorting and the `q` substring filter over `title`
    are done in the Worker over that page (amended by #48). No index, no search, no tags. Reason: every files-only project in the study either paid a
    read per document or built a database for this one query.
36. **No stored counters.** `system/usage.json` dropped; `usage` computes from `list()` on
    demand. Reason: R2 has no atomic increment; read-modify-write counters corrupt under
    concurrency (seen racy or approximated in three studied projects).
37. **Installer design adopted from the provisioning study** (`docs/research/
    2026-09-01-provisioning-study.md` §7): token-only auth pinned into wrangler's env; REST-API
    reconcile-by-name for bucket and KV; credential minted before deploy and shipped with
    `--secrets-file` (amended by #58: the admin key is a key record written into the bucket,
    `HMAC_SECRET` the only secret); `--json` one document with `steps[]`, `--jsonl` for the
    live stream (#58); the study's 7-day staging TTL is 1 day here; `doctor`
    publishes a real hello drop and checks MCP; URL taken from the API, never stdout; re-run
    never re-prints the key; `--rotate-admin-key`, `--dry-run`, `--account-id` explicit.
38. **Button path boots unclaimed and fail-closed; `npx dropthis claim` proves ownership
    with the operator's Cloudflare token.** Rejected: "first caller becomes admin" (seen in
    one studied project), inventing a secret the operator omitted (seen in another), and
    deploying with no credential. Honest step count: CLI path 4 human steps (3 browser —
    corrected by #58), button path 5 (4 browser) — the CLI path is documented first. Button
    and `claim` come after v1 (#44).
39. **Per-instance agent skill served from the Worker at `/_skill.md`**, base URL and limits
    substituted live. Reason: one URL onboards any agent for that deployment without a
    config step (pattern from pastebin-worker).
40. **Email stays out.** Enabling Email Routing / Email Service on a zone is dashboard-only
    (zone onboarding, DNS, click-to-verify a destination); none of three email-on-Cloudflare
    projects automated it. It would add a human step to every install for a feature the
    caller's automation can do with the returned URL. Facts in the study §4.
41. **Human steps for a working instance are exactly: Cloudflare account, enable R2 (card),
    API token with the four named permissions, `npx dropthis init`.** The token
    permission names are the ones the dashboard shows; the installer echoes them verbatim on
    a 403.

## Grilling session, later on 2026-09-01

Entries 42–57 come from a design grilling (`grilling` skill) held before any code was written.
Two lenses were applied to every question: what the big tools do (evidence in
`docs/research/2026-09-01-cli-conventions.md`) and whether the answer helps a stateless agent
finish its task.

42. **Fresh contract; the hosted product's clients are archived.** Supersedes #7. Nobody but
    the author used the published `@dropthis/sdk|cli|mcp`; 20 of their 29 MCP tools were
    workspaces, members, invitations, domains and deployments — all non-goals here — and would
    have been dead tools in every agent's context. The old surface was studied for its
    reasons (idempotency hints, cache revisions, `resolve` for opaque ids, "agents re-publish
    instead of updating") and those reasons, not its shapes, are carried.
43. **One monorepo, one npm package `dropthis`, one binary.** Installer (`init`, `doctor`),
    client (`publish` …), admin (`user add` …) and the stdio MCP proxy (`dropthis mcp`) are
    subcommands of the same bare-named package, as sst, convex, flyctl, railway and pocketbase
    do. The bare npm name `dropthis` is already owned; `@dropthis/cf` is never published.
    Reason: one `npx` line to learn, no version skew between installer and client; the
    credential split is enforced by env-var name (`CLOUDFLARE_API_TOKEN` vs
    `DROPTHIS_URL`/`DROPTHIS_KEY`), not by package boundary.
44. **v1 scope and two milestones.** v1 = milestone 1 + milestone 2 + `init`, `doctor`,
    `user_*`, `config_*`, `usage`, `prune`, `/_skill.md`, contract tests. **Milestone 1
    (done when):** `npx dropthis init --json` on the author's account → Claude Code lists the
    tools → publish a folder → the URL loads with `X-Robots-Tag` and a 30-day expiry → `get`
    returns title/settings → `list` shows it → `delete` gives 404; plus one `--password
    generate` publish and one single-file PDF drop. Instance `damian.dropthis.app`.
    **Milestone 2 (done when):** the author's agent runs `user add anna` → returns a key and
    a ready-to-send message → a Byrokko colleague, from that message alone, adds the claude.ai
    connector, pastes the key, publishes a page and opens the URL, the author watching but not
    touching; then `user remove anna` ends her access in one call. Instance
    `byrokko.dropthis.app`, on the author's account. **After v1**, in order of need: `upgrade`
    (with the first release after v1), Deploy button + `claim`, `host_*`, `destroy`, gallery
    auto-index, `llms.txt`, generated reference. ChatGPT connectors: untested, not claimed.
45. **Instance = team.** Every `user` key sees and edits every drop; `created_by` is
    attribution; leaving = revoking the key. Vercel, Netlify, GitHub org, Notion: everyone in
    the team sees everything, isolation is a separate team. Agent lens: an agent handed a
    colleague's URL must never hit a permission wall inside its own team. Clients are isolated
    by instance; only the operator holds several admin keys.
46. **Five drop operations: `publish`, `update`, `get`, `list`, `delete`.** `publish` is
    create-only (always a new slug; `SLUG_TAKEN` was replaced by `idempotency_key` in #58) so re-publishing can never make a
    duplicate. `update` changes only what is given — files, settings, or both — and is
    honestly idempotent because uploads are content-addressed and there are no revision
    counters (the two reasons the old product needed two update verbs). `resolve` and
    `get_content` fold into `get(url|slug, files: true)`, which returns content inline,
    password or not, so pull → edit → `update` needs no local state (GitHub Contents API
    pattern). Industry standard is two update verbs (Vercel, Netlify); we deviate for the
    stated reason.
47. **One call uploads a drop.** `files: [{path, text} | {path, base64} | {path, url}]` (exclusive union, #58) in one request —
    the shape claude.ai, n8n and a script can all produce (Cloudinary/Uploadcare "multipart or
    fetch from URL"; Vercel inline files). The single-call ceiling is set by isolate memory
    and measured in slice 2 (expected ~50 MB); above it the CLI/SDK use the staged
    manifest → per-file streamed PUT → commit path silently. Supersedes #14. Dedupe of
    unchanged files lives on the staged path only.
48. **Drop fields.** Generated immutable slug, 10 chars `a-z0-9`, never starting with `_`
    (bit.ly/Vercel-style short ids; unguessable enough that noindex-without-password behaves
    like a share link). `title` optional, always set by agents. `meta`: agent-owned JSON ≤ 16
    KB, any JSON values, merged on `update`, `null` deletes a key, returned by `get`, not in
    `list` (Stripe metadata semantics, minus the string-only rule that gave the old product
    422s). `access` is an object (`{password_hash}` today) so a paid unlock can be added
    later without a layout change. Vanity slugs and rename: not in v1; vanity is one field
    away, rename is a non-goal ("permanent URL").
49. **Expiry: 410 at once, 7-day grace, then delete.** Google Drive/Dropbox keep deleted
    items 30 days; sharing tools delete outright. Agent lens: "the link died, bring it back"
    must be `update(url, {expires: "30d"})`, not "the files are gone". Formats `"7d"`, a
    date, `"never"`; policy `max` and `allow_never` enforced. `expiring/<date>` markers are
    dated `expires_at + grace` and are hints: cron re-reads `meta.json` before deleting.
50. **Passwords: `generate` is the agent default; chosen ≥ 8 chars allowed.** PBKDF2-SHA256
    at the highest iteration count the plan's CPU budget allows (measured; Free = 10 ms).
    No attempt rate limiting in v1 (no counters, #36) — stated in `SECURITY.md`; a drop that
    must not be guessed uses a generated password. The agent hands the human a ready-to-send
    message with the URL and the password; dropthis never returns a password again.
51. **One `Drop` shape everywhere, `password` once, structured errors, no hints.** Stripe/
    GitHub/Vercel return the full object on create, update and get. Errors are `{code,
    message, remediation}`; the remediation is the only hint and appears only off-path. No
    `next` hints on success — the URL is the id, nothing to re-teach, and text costs context
    on every call.
52. **Apache-2.0 stays; no CLA, no DCO; `TRADEMARKS.md` in plain words without counsel.**
    Deploy-to-your-own-account tools are permissive (wrangler, Sink, PocketBase, Supabase);
    copyleft is for products that sell hosting.
53. **Auth stays #16/#17; key-in-URL rejected.** A `/_api/mcp/<key>` endpoint would have
    removed OAuth and KV from v1 and works in every connector, but a secret in a URL fails
    the first security questionnaire, lands in URL logs, and connector directories require
    OAuth. One key, two presentations (header; OAuth paste page), never a third. A spike
    against a real claude.ai connector runs before OAuth code lands.
54. **Selling content: a door, not a feature.** Gumroad/Lemon Squeezy/Stripe Checkout
    pattern: product = file + price, pay, webhook, deliver an unlock. In this design "paid"
    is one more `access` rule on the same cookie mechanism, orders are files, dropthis never
    touches money. Nothing is built; `access` is shaped now so nothing has to move later.
    Same for `webhook_url` as an event bus (`published`, `paid`, `expired`) feeding Telegram
    or n8n.
55. **Tests run against a throwaway `dev` instance on the author's account, wiped per run,
    from the developer's machine. No CI before the first public release.** Supabase, wrangler
    and flyctl test against a dedicated project, never the maintainer's live one. The `dev`
    instance doubles as the claude.ai OAuth spike target. Commits go straight to `main`.
56. **CLI conventions adopted from the study (`docs/research/2026-09-01-cli-conventions.md`):**
    bare verbs for the hot path + `noun verb` for admin; env beats file;
    `~/.config/dropthis/instances.json` with `--instance`/`DROPTHIS_INSTANCE` (as `gh`
    `hosts.yml`); `connect --client …` applies MCP registration (Claude Code via `claude mcp
    add`, so keys never land in a repo); non-interactive when not a TTY or an agent is
    detected; `--json` = one document, NDJSON only for streams; stdout = result, on `publish`
    only the URL; exit codes `0/1/2/4` as `gh`; `@latest` only on the `init` line.
57. **Engineering calls made in the same session, open to objection:** 429 + `Retry-After`
    on R2's per-key write rate instead of a Durable Object; `list` ≤ 1,000 per page with
    cursor; sixth instance on a Free account needs Workers Paid (five cron triggers) —
    documented, no mode added; MCP tool names prefixed `dropthis_`; the "TOML gets no ids
    written back" claim is unverified and softened in AGENTS.md; single-call upload ceiling
    is measured in slice 2 before being written into the skill.

## Independent review, 2026-09-01

58. **Codex review of the v1 spec (round 1: 1 blocker, 19 majors, 3 minors) — all applied.**
    Changes to grilled decisions, with the reason: **(a)** milestone 2 names a claude.ai
    **Owner** who adds the connector once — on Team/Enterprise plans members cannot add
    custom connectors; each member then logs in with their own key. **(b)** `SLUG_TAKEN` is
    gone: with generated slugs a caller cannot collide; the duplicate-on-retry risk is solved
    the industry way with an optional `idempotency_key` on `publish`/`update` (Stripe) and a
    `requests/` record. **(c)** No `ADMIN_KEY_HASH` secret: the admin key is an ordinary key
    record the installer writes into the bucket before the first deploy, so every credential
    has one listing, rotation and revocation path; `HMAC_SECRET` is the only secret.
    **(d)** Newest-first `list` cannot come from `slugs/` (R2 lists in key order), so a
    `list/<inverted-created>-<slug>` pointer prefix is the listing index — still one `list()`
    per page, still files. **(e)** v1 is private, run from the repo build; `dropthis@1.0.0`
    on npm is a separate first-public-release milestone that carries the release-trust gate.
    Engineering clarifications, no decision changed: `meta.json` is the only truth and
    projections are repaired lazily; gen id = manifest hash so identical content is a no-op;
    `UPDATE_CONFLICT` vs `R2_RATE_LIMIT` distinguished; upload entries are an exclusive
    `text | base64 | url` union with path rules and URL-fetch limits inside the Free
    subrequest budget; one `canonical_url` + `alias_origins`, `WRONG_INSTANCE` for foreign
    URLs; unique user labels via `users/<label>` pointers and `created_by {id, label}`;
    password record and cookie fully specified with a rotating nonce; four-state expiry
    table; viewer re-reads pointer + `meta.json` before every response and browsers get
    `no-cache`; resumable cron with `system/prune-state.json`; `doctor` is instance-only,
    account preflight lives in `init`; `--json` always one document, `--jsonl` for streams;
    serving matrix and `/_api/v1/drops/<slug>/files/<path>` download route; policy changes
    are prospective; frozen error catalogue; `usage`/`prune` share one shape; a fourth test
    seam (local fake Cloudflare management API for `init` failure paths; manual recorded
    acceptance for claude.ai). Milestone 1 checklist gains `dropthis connect --client
    claude-code`. Stale clauses in #3, #23, #37, #38 marked.
59. **Two research rows flagged stale by the review, marked UNVERIFIED in place:** Workers
    subrequest limits (Free 50 external / 1,000 internal; Paid default now 10,000) and
    wrangler id write-back for TOML. Re-verify against current docs before sizing anything.

60. **Codex review round 2 (0 blockers, 5 partials, 5 majors, 7 minors) — all applied.**
    Precision only, no decision changed: per-instance resource names derived from
    `--name` (`dropthis-<name>`, `-drops`, `-oauth`, `NAME_TAKEN` on clash); idempotency
    record claimed before side effects and its response encrypted at rest (a generated
    password may be inside), "returned once" defined; the claude.ai spike is phase zero;
    the staged upload path fully specified (`/_api/v1/uploads`, signed PUTs, `commit`,
    CLI-only in v1) and single-call uploads no longer stage; frozen Free-safe initial policy
    (`max_request_bytes` 25 MB, `pbkdf2_iterations` 5,000, `cron_ops_budget` 40) with a
    `doctor` benchmark instead of measuring during `init`; upload limits derived from the
    subrequest budget (≤ 500 files, ≤ 20 URL files, ≤ 45 fetches); hourly resumable cron with
    a numeric budget; frozen MIME table and text-typed definition; string-only R2
    `customMetadata` (state derived at list time); `expires_at` everywhere, bare dates are
    UTC midnight; `q` = NFC + case-folded substring; `doctor` check registry (#29) with
    result shape; protected bodies cacheable behind the check (#23 amended); crash-safe
    admin rotation; `auto_index: list` only in v1 (#31 amended).

61. **Codex review round 3 (run A: 13 resolved / 4 partial; run B: 0 blockers, 7 majors,
    3 minors) — all applied.** One real change: **content-addressed blobs.** The Workers R2
    binding has no server-side copy, so "unchanged files are R2-copied into the new
    generation" could not work. Files now live at `drops/<id>/blobs/<sha256>` and a
    generation is the manifest inside `meta.json`; unchanged files cost nothing on update,
    unreferenced blobs are deleted after the flip. Precision: the slug is claimed before
    `meta.json` exists (collision found first, claim removed if the CAS fails);
    idempotency uses two write-once keys (`claim`, `result`) because R2 allows one write per
    second per key, with a 60 s abandoned-claim rule; the cron checkpoints once per
    invocation with harmless replay; `init` renders a per-instance wrangler config with the
    reconciled KV id (KV cannot be bound by name); `uploads/` gets its own lifecycle rule;
    the staged `commit` carries the same settings as `publish`/`update` and is bound to the
    creating key; admin rotation records `previous` in `users/admin` so a rerun can finish;
    exact MIME table; `init` reports `doctor` results instead of a `first_drop` URL that the
    hello-drop cleanup would already have deleted. Codex's sandbox is read-only here, so
    reviews keep alive with `echo` tool calls, not progress files.

62. **Codex review round 4 (run A: 12 resolved / 1 partial / 1 open; run B: 0 blockers,
    8 majors, 2 minors) — all applied.** Staged PUTs now write blobs straight to their final
    key, so commit copies nothing and the subrequest budget holds; the idempotency claim
    carries the identity (drop id, slug, gen, generated password) so retries converge
    instead of racing, `IDEMPOTENCY_IN_PROGRESS` is gone, and fault-injection tests abort
    after every write step; the staged commit is fenced by the session's payload hash and
    replays its stored result; `user add`/`user remove` have a crash-safe order and one
    shared label-normalization function; a past `expires` is rejected everywhere; `connect`
    never puts the key in argv or a config file (Claude Code `headersHelper`, env-var
    references elsewhere); `config set` enforces hard ceilings (64 MB encoded request,
    100 MB file); account-level checks (`lifecycle_rules`, `kv_bound`, `domain_attached`)
    move from `doctor` to `init --check`; `title` ≤ 200 bytes, labels ≤ 64 bytes; the
    reference-docs generator is after v1 (the registry generates REST/CLI/MCP in v1).

63. **Codex review round 5 (run A: 11 resolved / 1 partial; run B, triaged: 9 must-fix majors,
    1 TDD item) — all applied.** The one that changes a number users see: **inline uploads
    default to 2 MB** (`max_request_bytes`) — the Worker must JSON-parse, base64-decode and
    handle inline bytes inside Free's 10 ms CPU, so "25 MB in one call" was never true
    there; `url` and staged entries stream to R2 with R2 verifying the hash, so large files
    go that way and `/_skill.md` says so. Precision: content is resolved and blobs written
    before the idempotency claim, and the claim carries the manifest and a `state_hash` of
    the whole desired `meta.json` (a `current_gen` match alone could pass a CAS loser);
    staged sessions use three write-once keys; admin rotation writes `users/admin` once per
    run; the cron never checkpoints past a UTC day still in progress; policy defaults apply
    on `publish` only, rules on provided fields, omitted non-compliant fields are
    grandfathered; a frozen REST route table; the shared-origin cookie boundary (#28)
    restated as accepted and pinned by a test; canonical JSON = RFC 8785.

64. **Codex review round 6 (run A: 7 resolved / 3 partial / 1 open — the open one is the
    shared-origin boundary, accepted by #28; run B, triaged: 8 must-fix majors, 2 TDD items)
    — all applied, and the review loop stopped here.** Applied: `url` entries carry an
    optional `sha256`+`size` (R2 verifies, no Worker CPU) and undigested URLs are capped by
    `max_unhashed_bytes`; staged sessions record the target's base ETag and commit CASes
    against it; a slug pointer owned by a live staged session is not reaped; expiry changes
    delete the old marker and the cron deletes stale markers; canonical path encoding;
    one error wire shape per surface; continuation cursors on `usage`/`prune`; re-sending
    the current password is a no-op; JCS does no normalisation. **Why stop:** six rounds,
    ~90 findings applied; rounds 4–6 each returned a fresh set of 8–9 "must-fix" items one
    level finer than the last, which is the class of decision test-first implementation
    settles against the deployed `dev` Worker. Codex reviews resume per implementation slice,
    on code and tests, not prose.

65. **The v1 spec is committed at `docs/spec-v1.md`, by owner instruction.** An explicit
    exception to the no-plan-files rule so the spec survives session context loss. Rules
    that keep it from rotting: current code beats it on conflict; superseded sections are
    marked, not edited away; it is retired (marked historical) when v1's milestones pass.

## Follow-up grilling, 2026-09-03

66. **Topology, marketing, self-hosting, demo — settled in a follow-up grilling.**
    (a) `dropthis.app` root = marketing; every instance is one subdomain (`damian.`,
    `byrokko.`, future managed clients `<client>.dropthis.app`) — the Vercel-style split,
    and #28 keeps drops off any cookie-bearing domain. (b) "Self-hostable" is defined as
    the current design: your own Cloudflare account, `npx dropthis init`, no central
    service — no second backend gets built (#1 stands). (c) The marketing site comes after
    v1 and is dogfooded: a root drop at `dropthis.app` served via `host_*` — dropthis
    hosting its own site is the credibility signal. (d) The demo/public-playground idea is
    skipped; if a public playground is ever wanted (Reddit showcase), it gets its own
    abuse-control grilling first. Priority order confirmed: operator instance (milestone 1),
    then Byrokko (milestone 2). Work is ticketed as GitHub issues #1–#14 (`ready-for-agent`),
    issue numbers = ticket numbers.

## Install DX, 2026-09-03

67. **Browser login for humans; the API token becomes the automation-only path.** The
    token-creation page (pick 4 permissions, paste a secret) was the worst step of the
    install. Interactive `init` with no token now signs in with wrangler's OAuth (one
    Allow click) and guides: it opens the exact dashboard page at each human-only wall
    (sign-in; R2 enable on `code: 10042` → `https://dash.cloudflare.com/<account-id>/r2`),
    polls, resumes. Human install drops from 4 steps (3 browser) to 3 steps (2 browser).
    The safety of the old "token-only, never ambient `wrangler login`" principle survives
    as guards: an env token always wins; login mode refuses to run when more than one
    account is visible (`--account-id` or a token required); whichever credential is
    active is pinned into wrangler's environment and its source printed; non-interactive
    with no token exits 4 naming the token URL and the four permissions. Mechanics of
    login-mode provisioning (no parsing of wrangler's human stdout — machine output or
    REST only) are settled in the installer slice, issue #10. Same session also confirmed
    the licence stays Apache-2.0 (#52): the requirement was "I sell hosting, others
    self-host freely", which permissive licensing already grants; blocking competitors was
    explicitly not wanted.

68. **Byrokko's instance lives entirely on Byrokko's side: their Cloudflare account AND a
    hostname in a zone they own** (their designated domain, e.g. under `byrokko.com`) —
    never a `dropthis.app` subdomain. Reason: the instance runs for their team only, on
    their infrastructure; and a custom domain must be in the same Cloudflare account as
    the Worker, so a `dropthis.app` hostname would need unverified cross-account DNS
    (former assumption A1 — now moot). Amends #66(a): `<client>.dropthis.app` subdomains
    apply only to instances hosted in the operator's own account (managed hosting), not to
    client-owned accounts. Amends the #44 milestone-2 wording accordingly.

69. **`init --name` is optional; the default instance name is `main`.** Most accounts hold
    exactly one instance, and setup ease is the product's selling point — the happy path
    asks zero naming questions (`npx dropthis init --domain …` suffices). Industry pattern:
    Vercel derives the name, Fly generates one, create-cloudflare prompts with a default.
    A rerun without a name reconciles `main` (the normal self-heal) and its output says
    "pass `--name <other>` for a separate instance"; a second instance always requires an
    explicit name — no auto-suffixing, an accidental second Worker+bucket is worse than an
    error. The solo default user is the admin key `init` mints; `user add` is only for
    additional people. Amends #44's milestone-1 wording (operator instance is `main`).

70. **Stack chosen: maintained libraries over hand-rolled code, full circle.** Worker: Hono,
    @modelcontextprotocol/sdk + @hono/mcp, @cloudflare/workers-oauth-provider (#53), zod
    (registry schemas → REST + MCP + CLI from one definition), canonicalize (RFC 8785),
    WebCrypto built-ins. CLI/installer: the official `cloudflare` typed SDK for every
    provisioning call, bundled wrangler for deploy + browser login, commander,
    @vercel/detect-agent, @clack/prompts. Tests: vitest; Hono for the fake Cloudflare API;
    the MCP SDK's client in the corpus. No library for storage or the pure domain functions
    (slugs, paths, policy, expiry) — that is the product. Versions are pinned and each
    library re-verified as maintained the day its slice starts; the AGENTS.md Stack block is
    the living list and changes only together with a decision entry.

## Implementation start, 2026-09-03

71. **Three clarifications at implementation start (from the Codex review of the first
    slice specs).** (a) `GET /_api/v1/health` joins the frozen route table: unauthenticated
    `200 {"ok": true}`, nothing else disclosed — `init` needs a poll target while the deploy
    propagates, and the after-v1 unclaimed bootstrap already assumed a health route.
    (b) The phase-zero claude.ai spike gates the OAuth slice (#12) and the auth contract, not
    the whole repo: storage and bearer slices carry no OAuth assumption and run in parallel
    with the spike (the owner started both lanes together); a failed spike revises the auth
    contract before #12. (c) "slice 2 measures `max_request_bytes`" referred to the
    pre-ticket phase list; the measurement belongs to issue #3, the R2 truth slice.

72. **Phase-zero spike PASSED — the auth contract stands.** 2026-09-03, real claude.ai
    (Max plan): a custom connector at a Worker-hosted `/_api/mcp` (Streamable HTTP,
    `@cloudflare/workers-oauth-provider`) completed login through the one-form paste-key
    authorize page; the tool list rendered (`spike_echo`); scripted PKCE flow, wrong-key
    rejection and tools/call all passed (transcript in the session scratchpad,
    spike-verify.md). One binding finding: claude.ai identified itself via **Client ID
    Metadata Documents** (`client_id=https://claude.ai/oauth/mcp-oauth-client-metadata`),
    not dynamic client registration — the OAuth slice (#12) must support CIMD first-class
    (keep DCR enabled for other clients). Throwaway Worker + KV deleted after the run.

73. **Measured Free-plan values replace the provisional ones (issue #3).**
    `max_request_bytes` = 4 MiB (4,194,304; 10/10 shuffled passes at 254 ms median, with 6
    and 8 MiB also passing — 4 MiB keeps two measured steps of headroom).
    `pbkdf2_iterations` = 25,000 (6.1 ms/derive; 50,000 costs 12.5 ms, over the 8 ms
    budget). Method + transcripts: docs/research/2026-09-03-free-plan-measurements.md.
    Corrections the measurements forced: the "Free = 10 ms CPU per request" premise is
    stale (allowance refills; the kill is load-dependent error 1102), R2 same-key
    contention returns code 10058 and only bites CONCURRENT writers (serial full-speed
    writes all succeed), and the dev account is proved Workers Free (code 100328 refusing
    cpu_ms limits). Numbers live in packages/worker/src/policy/defaults.ts, pinned by test.

## v1 scope (frozen by #44)

In: `publish`, `update`, `get`, `list`, `delete`; generated slugs; `title`, `meta`; expiry
with grace + prune; password; noindex; files as drops; auto-index `list`; keys with two
scopes; `user add|list|remove`, `config get|set`, `usage`, `prune`, `doctor`; REST + CLI +
MCP from one registry; OAuth on `/_api/mcp`; `init`, `doctor`, `connect`; `/_skill.md`
served per instance; contract tests against a deployed `dev` instance.

After v1 (doors kept open, #44/#54): `upgrade`, Deploy button + `claim`, `host_*`,
`destroy`, gallery auto-index, `llms.txt`, generated reference, vanity slugs, `webhook_url`,
paid unlock.

Out: everything in AGENTS.md "Non-goals".

## Kill criterion

Measure at 90 days after first public release: installs, stars, hosted requests. If usage is
below the hosted product it replaces, it stays a personal tool and no paid plan launches.

## Competitive context

See `docs/research/2026-09-01-competitors.md` (dated snapshot; not maintained here).

74. **The idempotency claim fixes every clock-derived value, not only the identity
    (issue #4).** The claim was specified as `{payload_hash, drop_id, slug, gen, manifest,
    state_hash, created}`. The fault-injection contract tests proved that is not enough:
    a retry re-resolved `expires: "30d"` against its own clock, produced an `expires_at`
    a second later than the first attempt's, and so hashed to a different desired state —
    the CAS-equality check missed and a converging retry answered `409 UPDATE_CONFLICT`
    instead of the drop. `expires_at` now lives in the claim beside `created`, and a resume
    skips expiry re-resolution entirely (the payload already matched a claim this instance
    wrote, so it was valid then; re-validating could also fail an absolute date that has
    since passed). The general rule, recorded because it will apply to `update` and to the
    staged commit as well: **anything the first attempt read from the clock belongs to the
    claim.** Proven by `contract-tests/drops.test.ts`, which aborts after each of blobs,
    claim, slug, meta and projections and asserts the retry converges on one drop.

75. **The lifecycle slice's four rulings (issue #5).** (a) **The `list/` key takes its
    milliseconds from the drop id, not from `created`.** `created` is RFC 3339 at second
    precision — a frozen response field — so drops published inside one second shared a key
    prefix and fell back to sorting by their random slug; the contract test that publishes 35
    drops and pages them caught it. The id is a ULID, carries the millisecond, and is fixed by
    the idempotency claim, so the key is stable across retries. (b) **`charset=utf-8` is
    declared at the serving seam, never stored in the manifest.** A browser given `text/html`
    with no charset falls back to a legacy encoding and renders `·` as `Â·` (observed on a real
    drop). The manifest's `content_type` is hashed into the drop's state and returned in
    `Drop.files[]`, so putting the parameter there would change stored data and the response
    shape; `serve.ts` adds it for exactly the set `get(files: true)` inlines as text.
    (c) **A reader deletes a projection only on proof.** `list` removes a `list/` pointer when
    it names a drop id whose `meta.json` is gone; a pointer it cannot interpret is skipped and
    left alone, because destroying the row of a live drop is the one mistake a tolerant reader
    must not make. (d) **`update` accepts `title: null`.** `meta.json` already stores
    `title: string | null`, so without it a title could be set but never unset; it mirrors
    `password: null` and the `meta` null-delete.

76. **Concurrent `update` is `409`, not `429` (issue #5, measured).** Ten `PATCH` of one drop
    issued at once give 1 success and 9 `UPDATE_CONFLICT`, five runs out of five (occasionally
    2 successes — a request issued at the same instant can arrive late enough to read the etag
    the first winner wrote, and winning on it is correct). `429 R2_RATE_LIMIT` never appears on
    this path: R2 evaluates the `onlyIf` precondition first and reports a lost race by resolving
    the `put` to `null`, so its own per-key refusal (10058) is never reached. The 429 mapping
    stays and is proven at the seam by `contract-tests/storage.test.ts`. The slice spec had
    expected a 429 here; the owner ruled the measurement is the correct behaviour. Transcript in
    `docs/research/2026-09-03-free-plan-measurements.md`.

77. **The contract project runs one file at a time (issue #5).** There is one deployed dev
    Worker and one bucket. With files in parallel, a file that publishes drops and a file that
    asserts what the bucket contains measure each other — `drops.test.ts`'s "leaves nothing
    served" check failed against slug pointers `lifecycle.test.ts` had just created. Serial
    files, one bucket reset per run.

78. **Six rulings the keys slice needed (issue #7).** All are choices the spec left open;
    each is recorded with what it cost to decide otherwise.
    (a) **The registry declares the whole frozen route table, handlers or not.** `update`,
    `list` and `delete` (issue #5) carry their frozen method, path, params and scope with
    `schema: z.unknown()` and no handler; the router mounts only entries that have one, and
    `registry-table.test.ts` asserts exactly which are still pending. The contract is one
    document even while it is built by two branches.
    (b) **`user add` takes `{label, idempotency_key?}` and mints `user` keys only.** No
    `scope` field: a second admin credential is `init --rotate-admin-key`'s business, and
    an HTTP call that could mint one would be a contract addition past frozen v1.
    (c) **`config set` may not touch `canonical_url`, `alias_origins` or `instance_name`,
    and validates the whole resulting policy.** Those three are `init`'s — a call that could
    move the canonical origin could take an instance off its own domain. Whole-policy
    validation is why lowering `expiry.max` under the current `expiry.default` is refused
    rather than stored: a policy that forbids its own default fails every later publish.
    New hard ceilings: `pbkdf2_iterations` 100,000 (workerd refuses 200,000, #73) and
    `cron_ops_budget` 45 (Free allows 50 subrequests).
    (d) **`usage` and `prune` ship the engine issue #6's cron will call.** #6 owns the
    hourly trigger, `system/prune-state.json` and the reconcile; this slice owns the scan
    and the deletion of `expired_final` drops, so the operator has the manual lever now and
    the cron has one implementation to wire. `dry_run` defaults to **true**: an agent that
    forgot the flag must not delete. The scan's cursor is the **last finished drop id**,
    resumed with R2 `startAfter: drops/<id>0`, not an R2 page cursor — the ops budget runs
    out in the middle of a page, and a page cursor would silently skip the rest of it.
    (e) **A `doctor` check whose subject does not exist is `skip`.** `mcp_initialize` (#8)
    and `cron_state` (#6) name their issue in the evidence. `canonical_origin` and
    `policy_readable` judge the STORED `system/config.json`, never the resolved config: the
    resolved reader falls back to the request's own host on purpose, so it looks correct
    exactly when the stored value is missing. `pbkdf2_benchmark` reports the fastest of
    three derives — one sample measures the machine's noise as much as the derive.
    (f) **One dev instance per developer, not one shared one.**
    `scripts/deploy-dev.mjs --instance <name>` (or `DROPTHIS_DEV_INSTANCE`) derives Worker,
    bucket and KV from the name, and `contract-tests/base-url.ts` derives `BASE_URL` and
    `DEV_BUCKET` the same way; the default `dev` keeps its existing config and secret paths
    so its `HMAC_SECRET` is never re-minted. Forced by two agents sharing `dropthis-dev`:
    each deploy answered the other's contract run and each run's bucket reset wiped the
    other's fixtures. The contract project also runs `fileParallelism: false` — one
    instance, one bucket, one policy, so its test files are inherently serial.
