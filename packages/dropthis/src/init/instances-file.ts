/**
 * The writer for `~/.config/dropthis/instances.json` — the file
 * `cli/credentials.ts` reads. `init` is the only thing that writes it.
 *
 * Atomic (temp + rename in the same directory, so the rename cannot cross a
 * filesystem), mode 600 (it holds instance keys), and a merge, never a
 * replace: an operator hosting several clients keeps every instance in this
 * one file and a rerun of `init --name client-x` must not lose the others.
 *
 * A file that does not parse is an error, not something to overwrite: it may
 * still hold the only copy of keys for instances this run knows nothing about.
 */
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { instancesPath } from "../cli/credentials.js";
import type { Env, InstanceEntry, InstancesFile } from "../cli/credentials.js";

export type SaveResult = { path: string; isDefault: boolean };

export async function saveInstance(env: Env, name: string, entry: InstanceEntry): Promise<SaveResult> {
  const path = instancesPath(env);
  const existing = await readExisting(path);

  const instances = { ...existing.instances, [name]: entry };
  // The first instance an operator installs is the one every later command
  // uses when nothing selects one (AGENTS.md, "CLI conventions"). A later
  // instance never takes that over: which one is default is the operator's.
  const defaultName = existing.default ?? name;
  const file: InstancesFile = { default: defaultName, instances };

  await mkdir(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.instances.json.${process.pid}.tmp`);
  try {
    await writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }

  return { path, isDefault: defaultName === name };
}

async function readExisting(path: string): Promise<Partial<InstancesFile>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error(
      `${path} is not valid JSON; refusing to overwrite it because it may hold the only copy of other instances' keys.`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`${path} is not a JSON object; refusing to overwrite it.`);
  }
  const file = parsed as Partial<InstancesFile>;
  return {
    instances: typeof file.instances === "object" && file.instances !== null ? file.instances : {},
    ...(typeof file.default === "string" ? { default: file.default } : {}),
  };
}
