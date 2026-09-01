# Multi-user auth, CF-deployable precedents, agent-first install UX — snapshot 2026-09-01

Research report produced by an agent during the founding design session. Star counts read
2026-09-01. UNVERIFIED marks claims not confirmed on an authoritative source.

## A. Auth options for a headless multi-user API on Cloudflare

### Cloudflare Access — rejected as the auth layer

- Free tier 50 users; seats consumed on any authentication and held until removed.
- Service tokens do not consume seats but are **capped at 50 per account** —
  https://developers.cloudflare.com/cloudflare-one/account-limits/
- Service tokens require two headers (`CF-Access-Client-Id`, `CF-Access-Client-Secret`);
  claude.ai connectors expose only OAuth fields, no custom headers
  (https://github.com/anthropics/claude-ai-mcp/issues/112).
- Service-token requests carry no user identity, so per-user attribution must be rebuilt
  anyway. Zero Trust onboarding requires a payment method even on Free.
- Positive: Workers can now be protected behind Access with one click and read identity via
  `ctx.access.getIdentity()` (2026-08-14) —
  https://developers.cloudflare.com/workers/configuration/cloudflare-access/ . Keep as an
  optional hardening mode only.

### Own API keys — chosen

- Cloudflare's own guidance: `crypto.subtle.timingSafeEqual()`; hash to fixed size, compare
  in constant time — https://developers.cloudflare.com/workers/best-practices/workers-best-practices/
- WebCrypto: PBKDF2/HKDF/SHA-2/HMAC/AES/Ed25519 supported; bcrypt/scrypt/Argon2 not —
  https://developers.cloudflare.com/workers/runtime-apis/web-crypto/
- **PBKDF2 capped at 100,000 iterations in workerd**
  (https://github.com/cloudflare/workerd/issues/1346); Free plan CPU is 10 ms/request.
- Therefore: 32-byte random key, store `sha256(key)`, `timingSafeEqual` — microseconds of
  CPU, and a high-entropy key has no dictionary to grind. Passwords for drop unlock (human
  chosen, low entropy) need a modest-iteration PBKDF2 plus per-drop attempt rate limiting;
  Workers Paid lifts the CPU ceiling.

### OAuth for MCP

- `@cloudflare/workers-oauth-provider` (1.9k★, MIT): OAuth 2.1, PKCE, rotating refresh
  tokens, RFC 7009/7591/8414/9728, encrypted token storage in KV. Minimal wiring ≈ 3 lines.
  Templates `remote-mcp-authless`, `remote-mcp-github-oauth` —
  https://developers.cloudflare.com/agents/guides/remote-mcp-server/
- Cloudflare documents GitHub, Google, Auth0, Stytch, WorkOS and Access-as-IdP. We use none:
  the authorize page asks the user to paste their dropthis key.
- Verdict: API keys primary (CLI, SDK, stdio MCP, CI); OAuth on `/_api/mcp` for browser
  clients (claude.ai, Claude desktop, ChatGPT) that refuse static headers.

## B. Precedents deployed into the user's own Cloudflare account

| Repo | ~Stars | Infra | Setup | Auth / multi-user | MCP |
|---|---|---|---|---|---|
| cloudflare/templates | 2,091 | Worker + R2/D1/KV/DO (40 templates) | Deploy button + C3 | varies | partial |
| cloudflare/ai `remote-mcp-github-oauth` | 1,154 (repo) | Worker + KV + DO | C3 template | GitHub OAuth, multi-user | yes |
| cloudflare/agents | 5,503 | Worker + DO | C3 / wrangler | app-defined | yes |
| cloudflare/mcp-server-cloudflare | 4,133 | Worker + KV + DO | wrangler | OAuth to CF account | yes |
| cloudflare/workers-mcp | 646 | Worker | `npx workers-mcp setup` | shared secret | yes |
| miantiao-me/Sink | 7,070 | Worker + D1 + KV + AE | wrangler / NuxtHub | single admin token | no |
| MarSeventh/CloudFlare-ImgBed | 6,337 | Worker/Pages + R2 + KV/D1 | fork + wrangler | admin + API keys | no |
| lyc8503/UptimeFlare | 3,754 | Worker + D1 + Pages | "Use this template" + Actions token | optional password | no |
| SharzyL/pastebin-worker | 1,048 | Worker + KV + R2 | wrangler | optional basic auth | ships `doc/skill.md` |
| G4brym/R2-Explorer | 636 | Worker + R2 + KV | GitHub Action | none / basic / Access | no |

Best one-command patterns: Deploy button + top-level bindings with placeholder defaults;
"Use this template" + one `CLOUDFLARE_API_TOKEN` Actions secret (UptimeFlare). **Gap: no
project generates its admin secret at deploy time** — every template says "run `openssl rand
-hex 32` yourself". **No project combines Deploy button + R2 + multi-user auth + MCP.**

Direct-competitor sweep (agent-first publish tools) is in `2026-09-01-competitors.md`.

## C. Agent-first install UX

- npm: `--yes` assumed when stdin is not a TTY, but regressions exist — ship an explicit
  flag — https://docs.npmjs.com/cli/v11/commands/npm-exec
- wrangler non-interactive: env vars `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`;
  prompts still hang in some Docker/Actions setups
  (https://github.com/cloudflare/workers-sdk/issues/12296).
- MCP registration: Claude Code `claude mcp add --transport http <name> <url> --header
  "Authorization: Bearer …"`; `.mcp.json` supports `headers`, `${VAR}` expansion and a
  `headersHelper` — https://code.claude.com/docs/en/mcp . Cursor `.cursor/mcp.json` with
  `headers`. Codex `~/.codex/config.toml` `[mcp_servers.x]` with `bearer_token_env_var`.
  **All three support HTTP MCP + static headers; only browser-based clients force OAuth.**
- Skills: SKILL.md with frontmatter; plugin marketplaces via `.claude-plugin/marketplace.json`;
  `AGENTS.md` cross-tool convention — https://agents.md/
- Cloudflare's own agent-readiness reference: `Accept: text/markdown`, `/index.md`,
  `llms.txt` — https://developers.cloudflare.com/docs-for-agents/

### Can an agent create the first Cloudflare API token? No.

`POST /user/tokens` works with a token that has `API Tokens Write`, but "Before you can use
the API, you need to generate an initial token via the Cloudflare dashboard" —
https://developers.cloudflare.com/fundamentals/api/how-to/create-via-api/ . `wrangler login
--device` still needs a human click.

### Shortest realistic sequence

1. Human signs up at cloudflare.com.
2. Human adds a payment method (R2 requires it even at $0 — UNVERIFIED in docs).
3. Human creates an API token and hands it to the agent.
4. Agent: `CLOUDFLARE_API_TOKEN=… npx @dropthis/cf init --json` → bucket, admin key, secrets,
   deploy, hello drop, `.mcp.json`. No further human input.
5. Agent publishes; agent mints per-person keys and prints connect instructions for
   claude.ai / Claude desktop / ChatGPT (ChatGPT connector OAuth requirements UNVERIFIED —
   test against a real account before documenting).
