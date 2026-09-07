import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { cleanEnv, oneJsonDocument, runCli } from "./cli-harness.js";

/**
 * `dropthis instance list` (issues #30, #31). The instances file is the only
 * place the keys live, so the one thing this command must never do is print
 * one: an operator asking "which instances do I have" gets names, URLs and
 * the four addresses of each instance.
 *
 * `default` is the instance a command with no `--instance` would use — the
 * env pair, else the file's `default`, else its only instance, else nothing —
 * so the answer matches what the next command actually does.
 *
 * The URLs come from `connectFor()` in the worker registry, never from a
 * second formula written here: one origin, one set of paths, everywhere.
 */
const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

type Row = {
  name: string;
  url: string;
  default: boolean;
  mcp_url: string;
  rest_url: string;
  skill_url: string;
  connect_page: string;
};
type Document = { default: string | null; instances: Row[] };

/** The four addresses `connectFor` derives from an origin. */
function urlsOf(origin: string): Omit<Row, "name" | "url" | "default"> {
  return {
    mcp_url: `${origin}/_api/mcp`,
    rest_url: `${origin}/_api/v1`,
    skill_url: `${origin}/_skill.md`,
    connect_page: `${origin}/_connect`,
  };
}

async function envWithFile(content: unknown): Promise<Record<string, string>> {
  const env = await cleanEnv();
  const file = join(env.XDG_CONFIG_HOME!, "dropthis", "instances.json");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(content));
  return env;
}

describe("dropthis instance list", () => {
  it("--json lists every instance sorted by name, with its URLs, the default marked and no key", async () => {
    const env = await envWithFile({
      default: "beta",
      instances: {
        beta: { url: "https://beta.example.workers.dev", key: KEY_B },
        alpha: { url: "https://alpha.example.workers.dev", key: KEY_A },
      },
    });

    const run = await runCli(["instance", "list", "--json"], { env });
    expect(run.code, run.stderr).toBe(0);
    expect(oneJsonDocument(run.stdout)).toEqual({
      default: "beta",
      instances: [
        {
          name: "alpha",
          url: "https://alpha.example.workers.dev",
          default: false,
          ...urlsOf("https://alpha.example.workers.dev"),
        },
        {
          name: "beta",
          url: "https://beta.example.workers.dev",
          default: true,
          ...urlsOf("https://beta.example.workers.dev"),
        },
      ],
    });
    expect(run.stdout).not.toContain(KEY_A);
    expect(run.stdout).not.toContain(KEY_B);
    expect(run.stderr).not.toContain(KEY_B);
  });

  it("a URL with a trailing slash gives the same addresses as one without", async () => {
    const env = await envWithFile({
      instances: { solo: { url: "https://solo.example.workers.dev/", key: KEY_A } },
    });
    const run = await runCli(["instance", "list", "--json"], { env });
    expect(run.code, run.stderr).toBe(0);
    const document = oneJsonDocument(run.stdout) as Document;
    expect(document.instances[0]).toMatchObject(urlsOf("https://solo.example.workers.dev"));
  });

  it("plain mode prints one row per instance and marks the default; no URLs, no key", async () => {
    const env = await envWithFile({
      default: "beta",
      instances: {
        beta: { url: "https://beta.example.workers.dev", key: KEY_B },
        alpha: { url: "https://alpha.example.workers.dev", key: KEY_A },
      },
    });

    const run = await runCli(["instance", "list"], { env });
    expect(run.code, run.stderr).toBe(0);
    const lines = run.stdout.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("alpha");
    expect(lines[0]).toContain("https://alpha.example.workers.dev");
    expect(lines[0]).not.toContain("(default)");
    expect(lines[1]).toContain("beta");
    expect(lines[1]).toContain("(default)");
    // Plain mode is unchanged by #31: the four addresses are `--json` only.
    expect(run.stdout).not.toContain("/_api/mcp");
    expect(run.stdout + run.stderr).not.toContain(KEY_A);
    expect(run.stdout + run.stderr).not.toContain(KEY_B);
  });

  it("an only instance is the default even when the file names none", async () => {
    const env = await envWithFile({ instances: { solo: { url: "https://solo.example.workers.dev", key: KEY_A } } });
    const run = await runCli(["instance", "list", "--json"], { env });
    expect(run.code, run.stderr).toBe(0);
    expect(oneJsonDocument(run.stdout)).toEqual({
      default: "solo",
      instances: [
        {
          name: "solo",
          url: "https://solo.example.workers.dev",
          default: true,
          ...urlsOf("https://solo.example.workers.dev"),
        },
      ],
    });
  });

  it("several instances and no default: nothing is marked", async () => {
    const env = await envWithFile({
      instances: {
        alpha: { url: "https://alpha.example.workers.dev", key: KEY_A },
        beta: { url: "https://beta.example.workers.dev", key: KEY_B },
      },
    });
    const run = await runCli(["instance", "list", "--json"], { env });
    const document = oneJsonDocument(run.stdout) as Document;
    expect(document.default).toBeNull();
    expect(document.instances.map((row) => row.default)).toEqual([false, false]);
  });

  it("no file at all: an empty list, exit 0, and plain mode names `dropthis init`", async () => {
    const env = await cleanEnv();

    const json = await runCli(["instance", "list", "--json"], { env });
    expect(json.code, json.stderr).toBe(0);
    expect(oneJsonDocument(json.stdout)).toEqual({ default: null, instances: [] });

    const plain = await runCli(["instance", "list"], { env });
    expect(plain.code, plain.stderr).toBe(0);
    expect(plain.stdout).toBe("");
    expect(plain.stderr).toContain("dropthis init");
  });

  it("an empty instances object is the same as no file", async () => {
    const env = await envWithFile({ instances: {} });
    const run = await runCli(["instance", "list", "--json"], { env });
    expect(run.code, run.stderr).toBe(0);
    expect(oneJsonDocument(run.stdout)).toEqual({ default: null, instances: [] });
  });

  it("the env pair with no file is one row named `env`, with its URLs, and it is the default", async () => {
    const base = await cleanEnv();
    const env = { ...base, DROPTHIS_URL: "https://env.example.workers.dev", DROPTHIS_KEY: KEY_A };

    const run = await runCli(["instance", "list", "--json"], { env });
    expect(run.code, run.stderr).toBe(0);
    expect(oneJsonDocument(run.stdout)).toEqual({
      default: "env",
      instances: [
        {
          name: "env",
          url: "https://env.example.workers.dev",
          default: true,
          ...urlsOf("https://env.example.workers.dev"),
        },
      ],
    });
    expect(run.stdout).not.toContain(KEY_A);
  });

  it("the env pair beside a file is listed too, and it is the default it would be", async () => {
    const base = await envWithFile({
      default: "alpha",
      instances: { alpha: { url: "https://alpha.example.workers.dev", key: KEY_A } },
    });
    const env = { ...base, DROPTHIS_URL: "https://env.example.workers.dev", DROPTHIS_KEY: KEY_B };

    const run = await runCli(["instance", "list", "--json"], { env });
    expect(run.code, run.stderr).toBe(0);
    const document = oneJsonDocument(run.stdout) as Document;
    expect(document.default).toBe("env");
    expect(document.instances.map((row) => row.name)).toEqual(["alpha", "env"]);
  });

  /**
   * A PARTIAL env pair (issue #32). Every bare command refuses it before it
   * looks at the file, so a listing must refuse it too: marking the file's
   * default here would name an instance the next command will not use. One
   * rule, both halves, both modes.
   */
  it("half an env pair is the same error every other command gives: exit 1, empty stdout", async () => {
    const base = await envWithFile({
      default: "alpha",
      instances: { alpha: { url: "https://alpha.example.workers.dev", key: KEY_A } },
    });

    for (const [half, missing] of [
      [{ DROPTHIS_URL: "https://env.example.workers.dev" }, "DROPTHIS_KEY"],
      [{ DROPTHIS_KEY: KEY_B }, "DROPTHIS_URL"],
    ] as const) {
      const env = { ...base, ...half };

      const json = await runCli(["instance", "list", "--json"], { env });
      expect(json.code, json.stderr).toBe(1);
      expect(json.stdout).toBe("");
      const error = oneJsonDocument(json.stderr) as { code: string; message: string };
      expect(error.code).toBe("INVALID_INPUT");
      expect(error.message).toContain(missing);

      const plain = await runCli(["instance", "list"], { env });
      expect(plain.code).toBe(1);
      expect(plain.stdout).toBe("");
      expect(plain.stderr).toContain(missing);
      expect(plain.stdout + plain.stderr).not.toContain(KEY_B);
    }
  });

  it("is listed by `dropthis commands`", async () => {
    const env = await cleanEnv();
    const run = await runCli(["commands", "--json"], { env });
    expect(run.code, run.stderr).toBe(0);
    const surface = oneJsonDocument(run.stdout) as Array<Record<string, unknown>>;
    const row = surface.find((entry) => entry.command === "instance list");
    expect(row).toBeDefined();
    expect(row!.operation).toBeNull();
    expect(row!.scope).toBe("local");
    expect(row!.arguments).toEqual([]);

    const plain = await runCli(["commands"], { env });
    expect(plain.stdout).toContain("instance list");
  });

  it("`dropthis instances` is gone: an unknown command, exit 1", async () => {
    const env = await envWithFile({ instances: { solo: { url: "https://solo.example.workers.dev", key: KEY_A } } });
    const run = await runCli(["instances", "--json"], { env });
    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("instances");

    const listed = await runCli(["commands", "--json"], { env });
    const surface = oneJsonDocument(listed.stdout) as Array<Record<string, unknown>>;
    expect(surface.some((entry) => entry.command === "instances")).toBe(false);
  });
});

/**
 * `connect` with no `--client` (issue #31): an operator who has not chosen a
 * client still wants the four addresses of the instance. It answers from the
 * same `connectFor()` object the per-client snippets are built from, applies
 * nothing, and writes no file.
 */
describe("dropthis connect with no --client", () => {
  it("plain prints the four labelled URLs and the key env var, and writes no .mcp.json", async () => {
    const env = await envWithFile({
      instances: { main: { url: "https://main.example.workers.dev", key: KEY_A } },
    });
    const cwd = env.HOME!;

    const run = await runCli(["connect", "--instance", "main"], { env, cwd });
    expect(run.code, run.stderr).toBe(0);
    const lines = run.stdout.split("\n").filter((line) => line.length > 0);
    expect(lines).toEqual([
      "MCP           https://main.example.workers.dev/_api/mcp",
      "REST          https://main.example.workers.dev/_api/v1",
      "Skill         https://main.example.workers.dev/_skill.md",
      "Connect page  https://main.example.workers.dev/_connect",
      "Key env var: DROPTHIS_KEY_MAIN",
    ]);
    expect(run.stdout).not.toContain(KEY_A);

    // Nothing was applied: no MCP config was written into the working dir.
    await expect(readFile(join(cwd, ".mcp.json"), "utf8")).rejects.toThrow();
  });

  it("--json is the connect object with the URLs, the env var and the client snippets", async () => {
    const env = await envWithFile({
      instances: { main: { url: "https://main.example.workers.dev", key: KEY_A } },
    });

    const run = await runCli(["connect", "--instance", "main", "--json"], { env });
    expect(run.code, run.stderr).toBe(0);
    const document = oneJsonDocument(run.stdout) as Record<string, unknown>;
    expect(document).toMatchObject({
      instance: "main",
      ...urlsOf("https://main.example.workers.dev"),
      key_env_var: "DROPTHIS_KEY_MAIN",
    });
    expect(Object.keys(document.clients as Record<string, unknown>).sort()).toEqual([
      "claude_ai",
      "claude_code",
      "codex",
      "cursor",
    ]);
    expect(run.stdout).not.toContain(KEY_A);
  });

  it("still works with `--client`, and that path is unchanged", async () => {
    const env = await envWithFile({
      instances: { main: { url: "https://main.example.workers.dev", key: KEY_A } },
    });

    const run = await runCli(["connect", "--instance", "main", "--client", "claude-ai", "--json"], { env });
    expect(run.code, run.stderr).toBe(0);
    const document = oneJsonDocument(run.stdout) as Record<string, unknown>;
    expect(document.client).toBe("claude-ai");
    expect(document.connector_url).toBe("https://main.example.workers.dev/_api/mcp");
    expect(run.stdout).not.toContain(KEY_A);
  });
});
