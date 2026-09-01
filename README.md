# dropthis

**The publish layer for agents, on Cloudflare you own.**

An agent hands dropthis HTML, a folder, a PDF or a spreadsheet and gets back a permanent URL.
Every drop can be password-locked, set to expire, and kept out of search engines. It runs
entirely inside one Cloudflare account — one Worker, one R2 bucket — and costs nothing at
personal scale. There is no dashboard: agents are the only callers, through MCP, CLI or REST.

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
- Automations (n8n, cron jobs, webhooks) that need "put this file somewhere and give me a
  link" as one HTTP call.

## What a drop is

A drop is a set of files served at `https://<host>/<slug>/`. A single-file drop (a PDF, an
`.xlsx`, one HTML page) is served directly at its URL with the right content type. The slug
is generated (10 characters, `a-z0-9`) and never changes: the URL is the drop's identity,
and every operation accepts the URL or the slug.

Every drop has:

| Field      | Default   | Notes                                                                 |
|------------|-----------|-----------------------------------------------------------------------|
| `title`    | none      | short human name; shown in `list`; agents are told to always set it   |
| `meta`     | `{}`      | JSON the agent stores to remember what the drop is (≤ 16 KB)          |
| `expires`  | 30 days   | `"7d"`, a date, or `"never"` (unless instance policy forbids)         |
| `password` | none      | `"generate"` returns a strong one, once; chosen ≥ 8 characters        |
| `noindex`  | on        | `X-Robots-Tag: noindex, nofollow` on every response                   |

Drops are **updated in place** at the same URL; multi-file updates are atomic. An expired
drop answers 410 immediately and can be revived for 7 days (`update … --expires 30d`);
after that it is deleted. There is no revision history by design.

## How it runs

```
Worker  ── serves /<slug>/*  and  /_api/v1/*  and  /_api/mcp
R2      ── every file, every metadata object; the bucket *is* the database
KV      ── OAuth session storage only (for claude.ai / Claude desktop connectors)
cron    ── daily expiry + prune
```

No Postgres, no D1, no queue, no build step. Details in `AGENTS.md`.

## Install

Honest human count: **4 steps, 3 of them browser-only** (2 if you already have a Cloudflare
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
CLOUDFLARE_API_TOKEN=<paste> npx dropthis@latest init --name drops --domain drops.example.com --json
```

The installer verifies the token, pins the account (refuses to guess between several),
reconciles the bucket and KV namespace by name (re-runs repair instead of failing), mints the
admin key, deploys with the secrets in the same call, adds the staging lifecycle rule, attaches
the domain if the zone is in the account, runs `doctor` (publishes, fetches and deletes a hello
drop; checks MCP answers), saves the instance to `~/.config/dropthis/instances.json` and
prints the Claude Code / Cursor / Codex / claude.ai connect snippets. Result:

```json
{ "ok": true, "url": "https://drops.example.com", "mcp_url": "https://drops.example.com/_api/mcp",
  "admin_key": "…",  "first_drop": "https://drops.example.com/hello/", "steps": [ … ] }
```

`admin_key` appears only on the run that minted it. Re-running reports `"admin_key_status":
"existing"`; `--rotate-admin-key` is explicit. `--dry-run` stops after the preflight. Without
`--domain` the instance lives on its free `*.workers.dev` hostname.

A **Deploy to Cloudflare button** (no-CLI path, boots unclaimed until `npx dropthis claim`
proves ownership with your token) comes after v1.

## Use

One binary, one skill. Agents read `https://<host>/_skill.md` — the instance's own skill with
its URL and limits filled in — and never need anything else.

```sh
dropthis publish ./report --title "Q3 report"          # → https://drops.example.com/k7x2m9q4pz/
dropthis publish deck.pdf --password generate --expires 7d
dropthis update https://drops.example.com/k7x2m9q4pz/ ./report        # new content, same URL
dropthis update k7x2m9q4pz --password generate                        # settings only
dropthis get k7x2m9q4pz --files                        # title, settings, meta, file content
dropthis list --q "Q3"
dropthis delete k7x2m9q4pz

dropthis user add anna --json        # → key shown once + connect snippets + ready-to-send message
dropthis user remove anna            # revokes the key; every session behind it ends
dropthis connect --client claude-code
```

Same five drop operations as MCP tools (`dropthis_publish`, `dropthis_update`,
`dropthis_get`, `dropthis_list`, `dropthis_delete`; admin: `dropthis_user_*`,
`dropthis_config_*`, `dropthis_usage`, `dropthis_prune`, `dropthis_doctor`) and as REST
under `/_api/v1`. In MCP, files travel inline in the tool call (`{path, content}`) or by
`{path, url}`; the CLI streams large folders itself.

Credentials: `CLOUDFLARE_API_TOKEN` for `init`/`doctor`; `DROPTHIS_URL` + `DROPTHIS_KEY` for
everything else (or `--instance <name>` from `instances.json`). `--json` gives one JSON
document; on `publish`, stdout is the URL. Exit codes: `0` ok, `1` failure, `2` cancelled,
`4` auth required. Never a prompt when stdin is not a terminal.

### Teams and clients

An instance is a team: every user key sees and edits every drop; `created_by` says who made
it; leaving = revoking the key. claude.ai and the Claude desktop app connect to `/_api/mcp`
and log in by pasting a key. A client gets its own instance (`npx dropthis init --name
client-x`) — separate Worker, bucket and keys; nothing is shared across instances.

## Cost

Personal instance: $0 (Workers Free, R2 free tier; enabling R2 appears to require a payment
method on file — community-reported, not in Cloudflare docs). Small agency, 20 client sites,
~500k views/month: about $5/month (Workers Paid, once per account; also needed from the
sixth instance on one account, because Free allows five cron triggers). Egress is free.
Numbers as of 2026-09-01 — see `docs/research/`.

## Licence

Apache-2.0. See `LICENSE`. Name and logo: `TRADEMARKS.md`.
