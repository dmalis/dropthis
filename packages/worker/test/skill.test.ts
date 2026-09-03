import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/bindings.js";
import { createApp } from "../src/index.js";
import { MAX_FILES_PER_CALL } from "../src/registry/fields.js";
import { TOOL_TEXT } from "../src/registry/tools.js";
import { INITIAL_POLICY } from "../src/policy/defaults.js";
import { CONFIG_KEY } from "../src/storage/keys.js";
import { memoryBucket } from "./memory-bucket.js";
import type { MemoryBucket } from "./memory-bucket.js";

/**
 * `/_skill.md` is how one URL onboards any agent (docs/spec-v1.md, story 77):
 * the instance's own skill with ITS base URL and ITS live limits filled in,
 * and the tool vocabulary rendered from the same text the MCP tool list
 * carries, so the two cannot drift.
 */
const ORIGIN = "https://drops.test";

let bucket: MemoryBucket;
let env: Env;

beforeEach(() => {
  bucket = memoryBucket();
  bucket.seed(CONFIG_KEY, JSON.stringify({ ...INITIAL_POLICY, canonical_url: ORIGIN }));
  env = { BUCKET: bucket, OAUTH_KV: {}, HMAC_SECRET: "s".repeat(32) };
});

const skill = () => createApp().fetch(new Request(`${ORIGIN}/_skill.md`), env);

describe("GET /_skill.md", () => {
  it("is open, markdown, noindex", async () => {
    const response = await skill();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("substitutes the instance's base URL and its live limits", async () => {
    const text = await (await skill()).text();
    expect(text).toContain(`# dropthis at ${ORIGIN}`);
    expect(text).toContain(`${ORIGIN}/_api/mcp`);
    expect(text).toContain(`${ORIGIN}/_api/v1`);
    expect(text).toContain(`${INITIAL_POLICY.max_request_bytes} bytes`);
    expect(text).toContain("(4 MiB)");
    expect(text).toContain(`at most ${MAX_FILES_PER_CALL} files`);
    expect(text).toContain(`default is **${INITIAL_POLICY.expiry.default}**`);
    expect(text).toContain(`maximum **${INITIAL_POLICY.expiry.max}**`);
    expect(text).toContain('`"never"` is **allowed**');
    expect(text).not.toMatch(/\{\{|\}\}/);
  });

  it("follows the policy, not the source: a changed limit is the served limit", async () => {
    bucket.seed(
      CONFIG_KEY,
      JSON.stringify({
        ...INITIAL_POLICY,
        max_request_bytes: 1024 * 1024,
        expiry: { default: "7d", max: "30d", allow_never: false },
        canonical_url: ORIGIN,
      }),
    );
    const text = await (await skill()).text();
    expect(text).toContain("1048576 bytes (1 MiB)");
    expect(text).toContain("default is **7d**");
    expect(text).toContain('`"never"` is **refused**');
  });

  it("renders every tool from the pinned tool text, user tools first", async () => {
    const text = await (await skill()).text();
    for (const [name, entry] of Object.entries(TOOL_TEXT)) {
      const tool = `dropthis_${name.replace(/\./g, "_")}`;
      expect(text, tool).toContain(`### \`${tool}\``);
      expect(text, tool).toContain(`Use when the user says: ${entry.triggers}.`);
    }
    expect(text.indexOf("### `dropthis_delete`")).toBeLessThan(text.indexOf("### `dropthis_user_add`"));
    expect(text).toContain("never publish again");
  });

  it("uses the canonical origin, not the host the request arrived on", async () => {
    const response = await createApp().fetch(new Request("https://alias.test/_skill.md"), env);
    const text = await response.text();
    expect(text).toContain(`# dropthis at ${ORIGIN}`);
    expect(text).not.toContain("alias.test");
  });
});
