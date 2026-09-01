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

Two doors, same result. Both end with a live drop URL.

**Human** — click the *Deploy to Cloudflare* button (coming with the first release). It
creates the bucket, asks for one admin secret, deploys, and wires git-push deploys.

**Agent** — after a human has a Cloudflare account and an API token:

```sh
CLOUDFLARE_API_TOKEN=… npx @dropthis/cf init --name drops --domain drops.example.com --json
# → { "url": "…", "mcp_url": "…/_api/mcp", "admin_key": "…", "first_drop": "…/hello/" }
```

The installer provisions the bucket, mints the admin key, sets secrets, deploys, publishes a
hello drop, and writes `.mcp.json`. Re-running is safe; it never re-prints the key.

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
