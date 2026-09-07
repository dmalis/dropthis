# The zero-terminal install: Deploy-to-Cloudflare button today, and the best first-run UX — snapshot 2026-09-04 / 2026-09-07

Issue #29. Reading was done 2026-09-04 (every URL below was read that day unless dated
otherwise). Hands-on ran in two parts: the button's setup form on the owner's dashboard on
2026-09-04 (Chrome, throwaway public repo `dmalis/dropthis-btn`), and the provisioning half
on 2026-09-07 through the same `npx wrangler deploy` the button runs (the Chrome extension
was down that day, three attempts). Every `dropthis-btn*` resource and the repo were deleted
on 2026-09-07; the log is in §9. **Read** and **hands-on** are separated throughout;
UNVERIFIED marks a claim confirmed on neither.

## 0. Recommendation (one paragraph)

Ship the button with **one typed secret and no claim step**: the setup form already asks the
human for `HMAC_SECRET` (a `.dev.vars.example` line becomes a form field, with a description
we write in `package.json`), so add a second field, `DROPTHIS_ADMIN_KEY`, whose description
says *"Ask Claude: 'generate a 40-character random password'. Paste it here and keep it — it
is your login."* The Worker never stores the value: on first request it hashes it into the
ordinary `keys/`, `keyhash/`, `users/admin` records and then ignores the environment variable
forever (rotation and revocation stay `--rotate-admin-key`). If the field is left blank the
Worker boots **unclaimed and fail-closed** exactly as AGENTS.md already specifies, so the
typed secret is an addition, not a replacement, of #38. The "done" screen is ours, not
Cloudflare's: the Worker's root page (unauthenticated, no key on it) says *"Add this URL to
claude.ai … when Claude asks you to log in, paste the password you typed at deploy"*, with
copy buttons and the Team/Enterprise Owner note. Count for a marketer with a Cloudflare
account and a GitHub account: **1 button click, 1 GitHub authorise, 2 pastes, 1 Deploy click,
1 URL click, 1 connector add, 1 login paste — no terminal, nothing to invent** (Claude
invents the password). Bootstrap invariants: bootstrap still exists only at deploy time
(no public request creates the first administrator — the secret arrives through Cloudflare's
own secret form, which only an account member can submit); the key is shown once (by Claude,
before deploy, not by us after); logs and diagnostics never carry it (the Worker holds a
hash). The one thing it bends is #38's *"inventing a secret the operator omitted"* — we do
not invent one; the operator's own agent does, and an omitted secret means unclaimed, not
invented. Owner rules.

## 1. Q1 — the button, as it works today

### Read (Cloudflare docs, all 2026-09-04)

| fact | source, verbatim where it matters |
|---|---|
| URL form | `[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=<your git repo URL>)`; "You can also optionally specify a subdirectory." — https://developers.cloudflare.com/workers/platform/deploy-buttons/ |
| What it does | "Cloudflare clones your source repository into the user's GitHub/GitLab account"; "Your users can customize key details such as repository name, Worker name, and required resource names in a single setup page"; "Cloudflare builds the application using Workers Builds and deploys it" — same page |
| Provisioning | "supported resources include: Storage: KV namespaces, D1 databases, R2 buckets, Hyperdrive, Vectorize databases, and Secrets Store Secrets. Compute: Durable Objects, Workers AI, and Queues." … "please make sure your source repository includes default values for resource names, resource IDs and any other properties for each binding." — same page |
| Secrets and vars | "Worker secrets can be defined in a `.dev.vars.example` or `.env.example` file with a dotenv format"; vars come from `vars` in the Wrangler config; per-binding help text: `package.json` → `"cloudflare": {"bindings": {"COOKIE_SIGNING_KEY": {"description": "Generate a random string using \`openssl rand -hex 32\`."}}}` — "Inline markdown `code`, **bold**, __italics__ and [links](…) are supported." — same page |
| Build/deploy commands | "If no deploy script is specified, Cloudflare will preconfigure `npx wrangler deploy` by default. If no build script is specified, Cloudflare will leave this field blank." — same page |
| Monorepo | "If your repository URL contains a subdirectory, your application must be fully isolated within that subdirectory, including any dependencies. Otherwise, the build will fail." — same page |
| GitHub required | "Source repositories from anything other than github.com and gitlab.com are not supported." "Repositories must be public in order for others to successfully use your Deploy to Cloudflare button." — same page. The **user** also needs a GitHub or GitLab account: the form's first field is "Git account" (hands-on below) |
| GitHub app scope | "Cloudflare recommends that you limit the scope of the application to only the repositories you intend to build"; org install needs an owner or "the GitHub Apps Manager role" — https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/ |
| Builds on Free | build minutes "3,000 per month", concurrent builds "1", timeout "20 minutes"; Paid "6,000 per month (then, +$0.005 per minute)", 6 concurrent — https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/ |
| Builds token | Workers Builds mints its own API token: Account Settings (read), Workers Scripts (edit), Workers KV Storage (edit), Workers R2 Storage (edit), Workers Routes (edit, all zones), User Details + Memberships (read) — https://developers.cloudflare.com/workers/ci-cd/builds/configuration/ . So the human never creates a token: **the button path removes the token-creation step #67 called the worst one.** |
| Build vars ≠ runtime | "Build variables will not be accessible at runtime"; runtime secrets live under Settings > Variables & Secrets — same page |
| Auto-provisioning naming | "Resources will be created with the name of your worker as the prefix." — https://developers.cloudflare.com/workers/wrangler/configuration/ ; ids "will be automatically written back to your Wrangler config file" (wrangler ≥ 4.45) — https://developers.cloudflare.com/changelog/post/2025-10-24-automatic-resource-provisioning/ |
| Custom domain | Not on the button's form. Config: `routes = [{pattern = "example.com", custom_domain = true}]`; "You cannot create a Custom Domain on a hostname with an existing CNAME DNS record or on a zone you do not own"; dashboard path Workers & Pages → Worker → Settings → Domains & Routes → Add → Custom Domain; "Cloudflare will create a new DNS record for you." — https://developers.cloudflare.com/workers/configuration/routing/custom-domains/ |
| End-of-deploy screen | Not documented. Blog (2025-04-08): "Cloudflare will automatically clone and create a new repository on your account"; PR previews "posted back to GitHub as a comment"; a **share button** on the Worker page generates the button snippet — https://blog.cloudflare.com/deploy-workers-applications-in-seconds/ , https://developers.cloudflare.com/changelog/post/2025-04-08-deploy-to-cloudflare-button/ |
| Access toggle | The form carries "Protect with Cloudflare Access"; a Worker behind Access reads `ctx.access.getIdentity()` — prerequisites "Zero Trust enabled on your account" — https://developers.cloudflare.com/workers/configuration/cloudflare-access/ . Zero Trust onboarding wants a payment method (2026-09-01 snapshot, `2026-09-01-auth-and-install-ux.md`) |

### Hands-on, 2026-09-04 — the setup form (Chrome, owner's account, repo `dmalis/dropthis-btn`)

The throwaway repo was a self-contained copy of `packages/worker` (the one outside import,
`skills/instance-skill.md`, copied in), names `dropthis-btn` / `dropthis-btn-drops`, an
id-less `OAUTH_KV`, `vars: {DROPTHIS_INSTANCE_NAME: "btn"}`, a `.dev.vars.example` with
`HMAC_SECRET=` and `DROPTHIS_ADMIN_KEY=`, and `package.json` binding descriptions.

Screens passed, in order:

1. `https://deploy.workers.cloudflare.com/?url=https://github.com/dmalis/dropthis-btn` →
   302 to `https://dash.cloudflare.com/?to=/:account/workers-and-pages/create/deploy-to-workers&repository=…`
   → (signed in) the account's "Create an app" wizard at step **"Create and deploy"**. A
   signed-out visitor sees the Cloudflare login page first (Google / Apple / GitHub / SSO /
   email+password; seen 2026-09-07 from a clean browser). A cookie banner overlays the page.
2. **"Set up your application — Configure your Worker project and deploy it to
   Cloudflare."** Fields, top to bottom, verbatim:
   - **Git account** — a select. On an account with no connection it offers two buttons,
     **"New GitHub connection"** and **"New GitLab connection"** (clicking one leaves for the
     provider's OAuth; the GitLab one landed on gitlab.com's sign-in behind a bot check).
     Help text: *"A Git repository will be created for you and connected to your
     application. Every push to your production branch will be deployed automatically."*
   - checkbox **"Create private Git repository"** (unchecked by default → the copy is public
     unless she ticks it)
   - **Project name** — prefilled `dropthis-btn` (the config `name`)
   - **KV namespace for OAuth sessions (claude.ai login).** ← our `package.json`
     description, rendered as the field label. Below: **"Select KV namespace"** with a
     chip **"new"**, help *"The KV namespace this binding is connected to."*, then **"Name
     your KV namespace"** (a text box; a combobox also lists existing namespaces).
   - **The R2 bucket that stores every drop. R2 must be enabled on the account.** ← our
     description. **"Select R2 bucket"**, chip **"new"**, *"The R2 bucket this binding is
     connected to."*, name prefilled `dropthis-btn-drops`.
   - **HMAC_SECRET** — *"Any long random string. Signs unlock cookies. Generate one with
     `openssl rand -hex 32`."* (our description, markdown rendered) — an empty text box.
     **No generated value, no generate button**: the human must produce it.
   - **DROPTHIS_ADMIN_KEY** — *"Optional. Leave blank to install unclaimed and claim later."*
     — empty text box. So a blank secret is accepted by the form (UNVERIFIED whether the
     deploy then sets an empty secret or none; the run did not get that far).
   - **DROPTHIS_INSTANCE_NAME** — the `vars` entry, editable, prefilled `btn`.
   - **Build command** (blank) · **Deploy command** (prefilled `npx wrangler deploy`) ·
     **Builds for non-production branches** · **Protect with Cloudflare Access** ·
     **Advanced settings** · **Back** · **Deploy**.
   Not on the form: custom domain, cron, plan, R2 enablement, account choice (it is the
   account you are signed into; the account switcher is in the header).
3. GitHub authorise, build log, and the end-of-deploy screen: **not observed** — the
   session lost the dashboard between the two days and the Chrome extension did not
   reconnect on 2026-09-07 (three attempts). What those screens show is therefore
   *read*, not seen: the GitHub App install asks for repository access (all / select), the
   build runs `npx wrangler deploy` (deploy command above), and the Worker page then shows
   the `*.workers.dev` URL and a share button. No documented "next steps" panel, no
   redirect back to the template author (contrast Vercel, §3).

### Hands-on, 2026-09-07 — what the button's deploy command does on this repo (wrangler seam)

Run from the same throwaway checkout with the dev token, `CI=1`, wrangler 4.128.0:

```
npx wrangler deploy --secrets-file btn-secrets.env
The following bindings need to be provisioned:
env.OAUTH_KV         KV Namespace
env.BUCKET           R2 Bucket
🌀 Creating new KV Namespace "dropthis-btn-oauth-kv"...
Resource name found in config: dropthis-btn-drops
🌀 Creating new R2 Bucket "dropthis-btn-drops"...
🎉 All resources provisioned, continuing with deployment...
env.OAUTH_KV (32173c877cf94c159fcbd65111d750e0)   KV Namespace
env.BUCKET (dropthis-btn-drops)                   R2 Bucket
env.HMAC_SECRET ("(hidden)")                      Environment Variable
Deployed dropthis-btn triggers (3.62 sec)
  https://dropthis-btn.dropthis-app.workers.dev
  schedule: 0 * * * *
```

Verified that run:
- **KV auto-named `<worker>-<binding, lower-cased, `_`→`-`>`** = `dropthis-btn-oauth-kv`
  (the docs say "worker name as the prefix" and nothing more). R2 takes `bucket_name`
  as written. Non-interactive: no prompt, no `--x-provision` flag needed.
- **No id written back** to `wrangler.jsonc` in this run (`git status` clean apart from
  `package-lock.json`), contradicting the changelog's "automatically written back". Whether
  the button writes ids into the created repo (the docs say it does) is UNVERIFIED.
- **Cron deployed**: `GET …/workers/scripts/dropthis-btn/schedules` → `{"cron":"0 * * * *"}`.
- **Secrets at deploy**: `--secrets-file` set `HMAC_SECRET` in the same deploy, no second
  step. The button's form fields end up as Worker secrets the same way (read).
- **The Worker booted with no `init`**: `/_api/v1/health` 200 `{"ok":true}`; `/_connect`
  200 with the connector URL `https://dropthis-btn.dropthis-app.workers.dev/_api/mcp`
  already correct (`instance-config.ts` falls back to the request origin when
  `system/config.json` is absent); `/_skill.md` 200; `/_api/v1/drops` 401
  `UNAUTHENTICATED`; `/nosuchslug/` 404. So a button deploy is a working, empty,
  **unusable** instance: there is no key and nothing can make one — exactly the bootstrap
  problem of §2.
- **Free plan**: the account is Workers Free (proved 2026-09-03, #73); the deploy, the
  cron and both resources went through. Five cron triggers per Free account (existing
  limit, `2026-09-01-cloudflare-limits-pricing.md`) still applies to the button.
- **R2 enablement** is not inline and not on the form. On an account with R2 never
  enabled the provisioning step must fail with `10042` (UNVERIFIED — the dev account has
  R2). The form's field description is the only place to warn; the README must say "enable
  R2 first" with the exact URL.

## 2. Q2 — the bootstrap problem, ranked

After the button nobody ran `init`: no `keys/`, no `keyhash/`, no `users/admin`. Options,
with the AGENTS.md invariants ("Bootstrap exists only in the installer; no public request
can create or claim the first administrator … returns the new admin key exactly once …
Diagnostic output and Worker logs never contain it … rotation requires an explicit command"):

| | flow for the marketer | human steps | security | invariants |
|---|---|---|---|---|
| **(a) typed secret at deploy, `DROPTHIS_ADMIN_KEY`** | Claude generates a password in the chat; she pastes it into the form field; after deploy she pastes the same into claude.ai's login page | 0 extra (the field sits on the form she already fills) | The value crosses: the chat transcript (Claude retains it — but every flow ends with the key in that transcript, because the agent relays it), the dashboard form (TLS, Cloudflare's own secret store), the OAuth login page. Weakest link: a human-chosen weak string; the Worker enforces ≥ 32 chars. A secret typed once and never shown again ≈ Stripe's "create secret key … You can't retrieve it later" | Holds: the deployer proves ownership by submitting Cloudflare's secret form (account member only); no public request creates admin; the Worker stores `sha256`, never the value; **the env value is read once, at the first request that finds no `users/admin`, then ignored** — rotation is still `--rotate-admin-key`, and a rotated key invalidates the typed one. Bends #38's "inventing a secret the operator omitted" only in spirit: nobody invents; blank = (b). |
| **(b) unclaimed + one-time claim code** (AGENTS.md as written) | `npx dropthis claim` with a Cloudflare token — a terminal, a token, or the Cloudflare MCP connector | +3 to +5 (token page #67 called the worst step; or add Cloudflare's own connector to claude.ai and grant it the account) | Strongest: ownership = holding account access; nothing typed by a human | Holds by construction |
| **(b′) claim through the Cloudflare MCP server** | She adds `https://mcp.cloudflare.com/mcp` (Code Mode, `execute` over the whole API) to claude.ai, logs in to Cloudflare, says "claim my dropthis"; Claude reads `system/claim-code` from the bucket and POSTs `/claim` | +2 (a second connector, a Cloudflare OAuth grant with broad scope) | As (b), but the agent now holds a wide Cloudflare grant in the same chat | Holds; zero terminal. Untested (the Bindings server has "no object put" and only bucket-level R2 tools; Code Mode can call the R2 object GET endpoint — UNVERIFIED) |
| **(c) `/_claim` first-visitor page** | Open the URL, the page shows the key once and locks | 0 | **Nothing proves the first visitor is the owner**: the `*.workers.dev` name is guessable and Workers Builds posts preview URLs to GitHub; a race between deploy and first visit is a takeover. Rejected in #38 as "first caller becomes admin" | Breaks "no public request can create or claim the first administrator" |
| **(c′) `/_claim` behind Cloudflare Access** | tick "Protect with Cloudflare Access" on the form; the Worker trusts `ctx.access.getIdentity().email` for `/_claim` only | +2–4 (Zero Trust onboarding, payment method, Access policy) and the toggle gates **all traffic** — public drops included — unless Access is scoped per path, which needs a zone (custom domain) | Sound identity, wrong blast radius | Holds, but the product is no longer public-by-default |
| **(d) deployer identity / on-deploy hook** | — | — | Cloudflare offers no "who deployed me" to a Worker and no post-deploy hook that could mint and hand back a secret (read: Workers Builds config, deploy-buttons docs; nothing of the kind exists 2026-09-04) | n/a |

**Rank by UX:** (a) ≫ (c) > (b′) > (c′) > (b). **Rank by security:** (b) = (b′) > (a) ≈ (c′)
≫ (c). **Pick: (a) with (b) as the blank-field fallback.** The only cost is one field with
a sentence next to it, and the marketer's agent does the inventing.

Two rules make (a) safe enough to put in front of the owner:
1. The Worker treats `DROPTHIS_ADMIN_KEY` as a **seed, not a credential**: first request
   with no `users/admin` → write `keys/<id>.json` (label `admin`, scope `admin`, hash),
   `keyhash/<sha256>`, `users/admin`; every later request ignores the variable. A
   `--rotate-admin-key` (or a later `user remove`/`add`) leaves the stale env value
   harmless. `doctor` gets a check `admin_seed_consumed` that says so.
2. Minimum length 32; `/_api/v1/health` stays `{ok:true}` either way; an unclaimed
   instance (blank field) answers `503 UNCLAIMED` on everything but health and the root
   page, which says how to claim.

## 3. Q3 — what the best first-run flows do in the first 60 seconds (read 2026-09-04)

| product | the form | secrets | the last screen | worth copying |
|---|---|---|---|---|
| **Cloudflare button** (hands-on §1) | one page: git account, project name, one block per binding with our description, one box per secret, vars, commands | typed by the human; descriptions may carry markdown and links; **no generated values** | the Worker's dashboard page (URL, share button); no redirect, no "next steps" | binding descriptions are the whole UX budget — write them like a checklist |
| **Vercel Deploy Button** — https://vercel.com/docs/deploy-button/environment-variables (2026-07-15), …/callback (2026-03-17) | `env=KEY1,KEY2` lists required vars, `envDescription`, `envLink` "should point to specific documentation about your environment variables", `envDefaults` for non-secret defaults | "You cannot pass environment variable values using this parameter because the URL is saved in the browser history" | **`redirect-url`**: after success Vercel sends the user to *your* page with `deployment-url`, `project-name`, `repository-url`, `project-dashboard-url` attached — the template author owns the done screen | the done screen must be ours; Cloudflare has no redirect, so our Worker's root page is the substitute |
| **Netlify Deploy button** — https://docs.netlify.com/deploy/create-deploys/ | `netlify.toml` `[template.environment] SECRET_TOKEN = "change me for your secret token"` — placeholder text is the label; `base=` and `create_from_path=` for subdirectories; env values may ride in the URL **hash** (client-side only) | typed; hash-prefill for non-secrets | site live on a `*.netlify.app` URL | placeholder-as-label |
| **Railway templates** — https://docs.railway.com/templates/deploy , …/variables/reference | one config screen per service, "Pre-Configured Environment Variables" dropdown | **`${{secret()}}` generates a random secret at deploy** — "Generates a random secret (32 chars by default)"; also `randomInt()` | service page, "Generate domain" one click; repo not copied ("attach to and deploy directly from the template repository … Eject" to get a copy) | generated secrets — the thing Cloudflare's form lacks; the closest we get is "ask Claude to generate it" |
| **Fly launch** — https://fly.io/docs/launch/create/ | terminal, then "Do you want to tweak these settings before proceeding?" opens a web page (name, region, resources) | none generated | prints the app URL | web-tweak-then-continue is the pattern `init` already follows (#67) |
| **Neon on Vercel Marketplace** — https://neon.com/docs/guides/vercel-native-integration | Install → choose region/plan/name | **nothing shown**: `DATABASE_URL` etc. "injected into your Vercel project" | Vercel Storage tab: status, plan, connection string, "Open in Neon" | the key never passes through a human — the ideal we cannot reach without a Cloudflare-side integration |
| **Stripe keys** — https://docs.stripe.com/keys | Create secret key → verification code by email/SMS → name → Create | "Click the key value to copy it. Save the key value. You can't retrieve it later." then "Add a note … the location where you saved the key" | — | show-once + "where did you save it" note; our root page should say "you typed this at deploy — it is not stored here" |
| **claude.ai custom connector** — https://support.claude.com/en/articles/11175166 | Customize > Connectors > "+" > "Add custom connector": name + remote MCP server URL, Advanced: OAuth client id/secret | the key is pasted on **our** OAuth page (phase-zero spike passed, #72) | connector listed; per-chat enable via "+" > Connectors | one field — so our page must hand her exactly one URL |

Cross-cutting: the best flows put **one thing per screen** and never make the human
carry a value across more than one screen. In our flow she carries exactly one (the
password she asked Claude for) across two (form, login page).

## 4. Q4 — the claude.ai handoff, fewest steps

The Worker already serves `/_connect` (hands-on: 200 with the right connector URL on a
fresh button deploy) and its copy already says the key arrives separately. What is missing
is the **landing**: Cloudflare's last screen shows the `*.workers.dev` URL; the marketer
clicks it and gets the viewer's 404 (`/` is not a drop). Make `/` (unauthenticated, no
secrets) the done screen:

```
dropthis is running at https://dropthis-<name>.<sub>.workers.dev

1. Add it to claude.ai
   Settings → Connectors → Add custom connector → paste:
   https://dropthis-<name>.<sub>.workers.dev/_api/mcp            [Copy]
   (Team or Enterprise plan: an Owner adds it under Organization settings → Connectors;
   everyone else then presses Connect.)

2. When Claude asks you to log in
   paste the password you typed at deploy (DROPTHIS_ADMIN_KEY). It is not stored on this
   page and cannot be shown again. Lost it? Redeploy with a new one in the Cloudflare
   dashboard → Settings → Variables and Secrets.

3. Say to Claude: "publish a hello page on dropthis"

Your own domain (optional): Cloudflare dashboard → this Worker → Settings → Domains &
Routes → Add → Custom Domain. Then tell Claude: "set dropthis canonical URL to https://…".
```

Steps after Deploy: click URL (1) → copy (1) → claude.ai add connector (3 clicks + 1 paste)
→ Connect → login page paste (1). No QR (the human is already on a desktop with a
clipboard; a QR would only help a phone, which cannot run the dashboard flow well anyway).
A "copy for claude.ai" block is one URL, not a snippet — claude.ai's form has one field.

Team/Enterprise: only an Owner/Primary Owner can add the connector
("Organization settings > Connectors", read 2026-09-04); members "Connect" and each logs in
with their own key. The admin creates member keys through Claude (`user add <label>`
returns the key once plus the `connect` object with the ready-to-send message) — no change.

## 5. Q5 — custom domain from the button

Not possible from the form (hands-on: no such field). Two second steps:

- **Dashboard click** (recommended for the marketer): Workers & Pages → the Worker →
  Settings → Domains & Routes → Add → Custom Domain → type `drops.example.com` → Add.
  Cloudflare creates the DNS record; the zone must already be on the same account (read).
  Then one sentence to Claude — `config set {canonical_url}` through the admin MCP tool —
  or nothing at all if the Worker learns `canonical_url` from the **first authenticated
  request on a non-workers.dev host** (agent2web's pattern, `2026-09-01-provisioning-study.md`
  §8; today `instance-config.ts` only falls back to the request origin per request, which
  already serves drops correctly on either host but leaves OAuth issuer/discovery
  host-dependent — a browser client that logged in on one host is fine, it never sees the
  other).
- **`init --domain` later** from a terminal: needs the Cloudflare token or browser login,
  i.e. the whole CLI path she chose the button to avoid. Keep it for operators.

`routes: [{pattern, custom_domain: true}]` in the shipped config is not an option: the
template cannot know her hostname, and the form has no field for it.

## 6. The recommended flow, screen by screen, with the words

Preconditions she may lack: a Cloudflare account (sign-up, card for R2 — Cloudflare's, not
ours, #6) and a GitHub account (new: the button needs one; a marketer may not have it —
this is the button path's real hidden cost, and Netlify/Vercel share it).

| # | screen | she does | our words |
|---|---|---|---|
| 0 | README / llms.txt | clicks **Deploy to Cloudflare** | above the button: *"Before you click: (1) a Cloudflare account with R2 enabled — https://dash.cloudflare.com/?to=/:account/r2 ; (2) a GitHub account; (3) ask Claude for a 40-character random password and keep the chat open."* |
| 1 | Cloudflare login (if signed out) | signs in | — |
| 2 | **Set up your application** | picks/creates the GitHub connection (authorise, "Only select repositories" is fine), leaves the names, pastes password into `DROPTHIS_ADMIN_KEY`, pastes a second one into `HMAC_SECRET`, presses **Deploy** | field descriptions (`package.json`): `HMAC_SECRET`: *"Ask Claude for a second random password and paste it. It signs unlock cookies; you never need it again."* `DROPTHIS_ADMIN_KEY`: *"Ask Claude: 'generate a 40-character random password'. Paste it here and keep it — it is your login to dropthis (32 characters minimum). Leave blank only if you will claim from a terminal."* `BUCKET`: *"Stores every drop. R2 must be enabled on this account first: Cloudflare dashboard → R2."* `OAUTH_KV`: *"Login sessions for claude.ai. Keep the default."* |
| 3 | build (≈1–2 min, read) | waits | — |
| 4 | Worker page | clicks the `*.workers.dev` link | — |
| 5 | **our root page** (§4) | copies the connector URL, opens claude.ai | the §4 text |
| 6 | claude.ai → Connectors → Add custom connector | pastes URL, Add, Connect | — |
| 7 | our OAuth page | pastes the password | existing one-form page (#72) |
| 8 | chat | "publish a hello page" | the skill takes over |

Counts: clicks ≈ 12, things to invent 0 (Claude invents two strings), things to copy 3
(two passwords in, one URL out, one password in again), places to get lost 3 — the GitHub
authorise (org vs personal), the R2-not-enabled build failure (a red build log with a
Cloudflare error, not our words — the README warning is the only mitigation we control),
and the Worker page (which link to click; our root page catches it the moment she does).

Compared with AGENTS.md's current button count (5 steps, 4 browser, ends in a terminal):
**6 browser steps, 0 terminal, 0 tokens**; CLI path stays 3 steps for people with a terminal.

## 7. The security trade-off, plainly

- The admin credential is **chosen outside the system** and typed into two forms. Its
  strength is whatever Claude generated (we enforce ≥ 32 chars and reject obvious
  dictionary strings? — no: length only; anything else is theatre). It exists in the
  claude.ai transcript from before the deploy. In every other flow it exists in a transcript
  from after the deploy. Net: unchanged.
- The env secret is a **seed consumed once**. If she never rotates, the env value stays
  equal to the live key forever; anyone who can read Worker secrets can read it — but that
  person can already redeploy the Worker. Not a new capability.
- `HMAC_SECRET` typed by a human is new: the CLI path generates it. Same mitigation
  (length), same "ask Claude" instruction; a weak one weakens unlock cookies and idempotency
  results only.
- Blank field = unclaimed, fail-closed, as #38. Nothing "first caller" anywhere.
- The GitHub copy of the repo is **public by default** ("Create private Git repository"
  unchecked). It holds no secrets (`.dev.vars.example` is a template) — but it does hold
  her Worker name and bucket name in `wrangler.jsonc`, and the button docs say ids get
  written into it. Tell her to tick the box, or accept it.
- Workers Builds holds a **broad account token** (Workers/KV/R2 edit) on her account for
  the lifetime of the project. Cloudflare's design, not ours; say it in SECURITY.md.

## 8. Product changes the recommendation needs (no code here)

| # | change | size |
|---|---|---|
| 1 | Worker: `DROPTHIS_ADMIN_KEY` seed — on a request with no `users/admin`, mint the admin record from `sha256(env)`, min length 32, then ignore the variable; `doctor` check `admin_seed_consumed`; contract tests: seed once, second deploy with a different value does nothing, rotation invalidates the typed key, blank → unclaimed | M |
| 2 | Worker: unclaimed mode — `503 UNCLAIMED` on all but `/_api/v1/health` and `/` when no admin record and no seed (already specified after v1; the seed makes it reachable) | M (S if the claim endpoint waits) |
| 3 | Worker: root page `/` — the done screen of §4 (unauthenticated, no key), the same text served as `/_connect` today plus the three numbered steps; viewer keeps 404 for unknown slugs but `/` is reserved (`RESERVED_PREFIXES` gets `/` exact + a collision test) | S |
| 4 | A **self-contained deploy target**: the button cannot build `packages/worker` (it imports `../../../skills/instance-skill.md` and lives in a workspace). Either bundle the skill into the package (copy on build) and point the button at `tree/main/packages/worker` with the package's own lockfile, or publish a release-bundle repo. Hands-on says a subdirectory works only when "fully isolated … including any dependencies" | M |
| 5 | `packages/worker/package.json`: `cloudflare.bindings` descriptions (§6 words) and `.dev.vars.example` with `HMAC_SECRET=` and `DROPTHIS_ADMIN_KEY=` | S |
| 6 | Canonical URL learned from the first authenticated non-workers.dev request, or a documented `config set canonical_url` sentence on the root page (§5) | S |
| 7 | README: the button block (§10) with the three preconditions; SECURITY.md: the typed-secret and Workers-Builds-token paragraphs | S |
| 8 | Decision entry amending #38 (typed seed first, claim second) — owner's call | — |
| 9 | Later, optional: `dropthis claim` through the Cloudflare MCP connector (b′) for people who left the field blank; verify Code Mode can GET an R2 object first | L |

## 9. Hands-on log and deletions

- 2026-09-04: created public repo `dmalis/dropthis-btn` (copy of `packages/worker`,
  names `dropthis-btn*`); opened the button on the owner's account; recorded the setup
  form (§1); the session ended before Deploy (a mis-click opened GitLab sign-in behind a bot
  check, which was not passed). Nothing was deployed that day; no resource existed.
- 2026-09-07: Chrome extension "not connected" ×3; Playwright's clean browser stops at
  Cloudflare login (no credentials typed, by rule). Ran `npx wrangler deploy --secrets-file`
  from the throwaway checkout with the dev token (§1, wrangler seam). Probed the live
  Worker. Then deleted, all `success: true` via the Cloudflare API: Worker `dropthis-btn`
  (`DELETE …/workers/scripts/dropthis-btn?force=true`), KV
  `32173c877cf94c159fcbd65111d750e0` (`dropthis-btn-oauth-kv`), bucket `dropthis-btn-drops`
  (empty); `gh repo delete dmalis/dropthis-btn --yes` (a following `gh repo view` → not
  found). Re-listed Workers, buckets and KV: zero `dropthis-btn*`; the URL answers 404.
  The secrets file was removed from the scratchpad. `dropthis-damjan*`, `dev*`,
  `dropthis-notice` and DNS were not touched.
- No GitHub App was installed and no Workers Builds project was created (the flow never
  reached "Deploy" in the dashboard), so nothing of that kind is left on the GitHub account.

## 10. What the README button would look like

```markdown
## Install without a terminal

Before you click: a Cloudflare account with **R2 enabled**
(dashboard → R2 → Enable), a **GitHub** account, and Claude open — ask it for
"two 40-character random passwords" and keep them.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/dmalis/dropthis/tree/main/packages/worker)

Paste one password into **DROPTHIS_ADMIN_KEY** (your login) and the other into
**HMAC_SECRET**, press **Deploy**, then open the URL Cloudflare shows you — the page
there says how to add dropthis to claude.ai.

Prefer a terminal? `npx dropthis init` does all of this and generates the passwords.
```

(The `tree/main/packages/worker` form assumes change 8.4; until then the URL points at
whatever self-contained repo ships the Worker.)

## 11. Open, unverified

- The button's own build screens and end screen (not seen; docs silent).
- Whether the button writes provisioned ids into the created repo (docs say yes; wrangler
  in CI did not write them locally).
- A blank secret field: empty secret vs no secret.
- R2-not-enabled behaviour at provisioning (expected `10042` at build time, i.e. a red
  build log).
- Code Mode MCP reading an R2 object (for b′).
