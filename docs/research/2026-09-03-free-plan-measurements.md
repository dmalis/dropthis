# Free-plan measurements — the two numbers, measured (2026-09-03)

Issue #3, the R2 truth slice. Everything here was run against the deployed dev Worker
(`https://dropthis-dev.dropthis-app.workers.dev`) and real remote R2. No emulator was used
for any claim. Scripts: `contract-tests/measure/inline-ceiling.mjs`,
`contract-tests/measure/pbkdf2.mjs`, probes at `/_dev/*` in the dev build only.

## The two numbers

| policy | was (provisional) | is (measured) |
|---|---|---|
| `max_request_bytes` | 2,097,152 (2 MiB) | **4,194,304 (4 MiB)** |
| `pbkdf2_iterations` | 5,000 | **25,000** |

## The plan the dev instance runs on: Free — proved, not assumed

A deploy carrying `limits.cpu_ms` was refused:

```
CPU limits are not supported for the Free plan. Switch to a paid plan … [code: 100328]
```

So every number below is a Free-plan number. (The attempt existed to *emulate* Free on a
Paid account; it is not needed and the flag was removed again.)

## Finding 1 — "10 ms CPU per request on Free" is stale

`docs/research/2026-09-01-cloudflare-limits-pricing.md` records Free as 10 ms CPU per
request, and the 2 MiB provisional ceiling was derived from it. Measured: a single request
doing **200,000 SHA-256 digests over 1 KB** returns 200 in ~0.80 s wall. That is hundreds of
milliseconds of CPU in one request. The 10 ms figure no longer describes this account.

## Finding 2 — the Free CPU allowance refills; it is not a per-request ceiling

The kill is Cloudflare **error 1102, "Worker exceeded resource limits"** (HTML page, 503).
It is load-dependent. An ascending size ladder run back-to-back measures the ORDER of the
samples, not their size:

| ladder | 6 MB | 8 MB |
|---|---|---|
| ascending, 1.5 s pause, after idle | 0/10 | 0/10 |
| ascending, 3 s pause, after idle | 10/10 | 3/10 |
| ascending, immediately after heavy probes | 0/10 | 10/10 |

**Method fixed:** every (size, run) pair goes into one shuffled plan executed with a uniform
pause, so the allowance's state is uncorrelated with the size under test. `--in-order` keeps
the old behaviour for comparison.

## Finding 3 — the base64 decoder decides the ceiling

`Uint8Array.fromBase64` exists in workerd. Both decoders produce identical digests.
Same shuffled plan, 10 runs per size, 5 s pause, one file per body, sustained load:

| request body | `atob` + per-char loop | `Uint8Array.fromBase64` | median wall (native) |
|---|---|---|---|
| 256 KB | 10/10 | 10/10 | 127 ms |
| 512 KB | 8/10 | 10/10 | 146 ms |
| 1 MB | 8/10 | 10/10 | 173 ms |
| 2 MB | 9/10 | 10/10 | 199 ms |
| 3 MB | 4/10 | 10/10 | 228 ms |
| 4 MB | 2/10 | 10/10 | 254 ms |
| 6 MB | 1/10 | 10/10 | 315 ms |
| 8 MB | 2/10 | 10/10 | 395 ms |

The portable decoder collapses from 3 MB up; the native one does not fail anywhere in the
tested range. `publish` must use `Uint8Array.fromBase64`.

### Why the default is 4 MiB and not 8 MiB

The spec's rule is "the largest size that passes 10/10 with headroom one step below the
first failure". With the native decoder there is **no failure in the tested range**, so the
rule has no first failure to sit under. Three facts set the shipped value instead:

- the benchmark does parse + base64-decode + SHA-256 only. Real `publish` adds canonical
  JSON, the manifest, and up to 500 R2 writes in the same request;
- the slow-decoder column shows how fast the margin collapses when per-byte cost rises —
  a change in the decode path, not in the size, moved 4 MB from 10/10 to 2/10;
- 8 MB is the top of the tested range, so nothing above it is measured.

4 MiB passes 10/10 at 254 ms median with two measured passing steps above it, and doubles
the provisional value. Raising it further is a `config set` away, and `doctor` can measure
the instance it runs on.

## Finding 4 — PBKDF2-SHA256 cost per unlock

`Date.now()` inside a Worker only advances on I/O, so in-isolate timings all read 0. Cost is
recovered from the client's wall clock: the same route served with 1 derive and with 11,
the difference divided by 10. 5 runs per count, median:

| iterations | per derive | 8 ms budget |
|---|---|---|
| 5,000 | 1.2 ms | fits |
| 10,000 | 2.5 ms | fits |
| **25,000** | **6.1 ms** | **fits** |
| 50,000 | 12.5 ms | over |
| 100,000 | 25.2 ms | over |
| 200,000 | — | 500 (workerd caps PBKDF2 iterations) |

Cost is linear at ~0.25 ms per 1,000 iterations. **25,000** is the highest count inside the
8 ms budget in 5/5 runs — five times the provisional 5,000, for free.

## Finding 5 — R2's per-key write refusal is 10058, and only for concurrent writers

Ten writes to one key, all in flight at once, against remote R2:

```
put: Reduce your concurrent request rate for the same object. (10058)
```

Not `10029`, and not the wording AGENTS.md's "about one write per second to the same key"
implies. Typical run: 5 of 10 written, 5 refused. `storage/r2.ts` maps this to
`R2_RATE_LIMIT` (429, `Retry-After: 1`) and never retries inside the Worker; the mapper
originally missed this wording and reported `INTERNAL`, which would have told an agent not
to retry something that only needed a second.

**Five writes to one key one after another, at full speed, are all accepted.** The refusal
is about concurrency on a key, not about a one-per-second rate for a serial writer. Pinned
by `contract-tests/storage.test.ts`.

### Concurrent `update` sees the CAS, not the throttle (issue #5, 2026-09-03)

Ten `PATCH /_api/v1/drops/{slug}` of one drop issued at once, five runs against the deployed
dev Worker: **1 success and 9 `409 UPDATE_CONFLICT` every run** (occasionally 2 successes — a
request issued at the same instant can arrive late enough to read the etag the first winner
wrote, and winning on it is correct). `429 R2_RATE_LIMIT` never appeared: R2 evaluates the
`onlyIf` precondition first and reports a lost race by resolving the `put` to `null`, so the
10058 refusal above is never reached on this path. The 429 mapping is still live in
`storage/r2.ts` and is proven at the seam by `contract-tests/storage.test.ts`; the behaviour
here is pinned by `contract-tests/lifecycle.test.ts`.

## What is not measured here

- `max_unhashed_bytes` (2 MiB): the Worker-side streaming hash of a `url` entry has no code
  yet (issue #9). Unchanged, and still provisional.
- `cron_ops_budget` (40): no cron code yet (issue #6).
- Multi-file bodies: every ladder used one file per body. `--files N` exists in the script;
  the 500-file shape is worth a run when `publish` lands.
- Concurrent callers: every sample was one request at a time from one client.
