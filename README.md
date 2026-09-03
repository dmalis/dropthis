# dropthis

**The publish layer for agents, on Cloudflare you own.**

An agent hands dropthis HTML, a folder, a PDF or a spreadsheet and gets back a permanent URL.
Every drop can be password-locked, set to expire, and kept out of search engines. It runs
entirely inside one Cloudflare account — one Worker, one R2 bucket — and costs nothing at
personal scale. There is no dashboard: agents are the only callers, through MCP, CLI or REST.

> Pre-release. The commands below are the target contract; nothing is published to npm yet
> (v1 runs from the repo build; `dropthis@1.0.0` on npm is the first public release).
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
after that it is deleted. Browsers and the edge never serve a stale version: every request
re-reads the drop's metadata. There is no revision history by design.

## How it runs

```
Worker  ── serves /<slug>/*  and  /_api/v1/*  and  /_api/mcp
R2      ── every file, every metadata object; the bucket *is* the database
KV      ── OAuth session storage only (for claude.ai / Claude desktop connectors)
cron    ── hourly, resumable expiry + prune
```

No Postgres, no D1, no queue, no build step. Details in `AGENTS.md`.

## Install

Honest human count: **3 steps, 2 of them browser-only** (1 if you already have a Cloudflare
account with R2 enabled). There is no API token to create on the human path: `init` signs
you in through the browser (one Allow click) and opens the exact dashboard page whenever a
step needs you.

1. *[browser]* Create a Cloudflare account — https://dash.cloudflare.com/sign-up
2. *[browser]* Enable R2 (free tier, but Cloudflare wants a card on file). `init` opens the
   exact page for your account and waits.
3. *[terminal]*

```sh
npx dropthis@latest init --domain drops.example.com --json
```

Until the first npm release, that line is `npx ./packages/dropthis init …` from a clone of
this repository — `init` deploys the Worker from the repo's own source.

Automation (agents, CI, n8n) skips the browser entirely: set `CLOUDFLARE_API_TOKEN`
(create at https://dash.cloudflare.com/profile/api-tokens → Create Custom Token:
**Workers Scripts — Edit · Workers KV Storage — Edit · Workers R2 Storage — Edit ·
Account Settings — Read**, plus Zone DNS — Edit and Zone Workers Routes — Edit for
`--domain`). An env token always wins over browser login.

The installer verifies the credential, pins the account (browser login refuses to run when
more than one account is visible),
reconciles the bucket and KV namespace by name (re-runs repair instead of failing), mints the
admin key and writes its record into the bucket, deploys with `HMAC_SECRET` in the same call,
adds the lifecycle rules, attaches
the domain if the zone is in the account, runs `doctor` (publishes, fetches and deletes a hello
drop and reports every check; the hello drop is gone afterwards), saves the instance to `~/.config/dropthis/instances.json` and
prints the Claude Code / Cursor / Codex / claude.ai connect snippets. Result:

```json
{ "ok": true, "name": "main", "worker": "dropthis-main", "bucket": "dropthis-main-drops",
  "kv_namespace": "dropthis-main-oauth", "canonical_url": "https://drops.example.com",
  "alias_origins": ["https://dropthis-main.<subdomain>.workers.dev"],
  "admin_key_status": "created", "admin_key": "…",
  "steps": [ { "step": "token", "status": "ok" }, … { "step": "doctor", "status": "ok" } ],
  "doctor": { "ok": true, "checks": [ … ] },
  "instances_file": "~/.config/dropthis/instances.json",
  "connect": { "mcp_url": "https://drops.example.com/_api/mcp", "clients": { … } } }
```

`--jsonl` streams one `{step, status, detail?}` line as each step completes and ends with
that same document. `init --check` answers the three account-level questions
(`lifecycle_rules`, `kv_bound`, `domain_attached`) and stops — the instance-side checks are
`dropthis doctor`.

`admin_key` appears only on the run that minted it. Re-running reports `"admin_key_status":
"existing"`; `--rotate-admin-key` is explicit. `--dry-run` stops after the preflight. Without
`--domain` the instance lives on its free `*.workers.dev` hostname. `--name` is only needed
from the second instance on (it defaults to `main`).

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
dropthis connect --client claude-code   # writes .mcp.json with a header helper, no key in it
dropthis connect --client cursor        # prints the snippet + the DROPTHIS_KEY_<NAME> export
dropthis doctor --json                  # the instance proves itself
```

Same five drop operations as MCP tools (`dropthis_publish`, `dropthis_update`,
`dropthis_get`, `dropthis_list`, `dropthis_delete`; admin: `dropthis_user_*`,
`dropthis_config_*`, `dropthis_usage`, `dropthis_prune`, `dropthis_doctor`) and as REST
under `/_api/v1`. In MCP, files travel inline in the tool call (`{path, text}` or
`{path, base64}`) or by `{path, url}`; the CLI streams large folders itself. `dropthis_get`,
`dropthis_update` and `dropthis_delete` take `target` — the drop's URL or its slug — and a
URL from another instance is `WRONG_INSTANCE`.

Credentials: `CLOUDFLARE_API_TOKEN` for `init`; `DROPTHIS_URL` + `DROPTHIS_KEY` for
everything else, `doctor` included (or `--instance <name>` from `instances.json`). `--json`
gives exactly one JSON document; `--jsonl` streams `init`'s steps live; on `publish`,
stdout is the URL. Exit codes: `0` ok, `1` failure, `2` cancelled, `4` auth required. Never
a prompt when stdin is not a terminal. Send `idempotency_key` on `publish`/`update` and a
retry can never make a second drop.

### Teams and clients

An instance is a team: every user key sees and edits every drop; `created_by` says who made
it; leaving = revoking the key. claude.ai and the Claude desktop app connect to `/_api/mcp`
and log in by pasting a key (on claude.ai Team/Enterprise an Owner adds the connector once;
each member then logs in with their own key). A client gets its own instance (`npx dropthis init --name
client-x`) — separate Worker, bucket and keys; nothing is shared across instances.

## Cost

Personal instance: $0 (Workers Free, R2 free tier; enabling R2 appears to require a payment
method on file — community-reported, not in Cloudflare docs). Small agency, 20 client sites,
~500k views/month: about $5/month (Workers Paid, once per account; also needed from the
sixth instance on one account, because Free allows five cron triggers). Egress is free.
Numbers as of 2026-09-01 — see `docs/research/`.

## Licence

Apache-2.0. See `LICENSE`. Name and logo: `TRADEMARKS.md`.
