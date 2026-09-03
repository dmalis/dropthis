/**
 * The one page a human ever sees that dropthis designed: type the password.
 *
 * It is deliberately a single self-contained document with no asset, no
 * script and no branding — it has to render before the drop is unlocked, so
 * anything it loaded would be a second request the viewer has to answer while
 * still refusing to serve the drop.
 *
 * It shows the drop's title and nothing else about the drop: a locked drop's
 * file list is part of what the password protects.
 */

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type UnlockPageOptions = {
  /** Shown as the heading; the drop's own title, or its slug. */
  title: string;
  /** True after a wrong password, so the visitor is told rather than looped. */
  failed: boolean;
};

export function unlockPage(options: UnlockPageOptions): string {
  const error = options.failed
    ? '\n      <p class="error" role="alert">That password did not open this drop.</p>'
    : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(options.title)}</title>
    <style>
      body { font: 16px/1.5 system-ui, sans-serif; margin: 0; display: grid;
             place-items: center; min-height: 100vh; }
      main { width: min(22rem, 90vw); }
      h1 { font-size: 1.25rem; }
      input, button { font: inherit; width: 100%; box-sizing: border-box;
                      padding: 0.5rem; margin-top: 0.5rem; }
      .error { color: #b00020; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(options.title)}</h1>
      <p>This drop is password protected.</p>${error}
      <form method="post">
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password"
               autofocus required />
        <button type="submit">Unlock</button>
      </form>
    </main>
  </body>
</html>
`;
}
