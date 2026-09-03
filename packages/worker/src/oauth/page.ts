/**
 * The one page dropthis renders for a human: paste your key (AGENTS.md,
 * "Auth"). One form, one password field, one button. No account, no consent
 * checkboxes, no external resource — the page must work inside a connector's
 * popup with nothing else loaded.
 *
 * The form posts back to the SAME URL it was served from, query string and
 * all, so the OAuth request is re-parsed and re-validated by the provider on
 * submit; nothing about the client or its redirect is trusted from a hidden
 * field. `error` re-renders the form after a wrong key.
 */

const escapeHtml = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

export type AuthorizePageInput = {
  /** The host the human is connecting to, shown so they know which key to paste. */
  host: string;
  /** Path + query the form posts back to. */
  action: string;
  error?: string | undefined;
};

export function authorizePage({ host, action, error }: AuthorizePageInput): string {
  const errorLine =
    error === undefined ? "" : `<p role="alert" class="err">${escapeHtml(error)}</p>\n`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Connect dropthis</title>
<style>
:root { color-scheme: light dark; }
body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
  font:16px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  background:#f6f7f9; color:#16181d; }
main { width:100%; max-width:26rem; margin:2rem; padding:2rem; background:#fff;
  border:1px solid #e2e5ea; border-radius:12px; }
h1 { margin:0 0 .25rem; font-size:1.25rem; }
p.sub { margin:0 0 1.25rem; color:#5b6270; font-size:.9rem; }
label { display:block; margin-bottom:.4rem; font-size:.85rem; font-weight:600; }
input { width:100%; box-sizing:border-box; padding:.65rem .75rem; font:inherit;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.9rem;
  border:1px solid #c9cdd6; border-radius:8px; background:#fff; color:inherit; }
button { margin-top:1rem; width:100%; padding:.7rem 1rem; font:inherit; font-weight:600;
  color:#fff; background:#1a1d23; border:0; border-radius:8px; cursor:pointer; }
.err { margin:0 0 1rem; padding:.6rem .75rem; border-radius:8px;
  background:#fdecec; border:1px solid #f3b7b7; color:#8a1f1f; font-size:.9rem; }
@media (prefers-color-scheme: dark) {
  body { background:#0e1014; color:#e8eaee; }
  main { background:#171a20; border-color:#2a2f38; }
  p.sub { color:#9aa2b1; }
  input { background:#0e1014; border-color:#39404c; }
  button { background:#e8eaee; color:#0e1014; }
  .err { background:#3a1c1c; border-color:#6b2b2b; color:#ffb4b4; }
}
</style>
</head>
<body>
<main>
<h1>Connect dropthis</h1>
<p class="sub">Paste your dropthis key for <strong>${escapeHtml(host)}</strong> to finish connecting.</p>
${errorLine}<form method="POST" action="${escapeHtml(action)}">
<label for="key">Your dropthis key</label>
<input type="password" id="key" name="key" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" required>
<button type="submit">Connect</button>
</form>
</main>
</body>
</html>
`;
}
