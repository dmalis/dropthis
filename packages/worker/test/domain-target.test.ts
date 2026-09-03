import { describe, expect, it } from "vitest";
import { decodeRequestPath, encodePathForUrl } from "../src/domain/url-path.js";
import { dropUrl, resolveTarget, TargetError } from "../src/domain/target.js";

const ORIGINS = {
  canonicalUrl: "https://drops.example.com",
  aliasOrigins: ["https://dropthis-main.acme.workers.dev"],
};

describe("resolveTarget", () => {
  it("accepts a bare slug", () => {
    expect(resolveTarget("abcdefghij", ORIGINS)).toBe("abcdefghij");
  });

  it("accepts a URL on the canonical origin", () => {
    expect(resolveTarget("https://drops.example.com/abcdefghij/", ORIGINS)).toBe("abcdefghij");
  });

  it("accepts a URL on an alias origin", () => {
    expect(resolveTarget("https://dropthis-main.acme.workers.dev/abcdefghij/", ORIGINS)).toBe(
      "abcdefghij",
    );
  });

  it("accepts a deep URL inside the drop", () => {
    expect(resolveTarget("https://drops.example.com/abcdefghij/docs/a.html?x=1#y", ORIGINS)).toBe(
      "abcdefghij",
    );
  });

  it("refuses a URL from another instance", () => {
    expect(() => resolveTarget("https://someone-else.example/abcdefghij/", ORIGINS)).toThrow(
      expect.objectContaining({ code: "WRONG_INSTANCE" }),
    );
  });

  it("treats a different port or scheme as another origin", () => {
    expect(() => resolveTarget("http://drops.example.com/abcdefghij/", ORIGINS)).toThrow(
      expect.objectContaining({ code: "WRONG_INSTANCE" }),
    );
    expect(() => resolveTarget("https://drops.example.com:8443/abcdefghij/", ORIGINS)).toThrow(
      expect.objectContaining({ code: "WRONG_INSTANCE" }),
    );
  });

  it("refuses a canonical URL whose first segment is not a slug", () => {
    expect(() => resolveTarget("https://drops.example.com/_connect", ORIGINS)).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(() => resolveTarget("https://drops.example.com/", ORIGINS)).toThrow(TargetError);
  });

  it.each(["", "ABCDEFGHIJ", "abcdefghi", "not a slug", "ftp://drops.example.com/abcdefghij/"])(
    "refuses %s as INVALID_INPUT",
    (target) => {
      expect(() => resolveTarget(target, ORIGINS)).toThrow(
        expect.objectContaining({ code: "INVALID_INPUT" }),
      );
    },
  );
});

describe("dropUrl", () => {
  it("builds the canonical URL of a drop, with a trailing slash", () => {
    expect(dropUrl("abcdefghij", ORIGINS.canonicalUrl)).toBe(
      "https://drops.example.com/abcdefghij/",
    );
  });

  it("tolerates a canonical_url stored with a trailing slash", () => {
    expect(dropUrl("abcdefghij", "https://drops.example.com/")).toBe(
      "https://drops.example.com/abcdefghij/",
    );
  });
});

describe("encodePathForUrl", () => {
  it("leaves an ordinary path alone", () => {
    expect(encodePathForUrl("docs/a.html")).toBe("docs/a.html");
  });

  it("percent-encodes each segment but never the separators", () => {
    expect(encodePathForUrl("my docs/a b.html")).toBe("my%20docs/a%20b.html");
  });

  it("encodes a literal question mark, hash and plus inside a name", () => {
    expect(encodePathForUrl("a?b#c+d.txt")).toBe("a%3Fb%23c%2Bd.txt");
  });
});

describe("decodeRequestPath", () => {
  it("decodes each segment exactly once", () => {
    expect(decodeRequestPath("my%20docs/a%20b.html")).toBe("my docs/a b.html");
  });

  it("does not decode twice", () => {
    // "%2520" is the encoding of the literal text "%20".
    expect(decodeRequestPath("a%2520b.txt")).toBe("a%20b.txt");
  });

  it("rejects an encoded separator", () => {
    expect(decodeRequestPath("a%2Fb.txt")).toBe(null);
    expect(decodeRequestPath("a%2fb.txt")).toBe(null);
  });

  it("rejects a malformed percent escape", () => {
    expect(decodeRequestPath("a%zz.txt")).toBe(null);
  });

  it("rejects invalid UTF-8", () => {
    expect(decodeRequestPath("a%FF.txt")).toBe(null);
  });

  it("normalises the decoded path to NFC so it matches the manifest", () => {
    const nfd = encodeURIComponent(`cafe${String.fromCharCode(0x301)}.txt`);
    expect(decodeRequestPath(nfd)).toBe("café.txt");
  });

  it("rejects a path that would be invalid in a manifest", () => {
    expect(decodeRequestPath("../secret.txt")).toBe(null);
    expect(decodeRequestPath("%2E%2E/secret.txt")).toBe(null);
    expect(decodeRequestPath("")).toBe(null);
  });

  it("round-trips everything encodePathForUrl produces", () => {
    for (const path of ["a b/c.html", "café/x.txt", "a?b#c+d.txt", "π/ω.md"]) {
      expect(decodeRequestPath(encodePathForUrl(path))).toBe(path.normalize("NFC"));
    }
  });
});
