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
5. **Two front doors: Deploy-to-Cloudflare button (human) and `npx @dropthis/cf init --json`
   (agent).** Both end by publishing a hello drop and returning its URL.
6. **The human loop is exactly Cloudflare's three steps** — account, card for R2, first API
   token — and nothing of ours. Automating account creation with a browser agent was
   rejected: fragile behind Turnstile, likely against Cloudflare terms, and it puts card
   data and a root login in an agent's hands.
7. **Client contract kept compatible with the hosted product** so `@dropthis/sdk`, `cli`
   and `mcp` keep working with a base-URL change. Unimplemented endpoints return 404.
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
14. **Manifest-first, per-file upload.** Client sends hashes, server names the missing
    ones, client PUTs those, commits. One file per request because Workers cap request
    bodies at 100 MB on every plan. Unzipping happens client-side (10 ms CPU on Free).
15. **Instance = client. No tenant field.** Isolation by Worker + bucket boundary; multiple
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
    `{url, slug, password, expires_at, label}` on publish so external automation can deliver
    passwords by SMS/email. Not built until a first client needs it.
33. **Standard policy files ship with v0.1:** `SECURITY.md` (active-content boundary,
    operator abuse controls, reporting), `TRADEMARKS.md` (name and logo permissions,
    separate from Apache-2.0; wording needs counsel). Legal notes for operators hosting
    third parties (DSA, DMCA, CRA) are not repo material until counsel has reviewed them.
34. **Carried over from the hosted-edition study** and placed by an independent Codex
    consult (2026-09-01): bootstrap invariants, reserved-path handling and release trust →
    `AGENTS.md`; doctor registry and release manifest → this log; a CI-tested lifecycle
    script (`examples/agent-lifecycle.sh`: init → publish → host → user → revoke → destroy)
    → added once the installer exists; go-to-market tactics → not repo material; the missing
    LICENSE text in the published `@dropthis/*` packages → fixed in their own repo.

35. **Listing without an N+1.** `slugs/<slug>` pointer objects carry `customMetadata`
    (`id, updated, expires, label`); `list` is one R2 `list()` call with metadata included and
    never a `get()` per drop. Sorting is done in the Worker over that page. No search, no
    filter by tag: non-goals. Reason: every files-only project in the study either paid a
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
38. **Button path boots unclaimed and fail-closed; `npx @dropthis/cf claim` proves ownership
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
    API token with the four named permissions, `npx @dropthis/cf init`.** The token
    permission names are the ones the dashboard shows; the installer echoes them verbatim on
    a 403.

## MVP scope (frozen)

In: publish, update_content, update_settings, get, list, delete, resolve; slug/vanity slug;
expiry + prune; password; noindex; files as drops; keys with two scopes; `user_*`, `host_*`,
`config_*`, `usage`, `prune`, `doctor`; `auto_index`; REST + CLI + MCP from one registry;
OAuth on `/_api/mcp`; installer `init | upgrade | destroy | doctor`; Deploy button; two
skills (user, admin) plus `/_skill.md` served per instance; `llms.txt`; generated reference
and connect recipes; `claim` for the button path; contract tests against a deployed instance.

Out: everything in AGENTS.md "Non-goals", plus `webhook_url` (#32).

## Kill criterion

Measure at 90 days after first public release: installs, stars, hosted requests. If usage is
below the hosted product it replaces, it stays a personal tool and no paid plan launches.

## Competitive context

See `docs/research/2026-09-01-competitors.md` (dated snapshot; not maintained here).
