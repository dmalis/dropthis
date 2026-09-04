/**
 * "A newer Worker serves an older drop unchanged" (AGENTS.md, "Data
 * durability"), at the seam that matters: a stored `meta.json` that is not
 * today's shape, read through every path an agent and a visitor use.
 *
 * The fixture is a lean record — no `noindex`, no `access`, no `created_by`,
 * no `content_type` on the manifest entry — plus a field this Worker has never
 * heard of. Nothing here may 500, and the unknown field must still be there
 * after an update rewrites the record.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Drop } from "../src/domain/meta.js";
import { blobKey, listKeyForDrop, metaKey, slugKey } from "../src/storage/keys.js";
import { harness, USER_KEY } from "./app-harness.js";
import type { Harness } from "./app-harness.js";

let h: Harness;

const ID = "01OLDDROP0000000000000000";
const SLUG = "oldschema1";
const BODY = "<h1>from an older Worker</h1>";
// sha256 of BODY, computed by the test so the fixture is self-consistent.
let digest: string;

beforeEach(async () => {
  h = await harness();
  digest = await sha256(BODY);
  h.bucket.seed(blobKey(ID, digest), BODY);
  h.bucket.seed(slugKey(SLUG), ID);
  h.bucket.seed(
    metaKey(ID),
    JSON.stringify({
      schema: 1,
      id: ID,
      slug: SLUG,
      title: "Old",
      meta: {},
      current_gen: "gen",
      manifest: { "index.html": { sha256: digest, size: BODY.length } },
      created: "2026-01-01T00:00:00Z",
      tenant: "acme",
    }),
  );
});

async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const out = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(out)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("a meta.json from an older Worker", () => {
  it("is served by the viewer", async () => {
    const response = await h.call(`/${SLUG}/`, {}, null);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(BODY);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  it("reads back through get with the documented defaults", async () => {
    const drop = await h.body<Drop>(await h.call(`/_api/v1/drops/${SLUG}`, {}, USER_KEY));
    expect(drop.title).toBe("Old");
    expect(drop.noindex).toBe(true);
    expect(drop.has_password).toBe(false);
    expect(drop.expires_at).toBeNull();
    expect(drop.created_by).toEqual({ id: "", label: "" });
    expect(drop.files).toEqual([
      { path: "index.html", size: BODY.length, sha256: digest, content_type: "text/html" },
    ]);
  });

  it("appears in list, once get has repaired its projection", async () => {
    await h.call(`/_api/v1/drops/${SLUG}`, {}, USER_KEY);
    expect(h.bucket.keys("list/")).toContain(listKeyForDrop(ID, SLUG));

    const page = await h.body<{ drops: Drop[] }>(await h.call("/_api/v1/drops", {}, USER_KEY));
    expect(page.drops.map((d) => d.slug)).toContain(SLUG);
  });

  it("keeps the field this Worker does not know when an update rewrites it", async () => {
    const response = await h.json(
      `/_api/v1/drops/${SLUG}`,
      "PATCH",
      { title: "New" },
      { key: USER_KEY },
    );
    expect(response.status).toBe(200);

    const stored = JSON.parse(h.bucket.read(metaKey(ID))!) as Record<string, unknown>;
    expect(stored.title).toBe("New");
    expect(stored.tenant).toBe("acme");
  });
});
