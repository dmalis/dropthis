# Cloudflare primitives, limits and pricing — snapshot 2026-09-01

Research report produced by an agent during the founding design session. Figures were
fetched from live Cloudflare docs on the date above; anything not on a docs page is tagged
UNVERIFIED. Re-check before relying on a number for a decision.

## Workers

| Item | Free | Paid | Source |
|---|---|---|---|
| Requests | 100,000/day | unlimited (10M/mo incl.) | https://developers.cloudflare.com/workers/platform/limits/ |
| Request body | 100 MB | 100 MB (Ent 500 MB) | limits |
| CPU time / request | 10 ms — **STALE, measured false 2026-09-03** (see `2026-09-03-free-plan-measurements.md`: one Free request did 200,000 SHA-256 digests over 1 KB; the allowance refills instead of capping each request) | 30 s default, 5 min max | limits |
| CPU / cron invocation | 10 ms | 30 s (<1h interval), 15 min (≥1h) | limits |
| Subrequests / request | 50 external / 1,000 internal (review-reported 2026-09-01, UNVERIFIED) | 10,000 default (review-reported, UNVERIFIED; was 1,000) | limits |
| Script size | 3 MB gz | 10 MB gz | limits |
| Workers / account | 100 | 500 | limits |
| Cron triggers / account | 5 | 250 | limits |
| Routes / zone | 1,000 | 1,000 | limits |
| Custom Domains / zone | 100 | 100 | limits |
| Cache API calls / request | 50 | 1,000 | limits |
| Memory / isolate | 128 MB | 128 MB | limits |

Price: $5/mo minimum, 10M requests + 30M CPU-ms included, then $0.30/M requests,
$0.02/M CPU-ms — https://developers.cloudflare.com/workers/platform/pricing/

## R2

| Item | Free tier | Beyond | Source |
|---|---|---|---|
| Storage | 10 GB-mo | $0.015/GB-mo | https://developers.cloudflare.com/r2/pricing/ |
| Class A (writes, list, copy, multipart) | 1M/mo | $4.50/M | pricing |
| Class B (get, head) | 10M/mo | $0.36/M | pricing |
| Egress | free | free | pricing |
| Delete, abort multipart | free | free | pricing |

Limits: object 5 TiB; single-part upload 5 GiB; buckets/account 1,000,000; custom
domains/bucket 100; key 1,024 B; metadata 8,192 B; **1 write/sec to the same key** —
https://developers.cloudflare.com/r2/platform/limits/

Binding API (https://developers.cloudflare.com/r2/api/workers/workers-api-reference/):
`put(key, ReadableStream|…, {onlyIf, httpMetadata, customMetadata, sha256…})` streams
`request.body` directly, so the Worker's 100 MB request-body cap is the real per-upload
ceiling. Multipart via binding. `list()` ≤ 1,000 entries with `prefix`/`delimiter`/`cursor`.
`delete()` up to 1,000 keys per call. Presigned URLs need S3 access keys (expiry 1 s–7 days).
Lifecycle rules: delete after N days / on a date, transition, abort stale multiparts; 1,000
rules/bucket; set via `wrangler r2 bucket lifecycle` —
https://developers.cloudflare.com/r2/buckets/object-lifecycles/

**Payment method:** get-started says to "complete the checkout flow to add an R2
subscription"; docs never say a card is required, community threads report it is, even for
free-tier use — UNVERIFIED in docs, near-certain in practice.

### Conditional writes (basis of the R2-only design)

`put(key, body, {onlyIf})` accepts `R2Conditional` (`etagMatches`, `etagDoesNotMatch`,
`uploadedBefore`, `uploadedAfter`) **or a `Headers` object** — "all conditional headers
aside from `If-Range` are supported"; a failed condition makes `put()` return `null`.
Release notes confirm wildcard support: 2022-07-30 "`If-Match`/`If-None-Match` headers now
support arrays of ETags, Weak ETags and wildcard (`*`)"; 2022-09-19 `onlyIf` on `put()`;
2023-06-16 bindings accept "strong, weak or a wildcard" etags —
https://developers.cloudflare.com/r2/platform/release-notes/

Therefore: **slug claim = `put(slug, …, {onlyIf: new Headers({'If-None-Match': '*'})})`,
null = taken; meta pointer CAS = `If-Match: <etag>`.** Prefer the `Headers` form (the
documented wildcard path). Miniflare had reversed conditional logic
(https://github.com/cloudflare/workers-sdk/issues/6411, closed not-planned) — **verify
against remote R2, not `wrangler dev` local.**

### Consistency

Strong and global: "the effect of an operation will be observed globally, immediately, by
all clients"; `list()` is strongly consistent; deletes immediately 404. Unconditional
concurrent writes to one key are last-writer-wins —
https://developers.cloudflare.com/r2/reference/consistency/

### list() as index

Each `list()` is a Class A op ($4.50/M) — 12.5× a GET. Slug → drop lookup must be a direct
GET, never a list. R2-as-database is comfortable to ~10k drops if every hot read is a direct
GET and expiry uses date-bucketed markers; add an index only when listings need sorting by
anything other than key order.

### R2-only vs +DO vs +D1

| | Installer must create | Free tier | Atomicity |
|---|---|---|---|
| R2 only | 1 bucket (+ R2 subscription/card) | 10 GB, 1M A, 10M B | per-key conditional write |
| R2 + 1 Durable Object | nothing extra (declared in config) | SQLite DOs on Free | full serialization |
| R2 + D1 | a D1 database + migrations | 5M rows read/day, 500 MB/db | SQL txn |

## D1 (not used; for reference)

Free: 5M rows read/day, 100k written/day, 5 GB, 500 MB per DB, 10 DBs/account. Paid: 25B
reads/mo, 50M writes/mo, 10 GB per DB —
https://developers.cloudflare.com/d1/platform/pricing/ ,
https://developers.cloudflare.com/d1/platform/limits/

## KV

Free: 100k reads, 1k writes, 1k deletes, 1k lists per day; 1 GB; eventual consistency; 1
write/sec per key — https://developers.cloudflare.com/kv/platform/pricing/ . Poor as a
primary index for a publishing app; fine for OAuth session storage.

## Durable Objects

Available on the Free plan, SQLite backend only: 100k requests + 13,000 GB-s/day; 5M rows
read, 100k written/day; 5 GB total —
https://developers.cloudflare.com/durable-objects/platform/pricing/

## Workers Static Assets

Uploaded by wrangler at deploy time only; no runtime write API; requests free and unlimited —
https://developers.cloudflare.com/workers/static-assets/ . Confirms R2 is the store for
runtime uploads.

## Cache API

`caches.default` is per-colo; `cache.delete` purges only the invoking colo; `Set-Cookie`
responses are never cached — https://developers.cloudflare.com/workers/runtime-apis/cache/ .
Cache Rules: 10/zone on Free. Tiered Cache available on Free.

## Hostnames

- Workers Custom Domains: auto DNS + cert, no wildcards, zone must be in the account, 100
  per zone — https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
- Routes: wildcard patterns, 1,000/zone —
  https://developers.cloudflare.com/workers/configuration/routing/routes/
- Cloudflare for SaaS (Custom Hostnames) for domains not in the account: on Free/Pro/Business;
  100 hostnames free, $0.10/mo each beyond, 50,000 max —
  https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/

## Other

- Cron: 5/account Free, 250 Paid; Free cron gets 10 ms CPU.
- Secrets: `wrangler secret put` per Worker; account-level Secrets Store in open beta, 100
  secrets/account — https://developers.cloudflare.com/secrets-store/
- Workers Builds (git → deploy): included on Free, 3,000 build-min/mo —
  https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/
- Workers for Platforms: $25/mo + 1,000 scripts — overkill; we serve many clients' content,
  not their code.

## Cost estimates

- Personal instance: **$0/mo** (Workers Free + R2 free tier; card on file required for R2).
- 20 client sites, ~500k views/mo: **≈ $5/mo** — Workers Paid, because ~83k requests/day
  sits at the Free 100k/day ceiling; R2 ≈ 2 GB stored and ≲2.5M Class B ops, inside free
  tier; egress $0. Add ~$0.60/mo per 50 GB stored.
