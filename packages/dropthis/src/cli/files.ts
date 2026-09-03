/**
 * The files a `publish` or `update` sends, as they are on disk.
 *
 * Every file gets a sha256 computed here, streaming, before anything is sent
 * — the CLI always sends digests (AGENTS.md, "One call uploads a drop"), so
 * the instance verifies the bytes it stores and an inline entry and a staged
 * PUT carry the same proof. A directory becomes its files with paths relative
 * to it; a single file is its basename. The result is sorted by drop path so
 * the manifest — and therefore the drop's generation id — is the same for the
 * same tree every time.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { CliError } from "./errors.js";

export type LocalFile = {
  /** The path inside the drop, `/`-separated. */
  path: string;
  /** The absolute path on disk. */
  file: string;
  size: number;
  sha256: string;
};

/** Never published from a directory: tooling state, not content. */
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);
const SKIPPED_FILES = new Set([".DS_Store", "Thumbs.db"]);

export async function collectFiles(paths: readonly string[], cwd = process.cwd()): Promise<LocalFile[]> {
  const found = new Map<string, string>();

  for (const given of paths) {
    const absolute = resolve(cwd, given);
    let info;
    try {
      info = await stat(absolute);
    } catch {
      throw new CliError("INVALID_INPUT", `${given} does not exist.`, "Pass a file or directory that exists.");
    }
    if (info.isDirectory()) {
      for (const file of await walk(absolute)) add(found, toDropPath(relative(absolute, file)), file, given);
    } else {
      add(found, basename(absolute), absolute, given);
    }
  }

  const files: LocalFile[] = [];
  for (const [path, file] of [...found.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const { size, sha256 } = await digest(file);
    files.push({ path, file, size, sha256 });
  }
  return files;
}

function add(found: Map<string, string>, path: string, file: string, given: string): void {
  const existing = found.get(path);
  if (existing !== undefined && existing !== file) {
    throw new CliError(
      "INVALID_PATH",
      `${given} would put a second file at ${JSON.stringify(path)} (already taken by ${existing}).`,
      "Publish paths that do not overlap, or publish the directory that holds them.",
    );
  }
  found.set(path, file);
}

async function walk(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      files.push(...(await walk(join(directory, entry.name))));
    } else if (entry.isFile()) {
      if (SKIPPED_FILES.has(entry.name)) continue;
      files.push(join(directory, entry.name));
    }
  }
  return files;
}

const toDropPath = (relativePath: string) => relativePath.split(sep).join("/");

export function digest(file: string): Promise<{ size: number; sha256: string }> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    let size = 0;
    createReadStream(file)
      .on("data", (chunk: Buffer | string) => {
        size += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
        hash.update(chunk);
      })
      .on("error", reject)
      .on("end", () => resolvePromise({ size, sha256: hash.digest("hex") }));
  });
}
