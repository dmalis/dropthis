import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeInstance } from "../../../test/fake-cloudflare/src/instance.js";
import type { FakeInstance } from "../../../test/fake-cloudflare/src/instance.js";
import { cleanEnv, oneJsonDocument, runCli } from "./cli-harness.js";

/**
 * Credentials through the binary: the env pair beats instances.json, the
 * file's instances are selectable and an unknown one is named, no credentials
 * at all is exit 4 with the two variables in the remediation, and a refused
 * key is exit 4 too. Two instances so "which one answered" is observable.
 */
const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

let a: FakeInstance;
let b: FakeInstance;
let base: Record<string, string>;

beforeAll(async () => {
  a = await startFakeInstance({ adminKey: KEY_A });
  b = await startFakeInstance({ adminKey: KEY_B });
  base = await cleanEnv();
  const file = join(base.XDG_CONFIG_HOME!, "dropthis", "instances.json");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({
      default: "alpha",
      instances: { alpha: { url: a.url, key: KEY_A }, beta: { url: b.url, key: KEY_B } },
    }),
  );
}, 120_000);

afterAll(async () => {
  await a.close();
  await b.close();
});

const whoAnswered = async (env: Record<string, string>, extra: string[] = []) => {
  const run = await runCli(["config", "get", "--json", ...extra], { env });
  expect(run.code, run.stderr).toBe(0);
  return (oneJsonDocument(run.stdout) as { canonical_url: string }).canonical_url;
};

describe("credential resolution through the binary", () => {
  it("uses the file's default instance when the env says nothing", async () => {
    expect(await whoAnswered(base)).toBe(a.url);
  });

  it("--instance and DROPTHIS_INSTANCE select from the file", async () => {
    expect(await whoAnswered(base, ["--instance", "beta"])).toBe(b.url);
    expect(await whoAnswered({ ...base, DROPTHIS_INSTANCE: "beta" })).toBe(b.url);
    expect(await whoAnswered({ ...base, DROPTHIS_INSTANCE: "beta" }, ["--instance", "alpha"])).toBe(a.url);
  });

  it("the env pair wins over the file and over --instance", async () => {
    const env = { ...base, DROPTHIS_URL: b.url, DROPTHIS_KEY: KEY_B };
    expect(await whoAnswered(env, ["--instance", "alpha"])).toBe(b.url);
  });

  it("an unknown --instance exits 1 and names the known ones", async () => {
    const run = await runCli(["list", "--json", "--instance", "gamma"], { env: base });
    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    const error = oneJsonDocument(run.stderr) as { code: string; message: string };
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toContain("gamma");
    expect(error.message).toContain("alpha, beta");
  });

  it("no credentials, non-TTY → exit 4, remediation names DROPTHIS_URL and DROPTHIS_KEY", async () => {
    const run = await runCli(["list", "--json"], { env: await cleanEnv() });
    expect(run.code).toBe(4);
    expect(run.stdout).toBe("");
    const error = oneJsonDocument(run.stderr) as { code: string; remediation: string };
    expect(error.code).toBe("UNAUTHENTICATED");
    expect(error.remediation).toContain("DROPTHIS_URL");
    expect(error.remediation).toContain("DROPTHIS_KEY");
  });

  it("a key the instance refuses → exit 4 with the instance's own error", async () => {
    const run = await runCli(["list", "--json"], { env: { ...base, DROPTHIS_URL: a.url, DROPTHIS_KEY: "nope" } });
    expect(run.code).toBe(4);
    expect(oneJsonDocument(run.stderr)).toMatchObject({ code: "UNAUTHENTICATED", retryable: false });
  });

  it("never prints the key: not in --json output, not in an error", async () => {
    const ok = await runCli(["config", "get", "--json"], { env: base });
    const refused = await runCli(["list", "--json"], { env: { ...base, DROPTHIS_URL: a.url, DROPTHIS_KEY: "nope" } });
    for (const text of [ok.stdout, ok.stderr, refused.stdout, refused.stderr]) {
      expect(text).not.toContain(KEY_A);
      expect(text).not.toContain("nope");
    }
  });
});
