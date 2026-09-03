import { describe, expect, it } from "vitest";
import { PRODUCTION_HOOKS } from "../src/dev/hooks.js";
import { isSlug } from "../src/domain/slug.js";
import { parsePublishInput } from "../src/registry/publish.js";
import { createApp } from "../src/index.js";
import { RESERVED_PREFIXES } from "../src/reserved.js";
import { CONFIG_KEY, metaKey, slugKey } from "../src/storage/keys.js";
import { memoryBucket } from "./memory-bucket.js";

/**
 * A slug can never shadow the control plane (AGENTS.md, "Reserved paths").
 * Three lines of defence, all pinned here: the slug alphabet cannot spell a
 * reserved prefix, a slug the CALLER chose is refused before it is ever
 * claimed (issue #18), and even a pointer planted by hand under one is never
 * looked up — the router answers the control plane's own 404 first.
 */
const ORIGIN = "https://drops.example.test";

describe("reserved prefixes", () => {
  it.each(RESERVED_PREFIXES)("%s cannot be spelled by a slug", (prefix) => {
    expect(isSlug(prefix.slice(1))).toBe(false);
  });

  it.each(RESERVED_PREFIXES)("%s cannot be chosen as a slug on publish", (prefix) => {
    expect(() =>
      parsePublishInput({
        files: [{ path: "index.html", text: "<h1>hi</h1>" }],
        slug: prefix.slice(1),
      }),
    ).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it.each(RESERVED_PREFIXES)("%s/… answers the control plane, never a planted drop", async (prefix) => {
    const bucket = memoryBucket();
    bucket.seed(CONFIG_KEY, JSON.stringify({ canonical_url: ORIGIN }));
    const planted = prefix.slice(1);
    bucket.seed(slugKey(planted), JSON.stringify({ id: "planted" }));
    bucket.seed(metaKey("planted"), JSON.stringify({ schema: 1, id: "planted", slug: planted }));
    const app = createApp(PRODUCTION_HOOKS);
    const env = { BUCKET: bucket, OAUTH_KV: {} as never, HMAC_SECRET: "s".repeat(32) };

    const response = await app.fetch(new Request(`${ORIGIN}${prefix}/nope`), env);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(bucket.log).not.toContain(`get ${slugKey(planted)}`);
    expect(bucket.log).not.toContain(`get ${metaKey("planted")}`);
  });
});
