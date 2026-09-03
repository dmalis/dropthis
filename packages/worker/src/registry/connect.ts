/**
 * "How this person connects", built by the instance that knows its own URL
 * (docs/spec-v1.md, story 50; AGENTS.md, "CLI conventions").
 *
 * `user add` returns a key once. On its own a key is not onboarding: the
 * operator's agent still has to know which of four clients the person uses and
 * what to paste where. So the instance answers that too, in one structured
 * object plus one message the operator can forward as it stands.
 *
 * The key is NEVER in a snippet. Snippets reference `DROPTHIS_KEY_<INSTANCE>`
 * or the CLI's own header helper, because a snippet is pasted into a config
 * file and config files get committed.
 */

export type ClientSnippet = Record<string, unknown>;

export type Connect = {
  instance: string;
  mcp_url: string;
  rest_url: string;
  skill_url: string;
  connect_page: string;
  key_env_var: string;
  clients: {
    claude_code: ClientSnippet;
    cursor: ClientSnippet;
    codex: ClientSnippet;
    claude_ai: ClientSnippet;
  };
};

export type ConnectInput = {
  canonicalUrl: string;
  instanceName: string;
};

/**
 * The environment variable holding this instance's key. One variable per
 * instance, so an operator hosting several clients can keep them all in one
 * shell profile without them fighting over `DROPTHIS_KEY`.
 */
export function keyEnvVar(instanceName: string): string {
  return `DROPTHIS_KEY_${instanceName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

export function connectFor(input: ConnectInput): Connect {
  const origin = input.canonicalUrl.replace(/\/+$/, "");
  const mcpUrl = `${origin}/_api/mcp`;
  const envVar = keyEnvVar(input.instanceName);
  const instanceFlag = `--instance ${input.instanceName}`;

  return {
    instance: input.instanceName,
    mcp_url: mcpUrl,
    rest_url: `${origin}/_api/v1`,
    skill_url: `${origin}/_skill.md`,
    connect_page: `${origin}/_connect`,
    key_env_var: envVar,
    clients: {
      // Claude Code reads the key through the CLI at call time, so the key is
      // in neither argv nor any file the project commits.
      claude_code: {
        command: `dropthis connect ${instanceFlag} --client claude-code`,
        mcp_json: {
          mcpServers: {
            dropthis: {
              type: "http",
              url: mcpUrl,
              headersHelper: `dropthis auth-header ${instanceFlag}`,
            },
          },
        },
      },
      cursor: {
        command: `dropthis connect ${instanceFlag} --client cursor`,
        shell_profile_line: `export ${envVar}=<the key you were sent>`,
        mcp_json: {
          mcpServers: {
            dropthis: {
              url: mcpUrl,
              headers: { Authorization: `Bearer \${${envVar}}` },
            },
          },
        },
      },
      codex: {
        command: `dropthis connect ${instanceFlag} --client codex`,
        shell_profile_line: `export ${envVar}=<the key you were sent>`,
        config_toml: [
          "[mcp_servers.dropthis]",
          `url = "${mcpUrl}"`,
          `http_headers = { Authorization = "Bearer \${${envVar}}" }`,
        ].join("\n"),
      },
      // The browser clients cannot send a header, so they log in through the
      // one OAuth page and paste the key there (AGENTS.md, "Auth").
      claude_ai: {
        connector_url: mcpUrl,
        steps: [
          "Open Settings → Connectors → Add custom connector.",
          `Paste ${mcpUrl} as the connector URL.`,
          "Click Connect, then paste your dropthis key on the page that opens.",
        ],
        note: "On a Team or Enterprise plan only an Owner can add a custom connector; members then log in with their own key.",
      },
    },
  };
}

/**
 * The message the operator forwards. It is written for a person, not an agent:
 * the agent already has the structured object above.
 */
export function onboardingMessage(connect: Connect, label: string): string {
  return [
    `Hi ${label} — you have access to our dropthis instance.`,
    "",
    `Connector URL: ${connect.mcp_url}`,
    `How to connect (any client): ${connect.connect_page}`,
    "",
    "Your key is in the separate message alongside this one. Paste it when the",
    "connector asks you to log in, or set it as an environment variable if your",
    "client sends headers.",
    "",
    "On claude.ai, a Team or Enterprise plan lets only an Owner add a custom",
    "connector; once it is added, you log in with your own key.",
  ].join("\n");
}
