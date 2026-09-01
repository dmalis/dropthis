# Cloudflare agent and MCP tooling — snapshot 2026-09-01

Research report produced by an agent during the founding design session. UNVERIFIED marks
claims not confirmed on a Cloudflare-owned source.

## Agents SDK (`agents` npm, v0.22.0, MIT)

- `Agent` class = Durable Object with embedded SQLite, synced state, WebSockets, scheduling
  (`schedule`, `scheduleEvery`), `@callable()` RPC —
  https://developers.cloudflare.com/agents/api-reference/agents-api/
- MCP: **`createMcpHandler`** (stateless Streamable HTTP) is the current recommendation;
  **SSE is deprecated**; `McpAgent` is marked for deprecation —
  https://developers.cloudflare.com/agents/model-context-protocol/transport/
- Needs `nodejs_compat` and a recent `compatibility_date`.
- Code Mode marked experimental.

## Auth in front of a remote MCP server

- **`@cloudflare/workers-oauth-provider` v0.10.3**, MIT, zero runtime deps, ~1.9k stars,
  actively released. Full OAuth 2.1 provider wrapping a Worker: authorize/token/registration
  endpoints, PKCE S256, RFC 7591 DCR, RFC 9728 resource metadata, RFC 8693 token exchange;
  implements MCP spec 2026-07-28. Tokens stored as hashes in a KV namespace bound
  `OAUTH_KV`; `props` encrypted AES-GCM —
  https://github.com/cloudflare/workers-oauth-provider
- Canonical wiring: `new OAuthProvider({ authorizeEndpoint:"/authorize",
  tokenEndpoint:"/token", clientRegistrationEndpoint:"/register", apiRoute:"/mcp",
  apiHandler: …, defaultHandler: AuthHandler })` —
  https://developers.cloudflare.com/agents/model-context-protocol/guides/securing-mcp-server/
- MCP Server Portals (Cloudflare One, open beta) aggregate MCP servers behind Access — an
  enterprise overlay, not a substitute —
  https://developers.cloudflare.com/changelog/post/2025-08-26-mcp-server-portals/
- MCP spec 2026-07-28: auth optional; **stdio servers SHOULD NOT use OAuth — they read
  credentials from the environment**; DCR deprecated in favour of CIMD; RFC 8707 `resource`
  MUST be sent — https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization

## Cloudflare's official MCP servers

- **Cloudflare API (Code Mode)** `https://mcp.cloudflare.com/mcp` — 3 tools (`docs`, `search`,
  `execute`) over the whole ~2,500-endpoint API — https://github.com/cloudflare/mcp
- **Workers Bindings** `https://bindings.mcp.cloudflare.com/mcp` — `r2_bucket_create/list/
  get/delete`, `d1_database_*`, `kv_namespace_*`, `workers_list/get_worker`. **No deploy, no
  secrets, no object put** — https://github.com/cloudflare/mcp-server-cloudflare
- Others: Documentation, Workers Builds, Observability, Browser, Containers, GraphQL, Radar,
  Logpush, AI Gateway, Audit Logs, DNS Analytics —
  https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/
- Auth: OAuth redirect to Cloudflare with scope selection, or API token as bearer.
- Creating an API token needs `User → API Tokens → Edit`, only grantable via the "Create
  Additional Tokens" dashboard template — an agent cannot mint the first token.

## Non-interactive provisioning

- `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` — documented for CI/automation —
  https://developers.cloudflare.com/workers/wrangler/system-environment-variables/
- `wrangler r2 bucket create <name>` (`--update-config` writes the binding);
  `echo "$VAL" | wrangler secret put KEY` (stdin documented); `wrangler secret bulk`;
  `wrangler deploy --yes`; `wrangler deploy --temporary` deploys to a throwaway preview
  account with no credentials (wrangler ≥ 4.102.0) —
  https://developers.cloudflare.com/workers/wrangler/commands/workers/
- Custom domain from config: `routes: [{pattern:"drops.example.com", custom_domain:true}]`;
  needs an active zone in the account —
  https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
- **Auto-provisioning from `wrangler.jsonc`**: declare KV/R2/D1 bindings with no IDs;
  `wrangler deploy` creates them and writes IDs back. wrangler ≥ 4.45.0. **The "JSON/JSONC
  only" claim is UNVERIFIED (2026-09-01 review: current docs show write-back examples for both
  formats; only the Deploy-button/dashboard path skips it).** —
  https://developers.cloudflare.com/changelog/post/2025-10-24-automatic-resource-provisioning/
- Trap: `wrangler d1 migrations apply` cannot resolve an auto-provisioned DB before the first
  deploy (https://github.com/cloudflare/workers-sdk/issues/13632). Not relevant to the
  R2-only design; noted in case D1 is ever reconsidered.
- Token permissions: Cloudflare's CI doc says use the **"Edit Cloudflare Workers"** template —
  https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/ . A precise
  minimum set (Workers Scripts, R2 Storage, KV Storage, Account Settings:Read, Workers
  Routes:Edit) is UNVERIFIED as official.
- No `wrangler tokens create` exists (feature request
  https://github.com/cloudflare/workers-sdk/issues/13042). Docs: "Before you can use the API,
  you need to generate an initial token via the Cloudflare dashboard" —
  https://developers.cloudflare.com/fundamentals/api/how-to/create-via-api/

## Deploy to Cloudflare button

`https://deploy.workers.cloudflare.com/?url=<repo>` clones the repo into the user's
GitHub/GitLab, reads the Wrangler config to determine resource requirements, auto-provisions
KV, D1, R2, Hyperdrive, Vectorize, Secrets Store, Durable Objects, Workers AI, Queues, writes
IDs back, connects Workers Builds (push-to-deploy, preview URLs). Secrets are read as names
from `.dev.vars.example`/`.env.example` and prompted for. **Public repos only, GitHub/GitLab
only, Workers only, monorepo subdirectories must be self-contained, bindings top-level (not
under `env.*`), `.toml` rejected** —
https://developers.cloudflare.com/workers/platform/deploy-buttons/ ,
https://github.com/cloudflare/templates/blob/main/CLAUDE.md

## 2025–2026 announcements, relevance

| Thing | Relevance |
|---|---|
| Code Mode (`@cloudflare/codemode`) | Only if our MCP tool count grows large. |
| Dynamic Workers / Worker Loader (beta) | Only for executing untrusted code — not us. |
| Sandboxes GA | Only if build steps are added — not us. |
| **Artifacts** (Git-compatible versioned storage for agents, closed beta) | Adjacent; a possible versioning backend; not a publish product. |
| Remote bindings GA (`remote: true`) | Test local Worker code against the real bucket. |
| Workers Builds | What the Deploy button wires up. |

## So what

1. One-command setup is real: `wrangler.jsonc` with bindings and no IDs +
   `CLOUDFLARE_API_TOKEN=… wrangler deploy --yes`.
2. The human step that cannot be removed is the first API token.
3. Offer the Deploy button as the zero-CLI path (public repo, Workers-only).
4. MCP surface = `createMcpHandler` Streamable HTTP + `workers-oauth-provider` with
   `OAUTH_KV` — Cloudflare's own documented pattern.
5. Skip Dynamic Workers, Sandboxes, Code Mode for v1.
