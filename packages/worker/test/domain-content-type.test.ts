import { describe, expect, it } from "vitest";
import {
  contentTypeForPath,
  isTextTyped,
  servedContentType,
  textEntryContentType,
} from "../src/domain/content-type.js";

describe("contentTypeForPath", () => {
  it.each([
    ["index.html", "text/html"],
    ["a/b/page.htm", "text/html"],
    ["site.css", "text/css"],
    ["app.js", "text/javascript"],
    ["app.mjs", "text/javascript"],
    ["data.json", "application/json"],
    ["app.js.map", "application/json"],
    ["notes.txt", "text/plain"],
    ["readme.md", "text/markdown"],
    ["rows.csv", "text/csv"],
    ["rows.tsv", "text/tab-separated-values"],
    ["feed.xml", "application/xml"],
    ["logo.svg", "image/svg+xml"],
    ["conf.yaml", "application/yaml"],
    ["conf.yml", "application/yaml"],
    ["shot.png", "image/png"],
    ["shot.jpg", "image/jpeg"],
    ["shot.jpeg", "image/jpeg"],
    ["anim.gif", "image/gif"],
    ["shot.webp", "image/webp"],
    ["shot.avif", "image/avif"],
    ["favicon.ico", "image/x-icon"],
    ["report.pdf", "application/pdf"],
    ["book.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["memo.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    ["bundle.zip", "application/zip"],
    ["clip.mp4", "video/mp4"],
    ["clip.webm", "video/webm"],
    ["song.mp3", "audio/mpeg"],
    ["song.wav", "audio/wav"],
    ["face.woff", "font/woff"],
    ["face.woff2", "font/woff2"],
    ["face.ttf", "font/ttf"],
  ])("maps %s to %s", (path, type) => {
    expect(contentTypeForPath(path)).toBe(type);
  });

  it("is case-insensitive on the extension", () => {
    expect(contentTypeForPath("INDEX.HTML")).toBe("text/html");
  });

  it("falls back to application/octet-stream for an unknown extension", () => {
    expect(contentTypeForPath("archive.tar.zst")).toBe("application/octet-stream");
  });

  it("falls back for a file with no extension", () => {
    expect(contentTypeForPath("LICENSE")).toBe("application/octet-stream");
  });

  it("does not read an extension out of a directory name", () => {
    expect(contentTypeForPath("assets.css/LICENSE")).toBe("application/octet-stream");
  });

  it("does not treat a dotfile as an extension", () => {
    expect(contentTypeForPath(".gitignore")).toBe("application/octet-stream");
  });
});

describe("isTextTyped", () => {
  it.each([
    "text/html",
    "text/plain",
    "text/markdown",
    "application/json",
    "application/javascript",
    "application/xml",
    "image/svg+xml",
    "application/ld+json",
    "application/atom+xml",
  ])("treats %s as text", (type) => {
    expect(isTextTyped(type)).toBe(true);
  });

  it.each(["image/png", "application/pdf", "application/octet-stream", "application/yaml"])(
    "treats %s as binary",
    (type) => {
      expect(isTextTyped(type)).toBe(false);
    },
  );
});

describe("textEntryContentType", () => {
  it("uses the extension when it is text-typed", () => {
    expect(textEntryContentType("index.html")).toBe("text/html");
  });

  it("defaults an unknown extension to text/plain", () => {
    expect(textEntryContentType("notes.wat")).toBe("text/plain");
  });

  it("returns null for an extension that is not text-typed", () => {
    expect(textEntryContentType("shot.png")).toBe(null);
  });
});

describe("servedContentType", () => {
  it.each([
    "text/html",
    "text/css",
    "text/javascript",
    "text/plain",
    "text/markdown",
    "text/csv",
    "text/tab-separated-values",
    "application/json",
    "application/xml",
    "image/svg+xml",
  ])("declares UTF-8 for %s, the charset the product assumes", (type) => {
    expect(servedContentType(type)).toBe(`${type}; charset=utf-8`);
  });

  it.each([
    "application/octet-stream",
    "image/png",
    "application/pdf",
    "font/woff2",
    "video/mp4",
    "application/zip",
  ])("leaves %s alone: a charset on binary bytes means nothing", (type) => {
    expect(servedContentType(type)).toBe(type);
  });

  it("never doubles a charset that is already there", () => {
    expect(servedContentType("text/html; charset=utf-8")).toBe("text/html; charset=utf-8");
    expect(servedContentType("text/html;charset=iso-8859-1")).toBe("text/html;charset=iso-8859-1");
  });

  it("covers exactly the types get(files:true) inlines as text", () => {
    for (const type of ["text/plain", "application/json", "image/svg+xml", "image/png"]) {
      expect(servedContentType(type).endsWith("; charset=utf-8")).toBe(isTextTyped(type));
    }
  });
});
