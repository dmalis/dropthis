# Security and abuse boundary

## What dropthis does not do

dropthis serves uploaded HTML as active content. It does not sandbox that content or make it
safe. Anyone with a key can publish JavaScript that runs in visitors' browsers on the drop's
origin. Serve drops from a dedicated domain, never from a subdomain of a site whose cookies
matter: cookies scope to parent domains, so a drop at `drops.example.com` could read and set
cookies for `example.com`. A shared hostname's path-scoped unlock cookies are a convenience,
not a security boundary between drops.

## Operator controls

- Any key can be revoked and any drop deleted immediately (`user_remove`, `delete`).
- Per-key rate limits bound abuse; instance policy caps file size and can force passwords,
  expiry and `noindex`.
- Reserved slugs block login, account, administration and brand impersonation paths.
- Keys are stored hashed and never logged; the admin key is shown once at install.
- If a URL fetcher is ever added it rejects loopback, link-local, private, cloud-metadata and
  redirect-to-private targets and non-HTTP schemes.

## Reporting a vulnerability

Open a private security advisory on this repository (GitHub → Security → Report a
vulnerability). Do not open a public issue. You will get an acknowledgement within a few
days; fixes ship as a new release with a note in the release manifest.
