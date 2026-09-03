import { describe, expect, it } from "vitest";
import { MAX_FILES_PER_CALL, parsePublishInput } from "../src/registry/publish.js";

const ok = { files: [{ path: "index.html", text: "<h1>hi</h1>" }] };

const codeOf = (call: () => unknown) => {
  try {
    call();
    return "no error";
  } catch (error) {
    return (error as { code?: string }).code ?? "not an ApiError";
  }
};

describe("parsePublishInput", () => {
  it("accepts the minimum call: one text file", () => {
    expect(parsePublishInput(ok)).toEqual(ok);
  });

  it("accepts every field of this slice", () => {
    const full = {
      files: [{ path: "a.png", base64: "AAAA" }],
      title: "Report",
      meta: { source: "n8n", rows: 12, nested: { a: [1, 2] } },
      expires: "7d",
      noindex: false,
      idempotency_key: "run-42",
    };
    expect(parsePublishInput(full)).toEqual(full);
  });

  it("rejects an unknown top-level field — the schema is the contract", () => {
    expect(codeOf(() => parsePublishInput({ ...ok, password: "hunter22" }))).toBe("INVALID_INPUT");
    expect(codeOf(() => parsePublishInput({ ...ok, slug: "mine" }))).toBe("INVALID_INPUT");
  });

  it("names the unknown field so the agent can fix it", () => {
    expect(() => parsePublishInput({ ...ok, password: "hunter22" })).toThrow(/password/);
  });

  it("rejects an unknown field inside a file entry", () => {
    expect(
      codeOf(() => parsePublishInput({ files: [{ path: "a.txt", text: "x", url: "https://x" }] })),
    ).toBe("INVALID_INPUT");
  });

  it("rejects an entry that carries both text and base64", () => {
    expect(
      codeOf(() => parsePublishInput({ files: [{ path: "a.txt", text: "x", base64: "AAAA" }] })),
    ).toBe("INVALID_INPUT");
  });

  it("rejects an entry that carries neither", () => {
    expect(codeOf(() => parsePublishInput({ files: [{ path: "a.txt" }] }))).toBe("INVALID_INPUT");
  });

  it("rejects a url entry — the fetch path is not in this slice", () => {
    expect(
      codeOf(() => parsePublishInput({ files: [{ path: "a.txt", url: "https://example.com/a" }] })),
    ).toBe("INVALID_INPUT");
  });

  it("requires at least one file", () => {
    expect(codeOf(() => parsePublishInput({ files: [] }))).toBe("INVALID_INPUT");
  });

  it("requires a body that is an object", () => {
    expect(codeOf(() => parsePublishInput(null))).toBe("INVALID_INPUT");
    expect(codeOf(() => parsePublishInput("files"))).toBe("INVALID_INPUT");
    expect(codeOf(() => parsePublishInput([ok]))).toBe("INVALID_INPUT");
  });

  it("treats too many files as a policy violation, not a malformed call", () => {
    const files = Array.from({ length: MAX_FILES_PER_CALL + 1 }, (_, i) => ({
      path: `f${i}.txt`,
      text: "x",
    }));
    expect(codeOf(() => parsePublishInput({ files }))).toBe("POLICY_VIOLATION");
  });

  it("accepts exactly the maximum number of files", () => {
    const files = Array.from({ length: MAX_FILES_PER_CALL }, (_, i) => ({
      path: `f${i}.txt`,
      text: "x",
    }));
    expect(parsePublishInput({ files }).files).toHaveLength(MAX_FILES_PER_CALL);
  });

  it("caps the title at 200 bytes of UTF-8, not 200 characters", () => {
    expect(parsePublishInput({ ...ok, title: "a".repeat(200) }).title).toHaveLength(200);
    expect(codeOf(() => parsePublishInput({ ...ok, title: "a".repeat(201) }))).toBe(
      "INVALID_INPUT",
    );
    expect(codeOf(() => parsePublishInput({ ...ok, title: "é".repeat(101) }))).toBe(
      "INVALID_INPUT",
    );
  });

  it("caps meta at 16 KB", () => {
    const meta = { blob: "x".repeat(17_000) };
    expect(codeOf(() => parsePublishInput({ ...ok, meta }))).toBe("INVALID_INPUT");
  });

  it("rejects a meta that is not an object", () => {
    expect(codeOf(() => parsePublishInput({ ...ok, meta: [1, 2] }))).toBe("INVALID_INPUT");
    expect(codeOf(() => parsePublishInput({ ...ok, meta: "x" }))).toBe("INVALID_INPUT");
  });

  it("normalises the title to NFC, because it is hashed into the state", () => {
    const parsed = parsePublishInput({ ...ok, title: `cafe${String.fromCharCode(0x301)}` });
    expect(parsed.title).toBe("café");
  });

  it("rejects an empty idempotency_key", () => {
    expect(codeOf(() => parsePublishInput({ ...ok, idempotency_key: "" }))).toBe("INVALID_INPUT");
  });
});
