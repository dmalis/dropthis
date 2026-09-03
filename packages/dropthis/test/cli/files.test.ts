import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { collectFiles } from "../../src/cli/files.js";

/**
 * What the CLI sends is what is on disk: every file's sha256 is computed
 * locally (AGENTS.md: "the CLI always sends digests"), a directory becomes its
 * relative paths, and two arguments that would land on one drop path are a
 * refusal, never a silent overwrite.
 */
let root: string;

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "dropthis-files-"));
  await mkdir(join(root, "site", "css"), { recursive: true });
  await mkdir(join(root, "site", ".git"), { recursive: true });
  await mkdir(join(root, "site", "node_modules"), { recursive: true });
  await writeFile(join(root, "site", "index.html"), "<h1>hi</h1>");
  await writeFile(join(root, "site", "css", "a.css"), "body{}");
  await writeFile(join(root, "site", ".git", "HEAD"), "ref");
  await writeFile(join(root, "site", "node_modules", "x.js"), "x");
  await writeFile(join(root, "site", ".hidden"), "h");
  await mkdir(join(root, "other"), { recursive: true });
  await writeFile(join(root, "other", "index.html"), "<h1>other</h1>");
  await writeFile(join(root, "report.pdf"), "%PDF");
});

describe("collectFiles", () => {
  it("walks a directory into relative paths with sizes and digests, sorted", async () => {
    const files = await collectFiles([join(root, "site")]);
    expect(files.map((f) => [f.path, f.size, f.sha256])).toEqual([
      [".hidden", 1, sha("h")],
      ["css/a.css", 6, sha("body{}")],
      ["index.html", 11, sha("<h1>hi</h1>")],
    ]);
    expect(files[0]!.file).toBe(join(root, "site", ".hidden"));
  });

  it("names a single file by its basename", async () => {
    const files = await collectFiles([join(root, "report.pdf")]);
    expect(files.map((f) => f.path)).toEqual(["report.pdf"]);
  });

  it("merges several arguments and refuses a path collision", async () => {
    const files = await collectFiles([join(root, "report.pdf"), join(root, "site", "css")]);
    expect(files.map((f) => f.path)).toEqual(["a.css", "report.pdf"]);

    await expect(collectFiles([join(root, "site"), join(root, "other")])).rejects.toMatchObject({
      code: "INVALID_PATH",
      message: expect.stringContaining("index.html"),
    });
  });

  it("refuses a path that is not there", async () => {
    await expect(collectFiles([join(root, "missing.txt")])).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining("missing.txt"),
    });
  });
});
