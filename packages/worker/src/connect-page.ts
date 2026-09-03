/**
 * `/_connect` — the one page a colleague opens (issue #21).
 *
 * `user add` returns a key plus a ready-to-send message, and that message
 * links here. The page is built from the SAME `connectFor()` payload the
 * agent gets, so the human instructions and the machine object cannot drift.
 *
 * Three rules it never breaks: it holds no key (a link gets forwarded, and
 * the key travels in its own message), it needs no script (a config snippet
 * has to be readable in any browser and in a text-mode one), and it names the
 * canonical origin only — a request on an alias is moved there first.
 */
import { escapeHtml } from "./viewer/html.js";
import type { ClientSnippet, Connect } from "./registry/connect.js";

export function renderConnectPage(connect: Connect): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <title>Connect to dropthis</title>
    <style>
      body { font: 16px/1.6 system-ui, sans-serif; margin: 0 auto; padding: 2rem 1rem;
             max-width: 46rem; }
      h1 { font-size: 1.5rem; }
      h2 { font-size: 1.15rem; margin-top: 2.5rem; }
      code { font-family: ui-monospace, monospace; }
      pre { background: #f4f4f5; padding: 0.75rem; overflow-x: auto; border-radius: 4px; }
      dt { font-weight: 600; margin-top: 0.75rem; }
      dd { margin: 0; }
      .note { border-left: 3px solid #999; padding-left: 0.75rem; color: #444; }
    </style>
  </head>
  <body>
    <main>
      <h1>Connect to dropthis</h1>
      <p>
        This is the <strong>${escapeHtml(connect.instance)}</strong> dropthis instance.
        Publishing a file to it gives you a permanent URL.
      </p>
      <p class="note">
        Your key arrives in a separate message. This page never holds one, and no
        snippet below contains one — snippets get committed, keys must not be.
      </p>

      <h2>Addresses</h2>
      <dl>
        <dt>Connector (MCP) URL</dt>
        <dd><code>${escapeHtml(connect.mcp_url)}</code></dd>
        <dt>REST base</dt>
        <dd><code>${escapeHtml(connect.rest_url)}</code></dd>
        <dt>Agent skill (what an agent should read)</dt>
        <dd><a href="${escapeHtml(connect.skill_url)}">${escapeHtml(connect.skill_url)}</a></dd>
        <dt>Your key, in a variable</dt>
        <dd><code>${escapeHtml(connect.key_env_var)}</code></dd>
      </dl>

      <h2>Claude Code</h2>
      <p>One command, if you have the dropthis CLI:</p>
      ${block(String(connect.clients.claude_code.command ?? ""))}
      <p>
        Or add this to <code>.mcp.json</code>. The <code>headersHelper</code> reads your key
        from the CLI at call time, so the file itself stays safe to commit.
      </p>
      ${block(json(connect.clients.claude_code.mcp_json))}

      <h2>Cursor</h2>
      ${block(String(connect.clients.cursor.command ?? ""))}
      <p>Or set the key in your shell profile and add the server by hand:</p>
      ${block(String(connect.clients.cursor.shell_profile_line ?? ""))}
      ${block(json(connect.clients.cursor.mcp_json))}

      <h2>Codex</h2>
      ${block(String(connect.clients.codex.command ?? ""))}
      <p>Or, in <code>~/.codex/config.toml</code>, with the same shell variable:</p>
      ${block(String(connect.clients.codex.shell_profile_line ?? ""))}
      ${block(String(connect.clients.codex.config_toml ?? ""))}

      <h2>claude.ai and the Claude desktop app</h2>
      <p>These cannot send a header, so you paste your key once on the login page:</p>
      <ol>
${steps(connect.clients.claude_ai)}
      </ol>
      <p class="note">${escapeHtml(String(connect.clients.claude_ai.note ?? ""))}</p>
    </main>
  </body>
</html>
`;
}

function block(text: string): string {
  return `<pre><code>${escapeHtml(text)}</code></pre>`;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function steps(client: ClientSnippet): string {
  const list = Array.isArray(client.steps) ? (client.steps as unknown[]) : [];
  return list.map((step) => `        <li>${escapeHtml(String(step))}</li>`).join("\n");
}
