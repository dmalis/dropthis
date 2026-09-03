import { describe, expect, it } from "vitest";
import { resolveInlineFiles } from "../src/operations/resolve-content.js";
import { sha256Hex } from "../src/domain/meta.js";

const codeOf = async (call: () => Promise<unknown>) => {
  try {
    await call();
    return "no error";
  } catch (error) {
    return (error as { code?: string }).code ?? "not an ApiError";
  }
};

describe("resolveInlineFiles", () => {
  it("hashes a text entry and types it from the extension", async () => {
    const resolved = await resolveInlineFiles([{ path: "index.html", text: "<h1>hi</h1>" }]);
    expect(resolved.files).toHaveLength(1);
    expect(resolved.files[0]!.contentType).toBe("text/html");
    expect(resolved.files[0]!.sha256).toBe(await sha256Hex("<h1>hi</h1>"));
    expect(resolved.manifest).toEqual({
      "index.html": {
        sha256: await sha256Hex("<h1>hi</h1>"),
        size: 11,
        content_type: "text/html",
      },
    });
  });

  it("measures size in bytes, not characters", async () => {
    const resolved = await resolveInlineFiles([{ path: "a.txt", text: "héllo" }]);
    expect(resolved.manifest["a.txt"]!.size).toBe(6);
  });

  it("decodes a base64 entry to its bytes", async () => {
    const png = "iVBORw0KGgo=";
    const resolved = await resolveInlineFiles([{ path: "shot.png", base64: png }]);
    expect(resolved.files[0]!.contentType).toBe("image/png");
    expect([...resolved.files[0]!.bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(resolved.manifest["shot.png"]!.size).toBe(8);
  });

  it("keeps the caller's order, which is the order get(files:true) spends its budget in", async () => {
    const resolved = await resolveInlineFiles([
      { path: "z.txt", text: "z" },
      { path: "a.txt", text: "a" },
    ]);
    expect(Object.keys(resolved.manifest)).toEqual(["z.txt", "a.txt"]);
  });

  it("writes one blob per distinct digest even when two paths share content", async () => {
    const resolved = await resolveInlineFiles([
      { path: "a.txt", text: "same" },
      { path: "b.txt", text: "same" },
    ]);
    expect(resolved.files).toHaveLength(2);
    expect(resolved.blobs.size).toBe(1);
  });

  it("normalises the path into the manifest", async () => {
    const resolved = await resolveInlineFiles([
      { path: `cafe${String.fromCharCode(0x301)}.txt`, text: "x" },
    ]);
    expect(Object.keys(resolved.manifest)).toEqual(["café.txt"]);
  });

  it("rejects a bad path as INVALID_PATH", async () => {
    expect(await codeOf(() => resolveInlineFiles([{ path: "../a.txt", text: "x" }]))).toBe(
      "INVALID_PATH",
    );
  });

  it("rejects duplicate paths as INVALID_PATH", async () => {
    expect(
      await codeOf(() =>
        resolveInlineFiles([
          { path: "a.txt", text: "x" },
          { path: "a.txt", text: "y" },
        ]),
      ),
    ).toBe("INVALID_PATH");
  });

  it("rejects a text entry whose extension names a binary type", async () => {
    expect(await codeOf(() => resolveInlineFiles([{ path: "shot.png", text: "x" }]))).toBe(
      "INVALID_INPUT",
    );
  });

  it("rejects base64 that is not base64", async () => {
    expect(await codeOf(() => resolveInlineFiles([{ path: "a.bin", base64: "!!!!" }]))).toBe(
      "INVALID_INPUT",
    );
  });

  it("types an unknown extension as an octet stream", async () => {
    const resolved = await resolveInlineFiles([{ path: "archive.bin", base64: "AAAA" }]);
    expect(resolved.files[0]!.contentType).toBe("application/octet-stream");
  });
});
