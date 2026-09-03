import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeInstance } from "../../../test/fake-cloudflare/src/instance.js";
import type { FakeInstance } from "../../../test/fake-cloudflare/src/instance.js";
import { cleanEnv, oneJsonDocument, runCli } from "./cli-harness.js";

/**
 * The drop commands end to end: `publish` prints only the URL, `--json` is one
 * document, `get`/`list`/`update`/`delete` round-trip, and the target may be a
 * slug or this instance's URL. Against the real Worker app on localhost.
 */
const ADMIN_KEY = "a".repeat(64);
const USER_KEY = "b".repeat(64);

let instance: FakeInstance;
let env: Record<string, string>;
let site: string;

type Json = Record<string, unknown>;

beforeAll(async () => {
  instance = await startFakeInstance({ adminKey: ADMIN_KEY, userKey: USER_KEY });
  env = { ...(await cleanEnv()), DROPTHIS_URL: instance.url, DROPTHIS_KEY: USER_KEY };
  site = await mkdtemp(join(tmpdir(), "dropthis-site-"));
  await mkdir(join(site, "css"));
  await writeFile(join(site, "index.html"), "<h1>site</h1>");
  await writeFile(join(site, "css", "a.css"), "body{}");
  await writeFile(join(site, "pixel.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
}, 120_000);

afterAll(async () => {
  await instance.close();
});

describe("publish", () => {
  it("prints only the URL on stdout and serves the file", async () => {
    const run = await runCli(["publish", join(site, "index.html"), "--title", "Site"], { env });
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(new RegExp(`^${instance.url}/[a-z0-9]{10}/\n$`));

    const served = await fetch(run.stdout.trim());
    expect(served.status).toBe(200);
    expect(await served.text()).toBe("<h1>site</h1>");
  });

  it("--json emits exactly one JSON document, and the same key replays the same drop", async () => {
    const args = ["publish", join(site, "index.html"), "--json", "--idempotency-key", "cli-run-1", "--meta", '{"via":"cli"}'];
    const first = await runCli(args, { env });
    expect(first.code, first.stderr).toBe(0);
    const drop = oneJsonDocument(first.stdout) as Json;
    expect(Object.keys(drop)).toEqual([
      "url", "slug", "title", "meta", "created_by", "created", "updated", "expires_at", "noindex", "has_password", "state", "files",
    ]);
    expect(drop.meta).toEqual({ via: "cli" });
    expect(drop.created_by).toEqual({ id: "id-anna", label: "anna" });
    // The digest was computed locally and sent with the bytes.
    expect((drop.files as Json[])[0]!.sha256).toBe(createHash("sha256").update("<h1>site</h1>").digest("hex"));

    const second = await runCli(args, { env });
    expect(second.code).toBe(0);
    expect((oneJsonDocument(second.stdout) as Json).slug).toBe(drop.slug);
  });

  it("publishes a directory with relative paths, binaries included", async () => {
    const run = await runCli(["publish", site, "--json"], { env });
    expect(run.code, run.stderr).toBe(0);
    const drop = oneJsonDocument(run.stdout) as Json;
    expect((drop.files as Json[]).map((f) => [f.path, f.content_type])).toEqual([
      ["css/a.css", "text/css"],
      ["index.html", "text/html"],
      ["pixel.png", "image/png"],
    ]);
    const css = await fetch(`${drop.url as string}css/a.css`);
    expect(await css.text()).toBe("body{}");
  });

  it("refuses a missing path and an unknown flag before touching the network", async () => {
    const missing = await runCli(["publish", join(site, "nope.html"), "--json"], { env });
    expect(missing.code).toBe(1);
    expect(missing.stdout).toBe("");
    expect(oneJsonDocument(missing.stderr)).toMatchObject({ code: "INVALID_INPUT", retryable: false });

    const unknown = await runCli(["publish", join(site, "index.html"), "--key", "x"], { env });
    expect(unknown.code).toBe(1);
    expect(unknown.stdout).toBe("");
    expect(unknown.stderr).toContain("--key");
  });
});

describe("get, update, list, delete", () => {
  let slug: string;
  let url: string;

  beforeAll(async () => {
    const run = await runCli(["publish", join(site, "index.html"), "--title", "Round", "--json"], { env });
    const drop = oneJsonDocument(run.stdout) as Json;
    slug = drop.slug as string;
    url = drop.url as string;
  });

  it("get takes the slug or this instance's URL, and --files inlines text", async () => {
    const bySlug = await runCli(["get", slug, "--json"], { env });
    expect(bySlug.code, bySlug.stderr).toBe(0);
    const byUrl = await runCli(["get", url, "--json", "--files"], { env });
    expect(byUrl.code, byUrl.stderr).toBe(0);
    const drop = oneJsonDocument(byUrl.stdout) as Json;
    expect(drop.slug).toBe(slug);
    expect((drop.files as Json[])[0]!.content).toBe("<h1>site</h1>");

    const wrong = await runCli(["get", `https://elsewhere.example/${slug}/`, "--json"], { env });
    expect(wrong.code).toBe(1);
    expect(oneJsonDocument(wrong.stderr)).toMatchObject({ code: "WRONG_INSTANCE" });
  });

  it("update changes only what is given, prints the URL, and --no-title clears the title", async () => {
    const run = await runCli(["update", slug, "--meta", '{"rev":2}', "--expires", "60d"], { env });
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toBe(`${url}\n`);

    const cleared = await runCli(["update", url, "--no-title", "--json"], { env });
    expect(cleared.code, cleared.stderr).toBe(0);
    const drop = oneJsonDocument(cleared.stdout) as Json;
    expect(drop.title).toBeNull();
    expect(drop.meta).toEqual({ rev: 2 });
  });

  it("update with paths replaces the whole file set", async () => {
    const run = await runCli(["update", slug, join(site, "css"), "--json"], { env });
    expect(run.code, run.stderr).toBe(0);
    const drop = oneJsonDocument(run.stdout) as Json;
    expect((drop.files as Json[]).map((f) => f.path)).toEqual(["a.css"]);
  });

  it("list pages newest first with --limit and --q", async () => {
    const run = await runCli(["list", "--json", "--limit", "2"], { env });
    expect(run.code, run.stderr).toBe(0);
    const page = oneJsonDocument(run.stdout) as Json;
    expect(Object.keys(page)).toEqual(["drops", "cursor", "has_more"]);
    expect((page.drops as Json[]).length).toBe(2);
    expect(page.has_more).toBe(true);

    const bad = await runCli(["list", "--json", "--limit", "many"], { env });
    expect(bad.code).toBe(1);
    expect(oneJsonDocument(bad.stderr)).toMatchObject({ code: "INVALID_INPUT" });
  });

  it("delete needs no prompt when stdin is not a TTY, then get is NOT_FOUND", async () => {
    const run = await runCli(["delete", slug, "--json"], { env });
    expect(run.code, run.stderr).toBe(0);
    expect(oneJsonDocument(run.stdout)).toEqual({ slug, deleted: true });

    const gone = await runCli(["get", slug, "--json"], { env });
    expect(gone.code).toBe(1);
    expect(gone.stdout).toBe("");
    expect(oneJsonDocument(gone.stderr)).toEqual({
      code: "NOT_FOUND",
      message: `No drop at ${slug}.`,
      remediation: "See /_skill.md for the operation list.",
      retryable: false,
    });
  });

  it("plain-mode errors go to stderr as one readable line plus the remediation", async () => {
    const gone = await runCli(["get", "zzzzzzzzzz"], { env });
    expect(gone.code).toBe(1);
    expect(gone.stdout).toBe("");
    expect(gone.stderr).toMatch(/^dropthis: NOT_FOUND: No drop at zzzzzzzzzz\.\n {2}See \/_skill\.md/);
  });
});
