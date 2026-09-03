import { describe, expect, it } from "vitest";
import { ApiError } from "../src/errors.js";
import { parseUpdateInput } from "../src/registry/update.js";

const message = (body: unknown): string => {
  try {
    parseUpdateInput(body);
  } catch (error) {
    return `${(error as ApiError).code}: ${(error as ApiError).message}`;
  }
  throw new Error("parseUpdateInput accepted a body it should have refused.");
};

describe("parseUpdateInput", () => {
  it("accepts an empty body: an update that asks for nothing is a no-op", () => {
    expect(parseUpdateInput({})).toEqual({});
  });

  it("accepts any subset of the fields", () => {
    expect(parseUpdateInput({ title: "New" })).toEqual({ title: "New" });
    expect(parseUpdateInput({ expires: "7d" })).toEqual({ expires: "7d" });
    expect(parseUpdateInput({ noindex: false })).toEqual({ noindex: false });
    expect(parseUpdateInput({ files: [{ path: "a.txt", text: "x" }] })).toEqual({
      files: [{ path: "a.txt", text: "x" }],
    });
  });

  it("takes null for title, so a title can be removed again", () => {
    expect(parseUpdateInput({ title: null })).toEqual({ title: null });
  });

  it("keeps a meta key set to null: the merge is what deletes it", () => {
    expect(parseUpdateInput({ meta: { a: 1, b: null } })).toEqual({ meta: { a: 1, b: null } });
  });

  it("normalises the title to NFC, because it is hashed into the drop state", () => {
    const parsed = parseUpdateInput({ title: `cafe${String.fromCharCode(0x301)}` });
    expect(parsed.title).toBe("café");
  });

  it("names an unknown field instead of ignoring it", () => {
    expect(message({ passwrd: "x" })).toContain("passwrd");
    expect(message({ passwrd: "x" })).toContain("INVALID_INPUT");
  });

  it("takes password as a string, null, or absent — like publish", () => {
    expect(parseUpdateInput({ password: "hunter22" }).password).toBe("hunter22");
    expect(parseUpdateInput({ password: "generate" }).password).toBe("generate");
    expect(parseUpdateInput({ password: null }).password).toBeNull();
    expect(parseUpdateInput({})).not.toHaveProperty("password");
    expect(message({ password: 42 })).toContain("password");
  });

  it("refuses an empty files array: use delete, not an empty drop", () => {
    expect(message({ files: [] })).toContain("INVALID_INPUT");
  });

  it("refuses more than 500 files", () => {
    const files = Array.from({ length: 501 }, (_, i) => ({ path: `f${i}.txt`, text: "x" }));
    expect(message({ files })).toContain("POLICY_VIOLATION");
  });

  it("refuses a title over 200 bytes of UTF-8", () => {
    expect(message({ title: "é".repeat(101) })).toContain("INVALID_INPUT");
  });

  it("refuses a meta blob over 16 KB", () => {
    expect(message({ meta: { big: "x".repeat(17 * 1024) } })).toContain("INVALID_INPUT");
  });

  it("refuses an empty idempotency_key", () => {
    expect(message({ idempotency_key: "" })).toContain("INVALID_INPUT");
  });

  it("refuses a file entry with both text and base64", () => {
    expect(message({ files: [{ path: "a.txt", text: "x", base64: "eA==" }] })).toContain(
      "INVALID_INPUT",
    );
  });
});

/**
 * The fourth entry kind (issue #17): `{path, sha256}` = keep the blob this drop
 * already holds. It is an `update` kind only — a new drop holds nothing — and
 * the union stays strict, so it can never be combined with content.
 */
describe("parseUpdateInput with keep entries", () => {
  const digest = "a".repeat(64);

  it("accepts {path, sha256} as the keep kind", () => {
    expect(parseUpdateInput({ files: [{ path: "logo.png", sha256: digest }] })).toEqual({
      files: [{ path: "logo.png", sha256: digest }],
    });
  });

  it("accepts a keep beside an inline change, which is the whole point", () => {
    const files = [
      { path: "index.html", text: "<h1>fixed</h1>" },
      { path: "logo.png", sha256: digest },
    ];
    expect(parseUpdateInput({ files }).files).toEqual(files);
  });

  it("refuses a keep that also carries content", () => {
    expect(message({ files: [{ path: "a.png", sha256: digest, text: "x" }] })).toContain(
      "INVALID_INPUT",
    );
    expect(message({ files: [{ path: "a.png", sha256: digest, size: 3 }] })).toContain(
      "INVALID_INPUT",
    );
  });
});
