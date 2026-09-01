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
3. **Name stays `dropthis`; repo `dmalis/dropthis`; npm scope `@dropthis` (already owned).**
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
23. **Password = HMAC unlock cookie (reused from the hosted viewer).** Protected responses
    bypass the edge cache. Generated passwords are returned once in the publish response;
    delivery (SMS/email) is the caller's job — optional `webhook_url` in policy for that.
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
    `list`. Without `index.html`, `list` links filenames, `gallery` adds image thumbnails,
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
    `--secrets-file`; NDJSON step stream + one result object under `--json`; `doctor`
    publishes a real hello drop and checks MCP; URL taken from the API, never stdout; re-run
    never re-prints the key; `--rotate-admin-key`, `--dry-run`, `--account-id` explicit.
38. **Button path boots unclaimed and fail-closed; `npx dropthis claim` proves ownership
    with the operator's Cloudflare token.** Rejected: "first caller becomes admin" (seen in
    one studied project), inventing a secret the operator omitted (seen in another), and
    deploying with no credential. Honest step count: CLI path 4 human steps (2 browser),
    button path 5 (4 browser) — the CLI path is documented first.
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
    generate` publish and one single-file PDF drop. Instance `damjan.dropthis.app`.
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
    create-only (`409 SLUG_TAKEN → "call update"`) so re-publishing can never make a
    duplicate. `update` changes only what is given — files, settings, or both — and is
    honestly idempotent because uploads are content-addressed and there are no revision
    counters (the two reasons the old product needed two update verbs). `resolve` and
    `get_content` fold into `get(url|slug, files: true)`, which returns content inline,
    password or not, so pull → edit → `update` needs no local state (GitHub Contents API
    pattern). Industry standard is two update verbs (Vercel, Netlify); we deviate for the
    stated reason.
47. **One call uploads a drop.** `files: [{path, content}]` or `{path, url}` in one request —
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
