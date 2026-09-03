import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  dropFiles,
  manifestGen,
  META_SCHEMA,
  newDropMeta,
  sha256Hex,
  stateHash,
  toDrop,
} from "../src/domain/meta.js";
import type { DropMeta, Manifest } from "../src/domain/meta.js";

const MANIFEST: Manifest = {
  "index.html": { sha256: "a".repeat(64), size: 12, content_type: "text/html" },
  "logo.png": { sha256: "b".repeat(64), size: 34, content_type: "image/png" },
};

const META: DropMeta = {
  schema: META_SCHEMA,
  id: "01J000000000000000000000",
  slug: "abcdefghij",
  title: "Weekly report",
  meta: { source: "n8n" },
  access: {},
  current_gen: "c".repeat(64),
  manifest: MANIFEST,
  expires_at: "2026-10-03T12:00:00Z",
  noindex: true,
  created_by: { id: "dev", label: "admin" },
  created: "2026-09-03T12:00:00Z",
  updated: "2026-09-03T12:00:00Z",
};

describe("canonicalJson", () => {
  it("sorts object keys so two spellings of one value hash alike", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("keeps array order, which is data", () => {
    expect(canonicalJson([2, 1])).toBe("[2,1]");
  });
});

describe("sha256Hex", () => {
  it("is the known digest of the empty string", async () => {
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("hashes bytes and their UTF-8 text identically", async () => {
    expect(await sha256Hex("abc")).toBe(await sha256Hex(new TextEncoder().encode("abc")));
  });
});

describe("manifestGen", () => {
  it("is the same for the same content in a different key order", async () => {
    const reordered: Manifest = {
      "logo.png": MANIFEST["logo.png"]!,
      "index.html": MANIFEST["index.html"]!,
    };
    expect(await manifestGen(reordered)).toBe(await manifestGen(MANIFEST));
  });

  it("changes when a file's bytes change", async () => {
    const changed: Manifest = {
      ...MANIFEST,
      "logo.png": { ...MANIFEST["logo.png"]!, sha256: "d".repeat(64) },
    };
    expect(await manifestGen(changed)).not.toBe(await manifestGen(MANIFEST));
  });

  it("is 64 hex characters", async () => {
    expect(await manifestGen(MANIFEST)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("stateHash", () => {
  it("ignores `updated`, which is not part of the desired state", async () => {
    expect(await stateHash({ ...META, updated: "2027-01-01T00:00:00Z" })).toBe(
      await stateHash(META),
    );
  });

  it("changes when a setting changes", async () => {
    expect(await stateHash({ ...META, noindex: false })).not.toBe(await stateHash(META));
    expect(await stateHash({ ...META, title: "Other" })).not.toBe(await stateHash(META));
  });
});

describe("newDropMeta", () => {
  it("writes schema 1 with the fields the layout names, in order", async () => {
    const created = await newDropMeta({
      id: "01J000000000000000000000",
      slug: "abcdefghij",
      title: "Weekly report",
      meta: { source: "n8n" },
      manifest: MANIFEST,
      expiresAt: "2026-10-03T12:00:00Z",
      noindex: true,
      createdBy: { id: "dev", label: "admin" },
      now: new Date("2026-09-03T12:00:00Z"),
    });

    expect(Object.keys(created)).toEqual([
      "schema",
      "id",
      "slug",
      "title",
      "meta",
      "access",
      "current_gen",
      "manifest",
      "expires_at",
      "noindex",
      "created_by",
      "created",
      "updated",
    ]);
    expect(created.schema).toBe(1);
    expect(created.access).toEqual({});
    expect(created.current_gen).toBe(await manifestGen(MANIFEST));
    expect(created.created).toBe("2026-09-03T12:00:00Z");
    expect(created.updated).toBe(created.created);
  });

  it("stores an absent title and meta as null and an empty object", async () => {
    const created = await newDropMeta({
      id: "x",
      slug: "abcdefghij",
      title: null,
      meta: {},
      manifest: MANIFEST,
      expiresAt: null,
      noindex: true,
      createdBy: { id: "dev", label: "admin" },
      now: new Date("2026-09-03T12:00:00Z"),
    });
    expect(created.title).toBe(null);
    expect(created.meta).toEqual({});
    expect(created.expires_at).toBe(null);
  });
});

describe("dropFiles", () => {
  it("lists path, size, sha256 and content type in manifest order", () => {
    expect(dropFiles(MANIFEST)).toEqual([
      { path: "index.html", size: 12, sha256: "a".repeat(64), content_type: "text/html" },
      { path: "logo.png", size: 34, sha256: "b".repeat(64), content_type: "image/png" },
    ]);
  });
});

describe("toDrop", () => {
  const now = new Date("2026-09-03T12:00:00Z");

  it("is the one response shape, with a stable key order", () => {
    const drop = toDrop(META, { canonicalUrl: "https://drops.example.com", now });
    expect(Object.keys(drop)).toEqual([
      "url",
      "slug",
      "title",
      "meta",
      "created_by",
      "created",
      "updated",
      "expires_at",
      "noindex",
      "has_password",
      "state",
      "files",
    ]);
    expect(drop.url).toBe("https://drops.example.com/abcdefghij/");
    expect(drop.has_password).toBe(false);
    expect(drop.state).toBe("live");
    expect(drop.files).toEqual(dropFiles(MANIFEST));
  });

  it("reports has_password from access, not from a separate flag", () => {
    const locked: DropMeta = { ...META, access: { password: { algorithm: "pbkdf2-sha256" } } };
    expect(toDrop(locked, { canonicalUrl: "https://drops.example.com", now }).has_password).toBe(
      true,
    );
  });

  it("derives state from the clock", () => {
    const drop = toDrop(META, {
      canonicalUrl: "https://drops.example.com",
      now: new Date("2026-10-04T12:00:00Z"),
    });
    expect(drop.state).toBe("expired_grace");
  });

  it("omits files when the caller asks for the list shape", () => {
    const drop = toDrop(META, {
      canonicalUrl: "https://drops.example.com",
      now,
      files: false,
      meta: false,
    });
    expect(drop).not.toHaveProperty("files");
    expect(drop).not.toHaveProperty("meta");
  });
});
