import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { saveInstance } from "../../src/init/instances-file.js";
import { instancesPath } from "../../src/cli/credentials.js";
import { readInstancesFile } from "../../src/cli/run.js";

async function home(): Promise<Record<string, string>> {
  const dir = await mkdtemp(join(tmpdir(), "dropthis-instances-"));
  return { HOME: dir, XDG_CONFIG_HOME: join(dir, ".config") };
}

describe("saveInstance", () => {
  it("writes a first instance as the default, mode 600, and the CLI reader accepts it", async () => {
    const env = await home();

    const saved = await saveInstance(env, "main", { url: "https://a.workers.dev", key: "k1" });

    expect(saved.path).toBe(instancesPath(env));
    expect(saved.isDefault).toBe(true);
    const file = await readInstancesFile(env);
    expect(file).toEqual({ default: "main", instances: { main: { url: "https://a.workers.dev", key: "k1" } } });
    expect((await stat(saved.path)).mode & 0o777).toBe(0o600);
  });

  it("merges a second instance without stealing the default", async () => {
    const env = await home();
    await saveInstance(env, "main", { url: "https://a.workers.dev", key: "k1" });

    const saved = await saveInstance(env, "byrokko", { url: "https://b.workers.dev", key: "k2" });

    expect(saved.isDefault).toBe(false);
    const file = await readInstancesFile(env);
    expect(file?.default).toBe("main");
    expect(Object.keys(file!.instances).sort()).toEqual(["byrokko", "main"]);
  });

  it("replaces the stored key of an existing instance (rotation) and keeps the rest", async () => {
    const env = await home();
    await saveInstance(env, "main", { url: "https://a.workers.dev", key: "old" });
    await saveInstance(env, "other", { url: "https://o.workers.dev", key: "k" });

    await saveInstance(env, "main", { url: "https://a.workers.dev", key: "new" });

    const file = await readInstancesFile(env);
    expect(file?.instances.main).toEqual({ url: "https://a.workers.dev", key: "new" });
    expect(file?.instances.other).toEqual({ url: "https://o.workers.dev", key: "k" });
    expect(file?.default).toBe("main");
  });

  it("refuses a corrupt file rather than overwriting other instances' keys", async () => {
    const env = await home();
    const path = instancesPath(env);
    await mkdir(join(env.XDG_CONFIG_HOME!, "dropthis"), { recursive: true });
    await writeFile(path, "not json", "utf8");

    // A corrupt file is not silently discarded: the writer refuses rather than
    // dropping instances a human may still need.
    await expect(saveInstance(env, "main", { url: "https://a.workers.dev", key: "k" })).rejects.toThrow(
      /instances.json/,
    );
    expect(await readFile(path, "utf8")).toBe("not json");
  });
});
