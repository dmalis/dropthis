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
  nonce that rotates on every password change — changing the password logs everyone out.
- **v1 has no attempt rate limiting** (the design stores no counters). A chosen password
  can be guessed by a patient attacker; a drop that must not be guessed uses a generated
  one. Rate limiting arrives when a real deployment needs it.
- A generated slug (10 characters, `a-z0-9`) with `noindex` is a share link, not a secret:
  anyone with the URL can open an unprotected drop.

## Operator controls

- Any key can be revoked and any drop deleted immediately (`user remove`, `delete`).
  Revoking a key ends every OAuth session behind it.
- Instance policy caps file size and can force passwords, expiry and `noindex`.
- Keys travel only as a bearer header or through the OAuth paste page — never in a URL.
- Reserved path prefixes (`/_api`, `/_oauth`, `/_connect`, `/_skill.md`) cannot be shadowed
  by a slug; generated slugs never start with `_`.
- Keys are stored hashed and never logged; the admin key is shown once at install.
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
