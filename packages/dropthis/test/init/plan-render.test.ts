import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderWranglerConfig, writeWranglerConfig } from "../../src/init/plan-render.js";

describe("renderWranglerConfig", () => {
  it("renders the worker name, main entry, bucket and KV id from the repo template", async () => {
    const rendered = await renderWranglerConfig("x", "dropthis-x-drops", "kv-id-123");

    expect(rendered.name).toBe("dropthis-x");
    expect(rendered.main).toMatch(/packages\/worker\/src\/index\.ts$/);
    expect(rendered.r2_buckets).toEqual([{ binding: "BUCKET", bucket_name: "dropthis-x-drops" }]);
    expect(rendered.kv_namespaces).toEqual([{ binding: "OAUTH_KV", id: "kv-id-123" }]);
    expect(rendered.$schema).toBeUndefined();
  });

  it("renders identically for the same inputs (deterministic, no ids invented)", async () => {
    const first = await renderWranglerConfig("main", "dropthis-main-drops", "kv-id-abc");
    const second = await renderWranglerConfig("main", "dropthis-main-drops", "kv-id-abc");

    expect(first).toEqual(second);
  });
});

describe("writeWranglerConfig", () => {
  it("writes comment-free JSON that reparses to the same object", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dropthis-plan-render-"));
    const out = join(dir, "wrangler.dev.jsonc");
    const rendered = await renderWranglerConfig("x", "dropthis-x-drops", "kv-id-123");

    await writeWranglerConfig(out, rendered);

    const written = JSON.parse(await readFile(out, "utf8"));
    expect(written).toEqual(rendered);
  });
});
