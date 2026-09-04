---
name: dropthis-install
description: Install a dropthis instance on a human's Cloudflare account and connect it to their agent client, end to end and without prompts. Use when the user says install dropthis, set up dropthis, deploy dropthis to my Cloudflare, give me my own drop URL, add a teammate to dropthis, or connect dropthis to Claude Code, Cursor, Codex or claude.ai. Not for publishing drops — a connected instance serves its own skill at /_skill.md for that.
---

# Install dropthis for a human

You are installing dropthis: one Cloudflare Worker and one R2 bucket in the human's own
account that turn files an agent produced into permanent URLs. You need a terminal with
Node 22 or newer, `git` and network access. The human needs a Cloudflare account with R2
enabled and a credential. Everything else is yours to do; never ask the human to run a
command.

## 1. Ask the human for the three things only a human can do

1. **A Cloudflare account.** Sign-up: https://dash.cloudflare.com/sign-up
2. **R2 enabled** on that account: Dashboard → Storage & databases → R2 → Overview → complete
   the checkout flow (the free tier is included). If you skip this, `init` stops at the
   `r2_subscription` step with "R2 is not enabled on this account. Enable it at
   https://dash.cloudflare.com/<account-id>/r2, then run init again."; send the human that
   exact URL and rerun.
3. **A credential**, one of:
   - **An API token** (the automation path, always preferred when you run without a
     browser). Ask them to create it at https://dash.cloudflare.com/profile/api-tokens →
     Create Custom Token with **Workers Scripts — Edit · Workers KV Storage — Edit ·
     Workers R2 Storage — Edit · Account Settings — Read**, plus **Zone DNS — Edit · Zone
     Workers Routes — Edit** when they want a custom domain. Ask them to paste the token and
     their Account ID (Dashboard → any domain → Overview, or the URL after
     `dash.cloudflare.com/`). Set both in the environment, never in a file you commit:
     ```sh
     export CLOUDFLARE_API_TOKEN=<token> CLOUDFLARE_ACCOUNT_ID=<account id>
     ```
   - **The browser login**, only when the human is at the same terminal as you: run `init`
     with no token set and it opens a browser for one Allow click. It refuses to run when the
     login sees more than one account; then ask for `--account-id <id>` or a token.

Also ask: **which hostname**, if any. `--domain drops.example.com` needs the zone in the same
account. Without `--domain` the instance answers on its free `*.workers.dev` hostname, and
that is a fine first install.

## 2. Build from the repository

```sh
git clone https://github.com/dmalis/dropthis.git && cd dropthis
npm install && npm run build
```

`dropthis` is installed from this repository, not from npm.

## 3. Run `init`

```sh
npx ./packages/dropthis init --domain drops.example.com --json
```

Omit `--domain` for `*.workers.dev`. `init` never prompts when stdin is not a terminal, and
`--yes` forces that. Add `--dry-run` first if you want to show the human the plan: every
step answers `ok` or `would_create` and nothing is created.

What `init` does, in order: verifies the credential, pins the account, checks the four
permissions and the R2 subscription, creates or repairs the bucket and the KV namespace by
name, mints the admin key and writes its record into the bucket, deploys the Worker with its
secret, adds the lifecycle rules, attaches the domain, polls `/_api/v1/health`, runs
`doctor` (a real hello drop: publish, fetch, delete), saves the instance to
`~/.config/dropthis/instances.json`, and prints the connect snippets.

Read the one JSON document it prints:

- `ok: true` and every `steps[].status` `ok`/`created`: done. `canonical_url` is the
  instance's URL.
- `admin_key`: present only on the run that minted it, and already saved to
  `instances_file`. **Do not paste it into the chat.** Tell the human where it is and that
  it is shown once; `--rotate-admin-key` mints a new one and revokes the old.
- `ok: false`: the failing step's `detail` names the fix. Exit code `4` with no token means
  no credential was found; the remediation names the token URL and the four permissions —
  relay it. A `health` step that never answers over a working deploy is usually a
  pre-existing Workers Route on the zone shadowing the Custom Domain; tell the human which
  route, or fall back to `*.workers.dev`.
- **Rerunning is safe.** The same command repairs a broken run: `admin_key_status:
  "existing"`, no key re-revealed, `deploy` detail "HMAC_SECRET reused from the deployed
  Worker".

A second instance on the same account needs `--name <name>` (Worker `dropthis-<name>`,
bucket `dropthis-<name>-drops`); without it a rerun reconciles `main`.

## 4. Put `dropthis` on the PATH and connect this client

```sh
npm install -g ./packages/dropthis
dropthis connect --client claude-code --json   # claude-code | cursor | codex | claude-ai
```

- `claude-code` writes `.mcp.json` in the current directory with `type: http`, the
  `/_api/mcp` URL and `headersHelper: "dropthis auth-header --instance <name>"` — the key
  stays in `instances.json`, never in the file. Run it in the project the human works in.
- `cursor` and `codex` print the MCP snippet plus one `export DROPTHIS_KEY_<NAME>=…` line
  for the shell profile; relay both and tell the human the value is the admin key from
  `instances.json`.
- `claude-ai` prints the connector URL and the three steps (Settings → Connectors → Add
  custom connector → paste the URL → Connect → paste the key). On a Team or Enterprise plan
  only an Owner can add a custom connector.

Add `--instance <name>` when the account holds several instances.

## 5. Prove it and hand over

```sh
dropthis doctor --json
dropthis publish ./hello --title "Hello" --json
```

`doctor` must answer `ok: true` (`pbkdf2_benchmark` reports `inconclusive`, which is
expected). Then tell the human, in this order: the instance URL; that their agents read
`<canonical_url>/_skill.md` to operate it; where the admin key lives; and the connect
snippet you applied. Delete the hello drop with `dropthis delete <url> --yes` unless they
want to keep it.

## Adding a teammate

```sh
dropthis user add anna --json
```

Returns the new key once, a `connect` object with per-client snippets, and a `message`
ready to forward. Send the message and the key in two separate channels; the key is never
shown again. `dropthis user remove anna` revokes it immediately.

## Operating the instance

Do not use this skill for publishing. Read `<canonical_url>/_skill.md` — the instance's own
skill, with its URL, policy and limits filled in — and call the tools it names.
