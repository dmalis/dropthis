import { describe, expect, it } from "vitest";
import { connectFor, keyEnvVar, onboardingMessage } from "../src/registry/connect.js";

/**
 * `user add` returns one key and everything needed to hand it to a person
 * (docs/spec-v1.md, story 50). The snippets must NOT contain the key: an agent
 * pastes them into a config file that gets committed, and a key in a repo is a
 * key on the internet.
 */
const CONNECT = connectFor({
  canonicalUrl: "https://drops.example.com",
  instanceName: "acme",
});

describe("keyEnvVar", () => {
  it("names the variable after the instance, upper case", () => {
    expect(keyEnvVar("acme")).toBe("DROPTHIS_KEY_ACME");
  });

  it("turns a dash into an underscore, so the name is a legal shell variable", () => {
    expect(keyEnvVar("client-x")).toBe("DROPTHIS_KEY_CLIENT_X");
  });
});

describe("connectFor", () => {
  it("gives the two URLs an agent connects to", () => {
    expect(CONNECT.mcp_url).toBe("https://drops.example.com/_api/mcp");
    expect(CONNECT.rest_url).toBe("https://drops.example.com/_api/v1");
    expect(CONNECT.skill_url).toBe("https://drops.example.com/_skill.md");
  });

  it("covers exactly the four clients", () => {
    expect(Object.keys(CONNECT.clients)).toEqual([
      "claude_code",
      "cursor",
      "codex",
      "claude_ai",
    ]);
  });

  it("sends Claude Code through the CLI's header helper, so no key is stored", () => {
    const snippet = JSON.stringify(CONNECT.clients.claude_code);
    expect(snippet).toContain("dropthis connect");
    expect(snippet).toContain("--instance acme");
  });

  it("references the env var for Cursor and Codex, never the key", () => {
    for (const client of [CONNECT.clients.cursor, CONNECT.clients.codex]) {
      expect(JSON.stringify(client)).toContain("DROPTHIS_KEY_ACME");
    }
  });

  it("gives claude.ai the connector URL and the paste-key step", () => {
    const snippet = JSON.stringify(CONNECT.clients.claude_ai);
    expect(snippet).toContain("https://drops.example.com/_api/mcp");
    expect(snippet.toLowerCase()).toContain("paste");
  });

  it("names no key anywhere in the whole object", () => {
    expect(JSON.stringify(CONNECT)).not.toMatch(/[0-9a-f]{64}/);
  });
});

describe("onboardingMessage", () => {
  const message = onboardingMessage(CONNECT, "anna");

  it("is a ready-to-send text naming the person and the instance URL", () => {
    expect(message).toContain("anna");
    expect(message).toContain("https://drops.example.com/_api/mcp");
  });

  it("warns that on claude.ai Team or Enterprise only an Owner can add a connector", () => {
    expect(message).toContain("Owner");
    expect(message).toMatch(/Team|Enterprise/);
  });

  it("tells the person where the key itself will come from, without holding one", () => {
    expect(message).not.toMatch(/[0-9a-f]{64}/);
  });
});
