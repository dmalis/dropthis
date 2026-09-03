# Security and abuse boundary

## What dropthis does not do

dropthis serves uploaded HTML as active content. It does not sandbox that content or make it
safe. Anyone with a key can publish JavaScript that runs in visitors' browsers on the drop's
origin. Serve drops from a dedicated domain, never from a subdomain of a site whose cookies
matter: cookies scope to parent domains, so a drop at `drops.example.com` could read and set
cookies for `example.com`. A shared hostname's path-scoped unlock cookies are a convenience,
not a security boundary between drops: active HTML in one drop can request another drop's
path, and the browser attaches that path's unlock cookie if you unlocked it. Two audiences
that must not see each other's drops get two instances.

## Passwords, plainly

- A generated password (`password: "generate"`, the agents' default) is 16 random
  characters and is returned once: to the call that generated it and to identical retries
  carrying the same `idempotency_key` within 7 days (that stored copy is encrypted at rest
  with a key derived from `HMAC_SECRET`). `get` and `list` never return it.
- A chosen password needs at least 8 characters and is stored as PBKDF2-SHA256 (salted, at
  the highest iteration count the plan's CPU budget allows). The unlock cookie is host-only,
  `Secure`, `HttpOnly`, `SameSite=Lax`, scoped to `/<slug>/`, and signed over a per-drop
  nonce that rotates on every real password change — changing the password logs everyone
  out. Re-sending the password a drop already has is a no-op and keeps the nonce, so a
  settings update does not log visitors out for nothing. The cookie also carries its own
  expiry (7 days, never past the drop's) inside the signature, so it cannot be extended.
- **v1 has no attempt rate limiting** (the design stores no counters). A chosen password
  can be guessed by a patient attacker; a drop that must not be guessed uses a generated
  one. The same holds for the OAuth paste-key page: a wrong key re-renders the form and
  issues nothing, and nothing counts the attempts — a key is 256 random bits, so the page
  is not guessable either. Rate limiting arrives when a real deployment needs it.
- A generated slug (10 characters, `a-z0-9`) with `noindex` is a share link, not a secret:
  anyone with the URL can open an unprotected drop. A slug the caller CHOSE (`publish({slug})`)
  is weaker still — `/spring-sale` is guessable by anyone who tries — so a drop that must not
  be found by guessing takes a generated slug, a password, or both.

## Operator controls

- Any key can be revoked and any drop deleted immediately (`user remove`, `delete`).
  Revoking a key ends every OAuth session behind it: an OAuth token is an alias for a key,
  the grant in `OAUTH_KV` stores the key id (encrypted) and never the key, and every
  `/_api/mcp` request re-reads the key record and its `keyhash/` pointer before the MCP
  surface runs — the same write that ends bearer access ends OAuth access. A connection
  never expires on its own: refresh tokens and grants carry no expiry, and a refresh is
  refused only when the key behind it is gone. It ends with `user remove`, an admin key
  rotation, or the user disconnecting the connector.
- A `client_id` that is a URL (a Client ID Metadata Document, how claude.ai identifies
  itself) is fetched by the Worker. It passes the same guard as `url` file entries first
  (https on 443, no loopback/private/link-local/metadata targets) and the Worker runs with
  `global_fetch_strictly_public`; the provider caps the document at 5 KB and 10 s and
  caches a validated one for at most 7 days, honouring its `Cache-Control`.
- Instance policy caps file size and can force passwords, expiry and `noindex`.
- Keys travel only as a bearer header or through the OAuth paste page — never in a URL.
- Reserved path prefixes (`/_api`, `/_oauth`, `/.well-known`, `/_connect`, `/_skill.md`)
  cannot be shadowed by a slug; generated slugs never start with `_` or `.`.
- Keys are stored hashed and never logged; the admin key is shown once at install. A key is
  32 random bytes stored as `sha256(key)` and compared in constant time. There is no slow
  KDF and no attempt rate limiting on keys: a 256-bit random key is not guessable, and the
  Free plan's CPU budget makes stretching every request expensive. A key that leaks is
  revoked, never recovered.
- Every refusal to authenticate is the same `401 UNAUTHENTICATED` with the same message. A
  caller is never told whether a key once existed, nor which of the two lookups failed.
- `user remove` deletes the `keyhash/` pointer first, so access ends on that write; the key
  record and the label claim follow, and every step tolerates a missing key so an
  interrupted removal is finished by a rerun.
- A `user` key reaches the five drop operations; the admin operations (`user`, `config`,
  `usage`, `prune`, `doctor`) answer `403 FORBIDDEN_SCOPE` to it. There is no per-drop
  ownership inside an instance: instance = team (see AGENTS.md, "Team model").
- `files: [{path, url}]` makes the Worker fetch a URL. Only `http`/`https` on ports 80/443;
  loopback, link-local, private, cloud-metadata and redirect-to-private targets are
  rejected; redirects are followed manually (≤ 3) and re-checked; ≤ 20 URL files and ≤ 45
  fetches including redirects per call;
  size and time limits apply; the Worker runs with `global_fetch_strictly_public`.
- The admin key is an ordinary key record in the bucket with label `admin`; there is no
  separate admin secret. `HMAC_SECRET` (cookie and upload signing) is the only Worker secret.

## Reporting a vulnerability

Open a private security advisory on this repository (GitHub → Security → Report a
vulnerability). Do not open a public issue. You will get an acknowledgement within a few
days; fixes ship as a new release with a note in the release manifest.
