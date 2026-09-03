import { describe, expect, it, vi } from "vitest";
import { resolveFiles } from "../src/operations/resolve-content.js";
import { sha256Hex } from "../src/domain/meta.js";

const codeOf = async (call: () => Promise<unknown>) => {
  try {
    await call();
    return "no error";
  } catch (error) {
    return (error as { code?: string }).code ?? "not an ApiError";
  }
};

describe("resolveFiles", () => {
  it("hashes a text entry and types it from the extension", async () => {
    const resolved = await resolveFiles([{ path: "index.html", text: "<h1>hi</h1>" }]);
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
    const resolved = await resolveFiles([{ path: "a.txt", text: "héllo" }]);
    expect(resolved.manifest["a.txt"]!.size).toBe(6);
  });

  it("decodes a base64 entry to its bytes", async () => {
    const png = "iVBORw0KGgo=";
    const resolved = await resolveFiles([{ path: "shot.png", base64: png }]);
    expect(resolved.files[0]!.contentType).toBe("image/png");
    expect([...resolved.files[0]!.bytes!.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(resolved.manifest["shot.png"]!.size).toBe(8);
  });

  it("keeps the caller's order, which is the order get(files:true) spends its budget in", async () => {
    const resolved = await resolveFiles([
      { path: "z.txt", text: "z" },
      { path: "a.txt", text: "a" },
    ]);
    expect(Object.keys(resolved.manifest)).toEqual(["z.txt", "a.txt"]);
  });

  it("writes one blob per distinct digest even when two paths share content", async () => {
    const resolved = await resolveFiles([
      { path: "a.txt", text: "same" },
      { path: "b.txt", text: "same" },
    ]);
    expect(resolved.files).toHaveLength(2);
    expect(resolved.blobs.size).toBe(1);
  });

  it("normalises the path into the manifest", async () => {
    const resolved = await resolveFiles([
      { path: `cafe${String.fromCharCode(0x301)}.txt`, text: "x" },
    ]);
    expect(Object.keys(resolved.manifest)).toEqual(["café.txt"]);
  });

  it("rejects a bad path as INVALID_PATH", async () => {
    expect(await codeOf(() => resolveFiles([{ path: "../a.txt", text: "x" }]))).toBe(
      "INVALID_PATH",
    );
  });

  it("rejects duplicate paths as INVALID_PATH", async () => {
    expect(
      await codeOf(() =>
        resolveFiles([
          { path: "a.txt", text: "x" },
          { path: "a.txt", text: "y" },
        ]),
      ),
    ).toBe("INVALID_PATH");
  });

  it("rejects a text entry whose extension names a binary type", async () => {
    expect(await codeOf(() => resolveFiles([{ path: "shot.png", text: "x" }]))).toBe(
      "INVALID_INPUT",
    );
  });

  it("accepts a base64 entry's own digest and refuses one that does not match", async () => {
    const png = "iVBORw0KGgo=";
    const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
    const digest = await sha256Hex(bytes as Uint8Array<ArrayBuffer>);
    const resolved = await resolveFiles([{ path: "shot.png", base64: png, sha256: digest }]);
    expect(resolved.manifest["shot.png"]!.sha256).toBe(digest);
    expect(
      await codeOf(() => resolveFiles([{ path: "shot.png", base64: png, sha256: "0".repeat(64) }])),
    ).toBe("HASH_MISMATCH");
  });

  it("rejects base64 that is not base64", async () => {
    expect(await codeOf(() => resolveFiles([{ path: "a.bin", base64: "!!!!" }]))).toBe(
      "INVALID_INPUT",
    );
  });

  it("types an unknown extension as an octet stream", async () => {
    const resolved = await resolveFiles([{ path: "archive.bin", base64: "AAAA" }]);
    expect(resolved.files[0]!.contentType).toBe("application/octet-stream");
  });
});

/* ---------------------------------------------------------- `url` entries */

import { INITIAL_POLICY } from "../src/policy/defaults.js";
import type { ResolvedPolicy } from "../src/instance-config.js";
import { newFetchBudget } from "../src/operations/fetch-url.js";

const policy = INITIAL_POLICY as unknown as ResolvedPolicy;

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngDigest = await sha256Hex(png as Uint8Array<ArrayBuffer>);

function serve(bytes: Uint8Array, init: ResponseInit = {}) {
  return async () =>
    new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]).stream(), {
      status: 200,
      headers: { "content-type": "text/plain", ...(init.headers ?? {}) },
      ...init,
    });
}

describe("resolveFiles with url entries", () => {
  it("fetches a url entry, types it from the extension and not from the response", async () => {
    const resolved = await resolveFiles([{ path: "logo.png", url: "https://a.example/x" }], {
      policy,
      fetchImpl: serve(png) as unknown as typeof fetch,
    });
    expect(resolved.manifest["logo.png"]).toEqual({
      sha256: pngDigest,
      size: 8,
      content_type: "image/png",
    });
    expect(resolved.blobs.get(pngDigest)).toBeDefined();
  });

  it("streams a url entry that carries its digest straight to the blob writer", async () => {
    const written: string[] = [];
    const resolved = await resolveFiles(
      [{ path: "logo.png", url: "https://a.example/x", sha256: pngDigest }],
      {
        policy,
        fetchImpl: serve(png) as unknown as typeof fetch,
        async streamBlob(digest, body) {
          written.push(digest);
          if (body instanceof Uint8Array) return body.length;
          let size = 0;
          const reader = body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
          }
          return size;
        },
      },
    );
    expect(written).toEqual([pngDigest]);
    // Streamed, so the bytes never sat in the isolate's memory.
    expect(resolved.blobs.size).toBe(0);
    expect(resolved.manifest["logo.png"]!.size).toBe(8);
  });

  it("does not fetch a url entry whose digest the drop already holds", async () => {
    const spy = vi.fn(serve(png) as unknown as typeof fetch);
    const resolved = await resolveFiles(
      [{ path: "logo.png", url: "https://a.example/x", sha256: pngDigest }],
      { policy, fetchImpl: spy, held: new Map([[pngDigest, 8]]) },
    );
    expect(spy).not.toHaveBeenCalled();
    expect(resolved.manifest["logo.png"]).toEqual({
      sha256: pngDigest,
      size: 8,
      content_type: "image/png",
    });
  });

  it("streams a body whose length the caller declared, past max_unhashed_bytes", async () => {
    const big = new Uint8Array(4096);
    const digest = await sha256Hex(big as Uint8Array<ArrayBuffer>);
    const tiny = { ...policy, max_unhashed_bytes: 16 } as ResolvedPolicy;
    const resolved = await resolveFiles(
      [{ path: "a.bin", url: "https://a.example/x", sha256: digest, size: 4096 }],
      { policy: tiny, fetchImpl: serve(big) as unknown as typeof fetch, streamBlob: async () => 4096 },
    );
    expect(resolved.manifest["a.bin"]!.size).toBe(4096);
  });

  it("refuses a body that is not the length the caller declared", async () => {
    const big = new Uint8Array(4096);
    const digest = await sha256Hex(big as Uint8Array<ArrayBuffer>);
    expect(
      await codeOf(() =>
        resolveFiles([{ path: "a.bin", url: "https://a.example/x", sha256: digest, size: 999 }], {
          policy,
          fetchImpl: serve(big) as unknown as typeof fetch,
          streamBlob: async () => 999,
        }),
      ),
    ).toBe("HASH_MISMATCH");
  });

  it("refuses a declared size over max_file_bytes before it reads a byte", async () => {
    const spy = vi.fn(serve(new Uint8Array(4)) as unknown as typeof fetch);
    const tiny = { ...policy, max_file_bytes: 1024 } as ResolvedPolicy;
    expect(
      await codeOf(() =>
        resolveFiles([{ path: "a.bin", url: "https://a.example/x", sha256: "a".repeat(64), size: 99999 }], {
          policy: tiny,
          fetchImpl: spy,
          streamBlob: async () => 0,
        }),
      ),
    ).toBe("PAYLOAD_TOO_LARGE");
  });

  it("refuses an undigested body over max_unhashed_bytes", async () => {
    const big = new Uint8Array(64);
    const tiny = { ...policy, max_unhashed_bytes: 16 } as ResolvedPolicy;
    expect(
      await codeOf(() =>
        resolveFiles([{ path: "a.bin", url: "https://a.example/x" }], {
          policy: tiny,
          fetchImpl: serve(big) as unknown as typeof fetch,
        }),
      ),
    ).toBe("PAYLOAD_TOO_LARGE");
  });

  it("refuses a body over max_file_bytes on its declared length alone", async () => {
    const spy = vi.fn(
      (async () =>
        new Response("x", { status: 200, headers: { "content-length": "999999" } })) as unknown as typeof fetch,
    );
    const tiny = { ...policy, max_file_bytes: 1024 } as ResolvedPolicy;
    expect(
      await codeOf(() =>
        resolveFiles([{ path: "a.bin", url: "https://a.example/x", sha256: pngDigest }], {
          policy: tiny,
          fetchImpl: spy,
          streamBlob: async () => 0,
        }),
      ),
    ).toBe("PAYLOAD_TOO_LARGE");
  });

  it("refuses bytes that do not hash to the digest the caller sent", async () => {
    expect(
      await codeOf(() =>
        resolveFiles([{ path: "logo.png", url: "https://a.example/x", sha256: "0".repeat(64) }], {
          policy,
          fetchImpl: serve(png) as unknown as typeof fetch,
        }),
      ),
    ).toBe("HASH_MISMATCH");
  });

  it("turns a 404 target into FETCH_FAILED", async () => {
    expect(
      await codeOf(() =>
        resolveFiles([{ path: "a.png", url: "https://a.example/x" }], {
          policy,
          fetchImpl: (async () => new Response("no", { status: 404 })) as unknown as typeof fetch,
        }),
      ),
    ).toBe("FETCH_FAILED");
  });

  it("refuses a forbidden target without fetching it", async () => {
    const spy = vi.fn(serve(png) as unknown as typeof fetch);
    expect(
      await codeOf(() =>
        resolveFiles([{ path: "a.png", url: "http://169.254.169.254/" }], { policy, fetchImpl: spy }),
      ),
    ).toBe("FETCH_FAILED");
    expect(spy).not.toHaveBeenCalled();
  });

  it("spends one shared fetch budget across every entry of the call", async () => {
    const budget = newFetchBudget();
    await resolveFiles(
      [
        { path: "a.png", url: "https://a.example/1" },
        { path: "b.png", url: "https://a.example/2" },
      ],
      { policy, budget, fetchImpl: serve(png) as unknown as typeof fetch },
    );
    expect(budget.used).toBe(2);
  });

  it("mixes inline and url entries in one call, keeping the caller's order", async () => {
    const resolved = await resolveFiles(
      [
        { path: "index.html", text: "<img src=logo.png>" },
        { path: "logo.png", url: "https://a.example/x" },
      ],
      { policy, fetchImpl: serve(png) as unknown as typeof fetch },
    );
    expect(Object.keys(resolved.manifest)).toEqual(["index.html", "logo.png"]);
  });
});
