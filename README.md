# dropthis

**The publish layer for agents, on Cloudflare you own.**

An agent hands dropthis HTML, a folder, a PDF or a spreadsheet and gets back a permanent URL.
Every drop can be password-locked, set to expire, and kept out of search engines. It runs
entirely inside one Cloudflare account — one Worker, one R2 bucket — and costs nothing at
personal scale. There is no dashboard: agents are the console, through MCP, CLI or REST.

> Pre-release. The commands below are the target contract; nothing is published to npm yet.
> `docs/decisions.md` records every choice and why; `docs/research/` holds the dated evidence.

**Security note:** a drop is arbitrary HTML served as active content. dropthis does not make
it safe. Serve drops from a dedicated domain, never from a subdomain of a site whose cookies
matter. See `SECURITY.md`.

## Who it is for

- People who produce reports and artifacts with agents every week and need them on a
  clean, unbranded URL under their own domain.
- Agencies and AI implementers who host client work on infrastructure they control and
  invoice for it — one isolated instance per client, no Cloudflare account for the client.
- Teams whose agents run where hosted "artifacts" features are unavailable: Agent SDK,
  API-key sessions, Bedrock/Vertex, non-Claude agents, regulated orgs.

## What a drop is

A drop is a set of files served at `https://<host>/<slug>/`. A single-file drop (a PDF, an
`.xlsx`, one HTML page) is served directly at its URL with the right content type.

Every drop has:

| Setting    | Default   | Notes                                                        |
|------------|-----------|--------------------------------------------------------------|
| `slug`     | generated | vanity slugs allowed; unique per instance                    |
| `expires`  | 30 days   | `never` allowed unless instance policy forbids it            |
| `password` | none      | HMAC unlock cookie; `generate` returns a strong one once     |
| `noindex`  | on        | `X-Robots-Tag: noindex, nofollow` on every response          |

Drops are **updated in place** at the same URL. Multi-file updates are atomic. There is no
revision history by design.

## How it runs

```
Worker  ── serves /<slug>/*  and  /_api/v1/*  and  /_api/mcp
R2      ── every file, every metadata object; the bucket *is* the database
KV      ── OAuth session storage only (for claude.ai / ChatGPT connectors)
cron    ── daily expiry + prune
```

No Postgres, no D1, no queue, no build step. Details in `AGENTS.md`.

## Install

Honest human count: **4 steps, 2 of them browser-only** (3 if you already have a Cloudflare
account with R2 enabled). Everything after the token is the agent's job.

1. *[browser]* Create a Cloudflare account — https://dash.cloudflare.com/sign-up
2. *[browser]* Enable R2 and add a payment method at `https://dash.cloudflare.com/<account>/r2`.
   Free tier, nothing is charged at personal volumes, but Cloudflare wants a card on file.
3. *[browser]* Create an API token at https://dash.cloudflare.com/profile/api-tokens →
   Create Custom Token, name it `dropthis`: **Workers Scripts — Edit · Workers KV Storage — Edit ·
   Workers R2 Storage — Edit · Account Settings — Read** (add Zone DNS — Edit and Zone Workers
   Routes — Edit if you will pass `--domain`).
4. *[terminal, agent]*

```sh
npx @dropthis/cf init --cf-token <paste> --name drops --domain drops.example.com --json
```

The installer verifies the token, pins the account (refuses to guess between several),
reconciles the bucket and KV namespace by name (re-runs repair instead of failing), mints the
admin key, deploys with the secrets in the same call, adds the staging lifecycle rule, attaches
the domain if the zone is in the account, runs `doctor` (publishes, fetches and deletes a hello
drop; checks MCP answers), writes `.mcp.json` and prints Claude Code / Cursor / Codex snippets.
Result:

```json
{ "ok": true, "url": "https://drops.example.com", "mcp_url": "https://drops.example.com/_api/mcp",
  "admin_key": "…",  "first_drop": "https://drops.example.com/hello/", "steps": [ … ] }
```

`admin_key` appears only on the run that minted it. Re-running reports `"admin_key_status":
"existing"`; `--rotate-admin-key` is explicit. `--dry-run` stops after the preflight.

**Deploy to Cloudflare button** (coming with the first release) is the no-CLI path: it clones
the repo into your GitHub, provisions the bucket and KV, builds and deploys. The instance
comes up *unclaimed* — every route returns 503 except health — until you run
`npx @dropthis/cf claim`, which proves ownership with your Cloudflare token (never "first
caller becomes admin"). Five steps, four in a browser; it looks shorter than the CLI path and
is not.

## Use

```sh
dropthis publish ./report            # → https://drops.example.com/q3-report/
dropthis publish deck.pdf --password generate --expires 7d
dropthis update-content q3-report ./report
dropthis user add anna               # → key shown once + connect instructions
```

Same operations as MCP tools (`publish`, `update_content`, `update_settings`, `get`, `list`,
`delete`, `resolve`; admin: `user_*`, `host_*`, `config_*`, `usage`, `prune`, `doctor`) and as
REST under `/_api/v1`. claude.ai and the Claude desktop app connect to `/_api/mcp` and log in
by pasting a key (ChatGPT connectors: expected to work the same way, not yet exercised).

## Cost

Personal instance: $0 (Workers Free, R2 free tier; enabling R2 appears to require a payment
method on file — community-reported, not in Cloudflare docs). Small agency, 20 client sites,
~500k views/month: about $5/month (Workers Paid, once per account). Egress is free. Numbers
as of 2026-09-01 — see `docs/research/`.

## Licence

Apache-2.0. See `LICENSE`.
