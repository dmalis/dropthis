import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeInstance } from "../../../test/fake-cloudflare/src/instance.js";
import type { FakeInstance } from "../../../test/fake-cloudflare/src/instance.js";
import { cleanEnv, oneJsonDocument, runCli } from "./cli-harness.js";

/**
 * Path selection through the binary: a payload over the packaged ceiling
 * stages (session → PUTs → commit), and an instance whose ceiling is BELOW the
 * default answers PAYLOAD_TOO_LARGE to the inline attempt and the CLI falls
 * back on its own. The bytes served are the bytes on disk. R2's digest check
 * is the contract test's; here the in-memory bucket stores what it is given.
 */
const ADMIN_KEY = "a".repeat(64);

let instance: FakeInstance;
let small: FakeInstance;
let env: Record<string, string>;
let dir: string;
let big: Buffer;
let bigPath: string;

type Json = Record<string, unknown>;

beforeAll(async () => {
  instance = await startFakeInstance({ adminKey: ADMIN_KEY });
  small = await startFakeInstance({ adminKey: ADMIN_KEY, policy: { max_request_bytes: 64 * 1024 } });
  env = { ...(await cleanEnv()), DROPTHIS_URL: instance.url, DROPTHIS_KEY: ADMIN_KEY };
  dir = await mkdtemp(join(tmpdir(), "dropthis-staged-"));
  big = randomBytes(5 * 1024 * 1024);
  bigPath = join(dir, "big.bin");
  await writeFile(bigPath, big);
  await writeFile(join(dir, "index.html"), "<h1>big</h1>");
}, 120_000);

afterAll(async () => {
  await instance.close();
  await small.close();
});

describe("staged publish", () => {
  it("a 5 MiB file goes through a session and serves identical bytes", async () => {
    const run = await runCli(["publish", dir, "--json", "--title", "Big"], { env });
    expect(run.code, run.stderr).toBe(0);
    const drop = oneJsonDocument(run.stdout) as Json;
    const digest = createHash("sha256").update(big).digest("hex");
    expect((drop.files as Json[]).find((f) => f.path === "big.bin")).toMatchObject({ size: big.length, sha256: digest });

    const sessions = instance.bucket.keys("uploads/");
    expect(sessions.some((key) => key.endsWith("/session.json"))).toBe(true);
    expect(sessions.some((key) => key.endsWith("/commit"))).toBe(true);

    const served = await fetch(`${drop.url as string}big.bin`);
    expect(served.status).toBe(200);
    expect(Buffer.from(await served.arrayBuffer()).equals(big)).toBe(true);
  });

  it("re-running with the same idempotency key replays the drop instead of making a second one", async () => {
    const args = ["publish", bigPath, "--json", "--idempotency-key", "big-run"];
    const first = await runCli(args, { env });
    expect(first.code, first.stderr).toBe(0);
    const second = await runCli(args, { env });
    expect(second.code, second.stderr).toBe(0);
    expect((oneJsonDocument(second.stdout) as Json).slug).toBe((oneJsonDocument(first.stdout) as Json).slug);
  });

  it("falls back to staged when the instance's ceiling is below the packaged default", async () => {
    const run = await runCli(["publish", join(dir, "index.html"), bigPath.replace("big.bin", "index.html"), "--json"], {
      env: { ...env, DROPTHIS_URL: small.url },
    });
    expect(run.code, run.stderr).toBe(0);
    // 64 KB ceiling, a 100 KB payload: inline was refused, staged succeeded.
    const medium = randomBytes(100 * 1024);
    const mediumPath = join(dir, "medium.bin");
    await writeFile(mediumPath, medium);
    const staged = await runCli(["publish", mediumPath, "--json"], { env: { ...env, DROPTHIS_URL: small.url } });
    expect(staged.code, staged.stderr).toBe(0);
    expect(small.bucket.keys("uploads/").some((key) => key.endsWith("/commit"))).toBe(true);
    const served = await fetch(`${(oneJsonDocument(staged.stdout) as Json).url as string}medium.bin`);
    expect(Buffer.from(await served.arrayBuffer()).equals(medium)).toBe(true);
  });

  it("update by staging replaces the files of an existing drop", async () => {
    const first = await runCli(["publish", join(dir, "index.html"), "--json"], { env });
    const slug = (oneJsonDocument(first.stdout) as Json).slug as string;
    const updated = await runCli(["update", slug, dir, "--json"], { env });
    expect(updated.code, updated.stderr).toBe(0);
    const drop = oneJsonDocument(updated.stdout) as Json;
    expect((drop.files as Json[]).map((f) => f.path)).toEqual(["big.bin", "index.html", "medium.bin"]);
  });
});
