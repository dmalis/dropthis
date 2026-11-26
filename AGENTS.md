# AGENTS.md

## What this repo is

dropthis turns content an agent produced into a permanent URL on the user's own Cloudflare
account: one Worker, one R2 bucket, one KV namespace for OAuth. Agents are its only callers,
through REST, a CLI and MCP tools generated from one operation registry. Production is any
instance that `init` installed on a real account; the `dev` Worker on the developer's own
account is a test seam, not production. The design, the storage layout and every contract
rule are in `docs/architecture.md`, which is the product truth.

## Setup and commands

Node 22 or newer. From the repo root:

```sh
npm install
npm run build                       # builds packages/dropthis (bundles the Worker for init)
npm run typecheck                   # tsc --noEmit over the whole repo
npx vitest run --project unit       # pure modules and the Worker app in process
npx vitest run --project cli        # the built dropthis binary as a subprocess, against localhost
npx vitest run --project contract   # the golden HTTP corpus against the deployed dev Worker
npm test                            # all three, in that order
npm run deploy:dev                  # deploy the dev Worker (-- --dry-run, -- --instance <name>)
npx ./packages/dropthis <command>   # run the CLI from the repo build; nothing is on npm
```

The `contract` project and `deploy:dev` need `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` for the developer's own account. Their error messages suggest
keeping them in `~/.config/dropthis/dev.env` (mode 600, outside the repo) and sourcing it.
The corpus targets `https://dropthis-<instance>.dropthis-app.workers.dev`; set
`DROPTHIS_DEV_URL` when your account's `workers.dev` subdomain differs. Two people running
the corpus at once each need their own seam: deploy with `--instance <name>` and set
`DROPTHIS_DEV_INSTANCE=<name>` for the run, because each run starts by emptying its bucket.

There is no CI: run the seams yourself. Four seams: (1) the `contract` corpus against a real
deployed `dev` Worker, bucket reset through the R2 API before every run, expiry driven by a
clock override that exists only in the dev build; (2) the `cli` project, with `init` run
against `test/fake-cloudflare/`, a local fake of the Cloudflare API, for every failure path;
(3) the `unit` project; (4) manual, recorded acceptance: the claude.ai connector spike and the
two milestone runs.

## Layout

- `packages/worker` — the deployed Worker. `wrangler.jsonc` declares bindings by name with no
  ids; `init` and `deploy:dev` render a per-instance config with the ids and deploy from it.
- `packages/dropthis` — the one npm package: installer (`init`), CLI, stdio MCP proxy.
- `skills/instance-skill.md` — the skill each instance serves at `/_skill.md`;
  `skills/dropthis-install/` — the install skill for agents.
- `contract-tests/` — seam 1. `test/fake-cloudflare/` — the fake Cloudflare API for seam 2.
- `scripts/deploy-dev.mjs` — the dev deploy.
- `docs/` — architecture, decisions, the v1 spec, dated research.

## Rules for this repo

- Test-first for every behaviour, through the seam that proves it. Remote R2 behaviour is
  asserted only against remote R2 (`contract-tests/`), never from an emulator.
- Deleting or overwriting a real instance's data (its bucket, drops or keys), or any
  Cloudflare resource outside the `dev` Worker, waits for the owner's yes.
- `npm run deploy:dev` is a test seam: run it on your own. A deploy to a real instance needs
  the owner's go, until a deployed-revision check and a one-command rollback exist.
- `wrangler.jsonc`, never TOML.
- Secrets are never printed to logs and never re-revealed by a rerun. A missing key file
  fails loudly; rotation is explicit. Credentials live in the environment, never in the repo.
- Docs are generated from the operation registry wherever possible. Hand-written prose is
  limited to `README.md`, this file, `docs/architecture.md`, `SECURITY.md`,
  `docs/decisions.md` and `docs/spec-v1.md` (the v1 spec, kept by owner decision #65; code
  beats it on conflict). No plan files or status notes in the repo.
- A decision goes in `docs/decisions.md` with a date and a reason, in the same commit as the
  code that made it; a superseded entry is marked, never deleted. Work that contradicts an
  entry says so by number and why it is worth reopening (_contradicts #54, access is an
  object, because…_).
- Name domain concepts in issue titles, test names and proposals with the words of the
  Glossary in `docs/architecture.md`; propose a missing concept as a new Glossary entry.
- Changes land on `main` by fast-forward from a branch. `.worktrees/` is ignored by git for
  branch worktrees.
- Issues live in GitHub Issues for `dmalis/dropthis`; a wish arrives as an issue, not as an
  external pull request. Triage labels: `needs-triage`, `needs-info`, `ready-for-agent`
  (fully specified), `ready-for-human`, `wontfix`.

## Where to read more

- `docs/architecture.md` — principles, key layout, write order, the drop model, errors,
  auth, policy, pruning, the operation registry, CLI and installer conventions, glossary,
  stack. Code comments cite its sections by name.
- `docs/decisions.md` — every decision, numbered, with date and reason.
- `docs/research/` — dated evidence: Cloudflare limits, Free-plan measurements, conventions.
- `docs/spec-v1.md` — the v1 user stories and surface.
- `SECURITY.md` — the shared-origin boundary and what dropthis does not protect against.
