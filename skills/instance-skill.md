---
name: dropthis
description: Share content from this dropthis instance as a permanent URL. Use when the user says share this, send this to someone, make this public, get me a link, put this online, show this to a person, or wants to change, read, list or delete a link they already have.
---

# dropthis at {{base_url}}

dropthis turns files an agent produced into a permanent URL on this instance. One call in,
one URL out. You are the only kind of caller: the human talks to you, you call dropthis, and
the human sees what you relay — a URL, a password, a ready-to-send message.

Connect over MCP at `{{mcp_url}}` (bearer key, or the paste-key login page for claude.ai),
or call REST under `{{base_url}}/_api/v1` with `Authorization: Bearer <key>`. The tool names
below are the MCP names; the REST routes are the same
five core operations plus the two staged-upload steps.

## What the user says, and what you call

- **share this, send this to someone, make this shareable or public, get me a link, give me
  a URL, host this, put this online, show this to a person** → `dropthis_publish`. Files in,
  one permanent URL out.
- **change it, fix it, update the page, replace the content, rename it, extend it, make it
  expire later, bring the link back** → `dropthis_update` with the URL the user already has.
  The URL stays the same. Never publish again to change something you already published:
  that makes a duplicate URL.
- **what is at this link, pull the current version, is it still live, when does it expire**
  → `dropthis_get` with the URL or the slug.
- **what have I published, list my drops, find the report I shared last week** →
  `dropthis_list`.
- **delete it, take it down, remove the link, unpublish** → `dropthis_delete`.

## The rules that matter

- **The URL is the identity.** `dropthis_get`, `dropthis_update` and `dropthis_delete` take
  the drop's URL or its slug (the first path segment). Nothing is resolved first.
  A URL from another instance is `WRONG_INSTANCE`: send it to the instance that made it.
- **Always set `title`.** It is what the user sees in lists and on the password page.
- **The slug is generated.** Pass `slug` on `publish` only when the user wants a readable
  campaign link — 3-40 characters of `a-z 0-9 -`, permanent, and `SLUG_TAKEN` when another
  drop already holds it.
- **Text inline, everything else by `url`.** A file entry is `{path, text}`,
  `{path, base64}`, `{path, url}` or — on `update` only — `{path, sha256}`: exactly one of
  the four.
  - `{path, text}` for text you wrote: HTML, CSS, JS, Markdown, JSON, SVG.
  - `{path, url}` for a picture, PDF, font or archive that already exists at a public
    http(s) address. This instance fetches it, so **it costs you no tokens**. Add `sha256`
    and `size` when you know them: with both, the body is streamed straight through and may
    be up to **{{max_file_bytes}} bytes**. Without them the instance has to hold the body
    itself and refuses above **{{max_unhashed_bytes}} bytes**. A body that is not `size`
    bytes long is `HASH_MISMATCH` and nothing is stored. A target that is not public, is not http(s), or does not
    answer, is `FETCH_FAILED`; wrong bytes are `HASH_MISMATCH`. At most {{max_url_entries}}
    `url` entries per call.
  - `{path, base64}` **only for small binaries**. The bytes are your own generated tokens:
    roughly **one output token per byte**, so a 200 KB photo is about 270,000 tokens and you
    will stall long before you finish typing it. If the image is yours to make, make it
    sprite-sized first — **128 px or less, JPEG or WebP, a few KB** — and inline that. If it
    already lives on the web, use `url`.
  - The whole call must stay under **{{max_request_bytes}} bytes ({{max_request_mib}} MiB)**,
    this instance's `max_request_bytes`, or it is `PAYLOAD_TOO_LARGE`. A single call carries
    at most {{max_files}} files.
- **Three ways to move bytes, in this order.** Inline `{path, text}` for text you wrote, and
  `{path, base64}` only for a few KB. `{path, url}` for anything already at a public http(s)
  address — it costs you no tokens. `dropthis_upload` when the file is bigger than that and
  **your environment can run `curl` and reach the internet**: send the manifest, `curl -sS -T
  <file> '<put_url>'` for each hash in `missing`, then `dropthis_commit`. The `dropthis` CLI
  does the same three steps for you. If none of the three applies, shrink the file.
- **`update` replaces the whole file set.** Send every file the drop should have, not only
  the changed ones: `dropthis_get` with `files: true` returns the current text content, so
  read, change, write back. **Send the changed files inline and every other one as
  `{path, sha256}`** — the digest `dropthis_get` returned for it. That fourth entry kind
  keeps the bytes the drop already has: nothing is sent, so a one-line CSS fix in a drop
  full of images costs you the CSS and nothing else. A hash this drop does not hold is
  `INVALID_INPUT`, and `dropthis_publish` refuses the kind — a new drop has no files yet.
  `meta` merges at the top level; a key set to `null` is removed.
{{password_rule}}
- **Expiry and grace.** `expires` is `"7d"`, a date, an RFC 3339 instant or `"never"`; this
  instance's default is **{{expiry_default}}**, its maximum **{{expiry_max}}**, and
  `"never"` is **{{allow_never}}**. After expiry a link answers 410 for 7 days of grace; inside grace
  `dropthis_update` with a future `expires` brings it back in one call. Past grace it is
  `EXPIRED_FINAL` and must be published again.
- **Retries never duplicate.** Send `idempotency_key` on `publish` and `update`; a retry
  with the same key and payload returns the same result.
- **Errors teach.** Every error is `{code, message, remediation, retryable}`. Act on the
  code; read the remediation only when you are off-path.

## The tools

{{tools}}

## Admin tools (instance key only)

{{admin_tools}}
