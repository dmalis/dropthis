# Section B — Direct competitor sweep

**Question:** does an OSS, agent-first "publish HTML/site → permanent URL" tool that runs in the
user's own Cloudflare account, multi-user, MCP-first, already exist?

All star counts and push dates read **2026-09-01** via authenticated `gh api` (verified by me this
session) unless tagged UNVERIFIED.

| Tool | URL | ★ | What it does | Own account / SaaS | Multi-user | MCP | Last commit |
|---|---|---|---|---|---|---|---|
| Claude Code Artifacts | https://code.claude.com/docs/en/artifacts | n/a | Built-in publish of one HTML/MD page → claude.ai URL, live update, versions, comments, org share | Anthropic SaaS; Pro/Max/Team/Ent only | Yes (org roles) | No — built-in tool; **off in Agent-SDK / MCP / API-key / Bedrock / Vertex sessions, and for CMEK/HIPAA/ZDR orgs** | beta since 2026-06-18 |
| coda0HQ/open-artifacts | https://github.com/coda0HQ/open-artifacts | **50** | "Self-hosted Claude Code Artifacts on Cloudflare" — Workers+D1+R2, versions, client-side password, update-in-place; per-artifact write tokens stored **SHA-256 only**, one optional `CREATE_TOKEN` | **Own CF** (`git clone` + `wrangler deploy`) | **No** — no accounts, single-tenant (teams only in the closed coda0.com SaaS) | **No** — Agent Skill only (`npx skills add coda0HQ/open-artifacts`) | 2026-08-27, MIT |
| jonesphillip/sharehtml | https://github.com/jonesphillip/sharehtml | **127** | CLI deploys HTML/MD/code to your own Worker+R2+Durable Objects; live comments, reactions, presence | **Own CF** | No (Cloudflare Access optional) | No | 2026-04-09 |
| FactrueSolin/cf-page-publish-mcp | https://github.com/FactrueSolin/cf-page-publish-mcp | 15 | Publish / update / delete HTML pages into your own Worker+KV, returns preview link (Chinese docs) | **Own CF** | No | **Yes** | **stale — 2025-07-26**, MIT |
| iBala/open-artifact | https://github.com/iBala/open-artifact | 6 | Publish + inline comments; the agent can read reviewer feedback back | Docker + SQLite + SMTP — **not Cloudflare** | **Yes** — roles, signup modes, domain allowlist | **Yes** (`/mcp`, OAuth or bearer) | 2026-08-31; licence `NOASSERTION` = **Sustainable Use, fair-code, not OSI-open** |
| danjamk/pagevault | https://github.com/danjamk/pagevault | 3 | `npm i -g pagevault && pagevault init` stands up Worker+KV in ~10 min; MCP runs inside the Worker; per-doc viewer gating via Zero Trust email codes | **Own CF** | Partial — per-client viewer portals, one publisher | **Yes** (remote, in-Worker) | 2026-08-21, MIT |
| raveli/agent2web | https://github.com/raveli/agent2web | 1 | 11 `site_*` tools (publish, update, list, read, set_access, rename, set_domain, versions, rollback, delete); Deploy-to-Cloudflare button; admin password PBKDF2-600k + TOTP | **Own CF** (Workers+D1+R2; needs Workers Paid $5/mo) | **No** — hard single-owner | **Yes** + OAuth 2.1 and static bearer | 2026-08-01, MIT |
| perzeuss/cloudflare-pages-mcp | https://github.com/perzeuss/cloudflare-pages-mcp | 0 | The only entrant driving real **Cloudflare Pages Direct Upload** — multi-file, binaries, create project + deploy | Own CF | No — one shared CF API token | **Yes** (Streamable HTTP + OAuth 2.1/PKCE) | 2026-08-12 |
| JamesANZ/artifact-host-mcp | https://github.com/JamesANZ/artifact-host-mcp | 0 | Cloudflare Worker MCP that publishes HTML, PDF, images, code and binaries to permanent share links, with TTL | **Own CF** (Worker+R2) | No — single API key | **Yes** | 2026-06-10 |
| Tapetide-hq/agentdraft · domuk-k/pubifact | https://github.com/Tapetide-hq/agentdraft · https://github.com/domuk-k/pubifact | 0 · 0 | Versioned review URLs via Go CLI / `POST /up` with password + delete tokens; both Cloudflare-native | **Own CF**, MIT | No (public/private flag only) | **No** (skill / shell script) | 2026-08-28 · 2026-07-06 |
| cloudflare/mcp-server-cloudflare | https://github.com/cloudflare/mcp-server-cloudflare | 4,133 | 16 first-party MCP servers. Workers-Bindings exposes `r2_bucket_create`, `d1_database_create/query`, `kv_*`, `workers_list/get_worker` — **no R2 object put, no script deploy, no static-assets, no Pages tool**. Only `mcp.cloudflare.com` reaches deploy, via generic `search()`/`execute()` over ~2,500 endpoints | Own CF | Per-user CF OAuth | Yes | 2026-08-31 |
| ~20 SaaS micro-hosts | https://www.pulsemcp.com/servers?q=publish+html — EdgeOne Makers 433★ · vibedrop 15★ · htmldrop 13★ · shipstatic 7★ · aired 8★ · Stacktree · tiiny.host · PreviewShip · sharable.link · JustPublish · Handoff · Playfrog · BrewPage · MakeItRun · Artidrop · Repage · Hostsmith · Deloc · agenthost | ≤433 | "Paste HTML, get a URL" — near-identical; **permanence is usually the paywall** (7-day expiry on free tiers) | **SaaS** on vendor infra | Mostly a single API key | Yes — that is the whole pitch | all 2026, several pushed this week |

**Cloudflare "Artifacts" is not a competitor.** It is
[Git-compatible versioned storage](https://developers.cloudflare.com/artifacts/) — Durable Objects
running a WASM Git server — announced
[2026-04-16](https://blog.cloudflare.com/artifacts-git-for-agents-beta/), closed beta, $0.15/1k ops
+ $0.50/GB-mo. No HTTP page serving, no viewer, no MCP. It is a candidate *versioning backend*, not
a rival. Agents Week (2026-08-04 → 08-10) shipped 18 posts and none is a publish-to-URL product.

**Underlying mechanism any competitor would use:** the
[Workers Static Assets direct-upload API](https://developers.cloudflare.com/workers/static-assets/direct-upload/)
— three calls (`assets-upload-session` → base64 multipart upload → `PUT scripts/{name}`), JWT valid
1 hour, served on `*.workers.dev`, no wrangler required — or
[Workers for Platforms](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/)
dispatch namespaces for per-tenant isolation, which Cloudflare explicitly pitches for "untrusted
code written by your customers, or by AI".

## Verdict

1. **No, the exact tool does not exist.** Nobody ships OSI-licensed **+** your-own-Cloudflare **+**
   MCP-first **+** multi-user. Every entry drops at least one leg: `open-artifacts` (50★) has no MCP
   and no accounts; `agent2web` and `pagevault` have MCP but one owner; `cf-page-publish-mcp` has
   both but died in July 2025; `open-artifact` has MCP + teams but is Docker and fair-code licensed.
2. **The gap is real but small — roughly a 50-star gap, not a market**, and the SaaS layer above it
   is saturated with ~20 interchangeable products launched inside 12 months.
3. **Over `wrangler deploy` / `wrangler pages deploy`, the one thing that actually matters is
   per-user API keys instead of an account-wide Cloudflare token.** Every wrapper today hands each
   agent a credential that can delete the entire account.
4. Then, in order: **multi-tenant isolation and per-user listing on one instance** (zero of twelve do
   this), **immutable versioned URLs with rollback** (`wrangler deploy` mutates in place),
   **read-time policy** — password, expiry, noindex — that raw Pages cannot express, and **no Node,
   no wrangler, no writable project directory** (one HTTP call).
5. **Positioning: "the Artifacts you own."** Convenience is already lost to Anthropic's built-in
   tool; the addressable users are precisely the ones it excludes — Agent SDK, API-key/Bedrock/Vertex
   sessions, non-Claude agents, and regulated orgs that need the data in their own infrastructure.

## Note on open-artifacts — the one to watch

[coda0HQ/open-artifacts](https://github.com/coda0HQ/open-artifacts) is the benchmark and the main
threat. It already has the name, the "self-hosted Claude Code Artifacts" positioning, 406 commits,
50 stars, MIT, and the correct security shape (per-artifact tokens stored as SHA-256 only, never in
plaintext). It is missing exactly two things: **an MCP server** (it ships an Agent Skill instead) and
**multi-user accounts** (teams exist only behind the managed coda0.com tier). Both are roughly a
weekend of work for its maintainer. Speed and the multi-tenant story matter more than feature count;
a slow, feature-rich entrant loses this race.

**Second-order threat:** Cloudflare holds every primitive already — Static Assets direct upload,
Workers for Platforms, Artifacts storage — and could ship a first-party version in one Agents Week.

## Caveats

- UNVERIFIED: multi-user status of EdgeOne Makers and vibedrop; tiiny.host account model.
- The SaaS long tail is under-counted — mcp.so returned 403 and Smithery search was uninformative.
- `punkpeye/awesome-mcp-servers` (93.6k★) has **no hosting or deploy category at all**, and lists
  none of these. The category is still unnamed, which cuts both ways for discoverability.
