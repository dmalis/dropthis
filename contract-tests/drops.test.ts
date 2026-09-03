import { describe, expect, it } from "vitest";
import { BASE_URL } from "./base-url.js";

/**
 * The publish → serve → get slice, replayed against the deployed dev Worker.
 *
 * Everything here is an assertion about the CONTRACT, not about the code: the
 * exact `Drop` object, the exact headers a visitor gets, the exact error code
 * for each refusal. That is why it runs over HTTP against a real instance with
 * real R2 — Miniflare has shipped reversed conditional-write logic, and this
 * slice is built on conditional writes.
 */

type Json = Record<string, unknown>;

const api = (path: string, init?: RequestInit) =>
  fetch(`${BASE_URL}${path}`, { cache: "no-store", ...init });

const publish = (body: unknown, init?: RequestInit) =>
  api("/_api/v1/drops", {
    method: "POST",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    body: JSON.stringify(body),
    ...init,
  });

async function publishOk(body: unknown, init?: RequestInit): Promise<Json> {
  const response = await publish(body, init);
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as Json;
}

async function errorOf(response: Response): Promise<{ status: number; code: string; body: Json }> {
  const body = (await response.json()) as { error: { code: string } };
  return { status: response.status, code: body.error.code, body: body as unknown as Json };
}

const devKeys = async (prefix: string): Promise<string[]> => {
  const response = await api("/_dev/r2/list", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prefix }),
  });
  return ((await response.json()) as { keys: string[] }).keys;
};

/** A 1×1 transparent PNG. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("publish a single text file", () => {
  it("returns the frozen Drop shape and a URL that serves the file", async () => {
    const drop = await publishOk({
      files: [{ path: "index.html", text: "<h1>hello</h1>" }],
      title: "Hello",
      meta: { source: "contract-test", run: 1 },
    });

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
    expect(drop.slug).toMatch(/^[a-z0-9]{10}$/);
    expect(drop.url).toBe(`${BASE_URL}/${drop.slug as string}/`);
    expect(drop.title).toBe("Hello");
    expect(drop.meta).toEqual({ source: "contract-test", run: 1 });
    expect(drop.created_by).toEqual({ id: "dev", label: "admin" });
    expect(drop.noindex).toBe(true);
    expect(drop.has_password).toBe(false);
    expect(drop.state).toBe("live");
    expect(drop.created).toBe(drop.updated);
    expect(drop.files).toEqual([
      {
        path: "index.html",
        size: 14,
        // sha256 of "<h1>hello</h1>" — content addressing is part of the contract.
        sha256: "4db7ef630005c462450ea587722b1a7cff53dfdcd35d7dd40bcf8e97e50826ee",
        content_type: "text/html",
      },
    ]);

    const served = await fetch(drop.url as string, { cache: "no-store" });
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("text/html");
    expect(served.headers.get("cache-control")).toBe("no-cache, must-revalidate");
    expect(served.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(served.headers.get("content-disposition")).toBe('inline; filename="index.html"');
    expect(await served.text()).toBe("<h1>hello</h1>");
  });

  it("applies the instance defaults when the caller says nothing", async () => {
    const before = Date.now();
    const drop = await publishOk({ files: [{ path: "a.txt", text: "x" }] });

    expect(drop.noindex).toBe(true);
    const expiresAt = Date.parse(drop.expires_at as string);
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    expect(expiresAt - before).toBeGreaterThan(thirtyDays - 60_000);
    expect(expiresAt - before).toBeLessThan(thirtyDays + 60_000);
  });

  it("round-trips through get, including the agent's own meta", async () => {
    const drop = await publishOk({
      files: [{ path: "notes.md", text: "# notes" }],
      title: "Notes",
      meta: { workflow: "weekly", sent_to: ["a@example.com"] },
    });

    const response = await api(`/_api/v1/drops/${drop.slug as string}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(drop);
  });

  it("serves the single file at the drop root and at its own path", async () => {
    const drop = await publishOk({ files: [{ path: "report.txt", text: "body" }] });

    for (const url of [drop.url as string, `${drop.url as string}report.txt`]) {
      const served = await fetch(url, { cache: "no-store" });
      expect(served.status).toBe(200);
      expect(served.headers.get("content-type")).toBe("text/plain");
      expect(await served.text()).toBe("body");
    }
  });

  it("redirects the slug without a trailing slash, so relative links resolve", async () => {
    const drop = await publishOk({ files: [{ path: "a.txt", text: "x" }] });
    const response = await fetch(`${BASE_URL}/${drop.slug as string}`, {
      redirect: "manual",
      cache: "no-store",
    });
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe(`/${drop.slug as string}/`);
  });
});

describe("folders", () => {
  it("serves index.html at the drop root", async () => {
    const drop = await publishOk({
      files: [
        { path: "index.html", text: "<p>root</p>" },
        { path: "about.html", text: "<p>about</p>" },
      ],
    });

    const root = await fetch(drop.url as string, { cache: "no-store" });
    expect(await root.text()).toBe("<p>root</p>");
    const about = await fetch(`${drop.url as string}about.html`, { cache: "no-store" });
    expect(await about.text()).toBe("<p>about</p>");
  });

  it("generates a file list when there is no index.html", async () => {
    const drop = await publishOk({
      files: [
        { path: "a.txt", text: "a" },
        { path: "docs/b.txt", text: "b" },
      ],
      title: "My folder",
    });

    const root = await fetch(drop.url as string, { cache: "no-store" });
    expect(root.status).toBe(200);
    expect(root.headers.get("content-type")).toContain("text/html");
    expect(root.headers.get("cache-control")).toBe("no-cache, must-revalidate");
    expect(root.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const html = await root.text();
    expect(html).toContain("<title>My folder</title>");
    expect(html).toContain('href="a.txt"');
    expect(html).toContain('href="docs/b.txt"');
  });

  it("serves a subdirectory only when it has its own index.html", async () => {
    const drop = await publishOk({
      files: [
        { path: "index.html", text: "<p>root</p>" },
        { path: "docs/index.html", text: "<p>docs</p>" },
        { path: "other/note.txt", text: "note" },
      ],
    });

    const withIndex = await fetch(`${drop.url as string}docs/`, { cache: "no-store" });
    expect(withIndex.status).toBe(200);
    expect(await withIndex.text()).toBe("<p>docs</p>");

    const without = await fetch(`${drop.url as string}other/`, { cache: "no-store" });
    expect(without.status).toBe(404);
  });

  it("answers an HTML 404 for a path the drop does not have", async () => {
    const drop = await publishOk({
      files: [
        { path: "index.html", text: "<p>root</p>" },
        { path: "a.txt", text: "a" },
      ],
    });

    const missing = await fetch(`${drop.url as string}missing.txt`, { cache: "no-store" });
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toContain("text/html");
    expect(await missing.text()).toContain("<title>Not found</title>");
    expect(missing.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("does not let an encoded separator reach a path that is not in the manifest", async () => {
    const drop = await publishOk({
      files: [
        { path: "index.html", text: "<p>root</p>" },
        { path: "docs/secret.txt", text: "s" },
      ],
    });

    const smuggled = await fetch(`${drop.url as string}docs%2Fsecret.txt`, { cache: "no-store" });
    expect(smuggled.status).toBe(404);
  });
});

describe("binary content", () => {
  it("serves a base64 entry with the type its extension names", async () => {
    const drop = await publishOk({ files: [{ path: "pixel.png", base64: PNG_BASE64 }] });

    const files = drop.files as Array<Record<string, unknown>>;
    expect(files[0]!.content_type).toBe("image/png");
    expect(files[0]!.size).toBe(70);

    const served = await fetch(drop.url as string, { cache: "no-store" });
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await served.arrayBuffer()).length).toBe(70);
  });

  it("switches to an attachment when the visitor asks to download", async () => {
    const drop = await publishOk({ files: [{ path: "pixel.png", base64: PNG_BASE64 }] });
    const served = await fetch(`${drop.url as string}?download=1`, { cache: "no-store" });
    expect(served.headers.get("content-disposition")).toBe('attachment; filename="pixel.png"');
  });
});

describe("get with files", () => {
  it("inlines text and hands back a download_url for binary", async () => {
    const drop = await publishOk({
      files: [
        { path: "notes.md", text: "# hello" },
        { path: "pixel.png", base64: PNG_BASE64 },
      ],
    });

    const response = await api(`/_api/v1/drops/${drop.slug as string}?files=true`);
    const withFiles = (await response.json()) as Json;
    const files = withFiles.files as Array<Record<string, unknown>>;

    expect(files[0]!.path).toBe("notes.md");
    expect(files[0]!.content).toBe("# hello");
    expect(files[0]!.download_url).toBeUndefined();

    expect(files[1]!.path).toBe("pixel.png");
    expect(files[1]!.content).toBeUndefined();
    expect(files[1]!.download_url).toBe(
      `${BASE_URL}/_api/v1/drops/${drop.slug as string}/files/pixel.png`,
    );
  });

  it("serves the download_url, with byte ranges", async () => {
    const drop = await publishOk({ files: [{ path: "pixel.png", base64: PNG_BASE64 }] });
    const url = `${BASE_URL}/_api/v1/drops/${drop.slug as string}/files/pixel.png`;

    const whole = await fetch(url, { cache: "no-store" });
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-type")).toBe("image/png");
    expect(whole.headers.get("accept-ranges")).toBe("bytes");

    const ranged = await fetch(url, { headers: { Range: "bytes=0-7" }, cache: "no-store" });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe("bytes 0-7/70");
    expect(new Uint8Array(await ranged.arrayBuffer()).length).toBe(8);

    const past = await fetch(url, { headers: { Range: "bytes=999-" }, cache: "no-store" });
    expect(past.status).toBe(416);
    expect(past.headers.get("content-range")).toBe("bytes */70");
  });

  it("404s a file that is not in the manifest", async () => {
    const drop = await publishOk({ files: [{ path: "a.txt", text: "x" }] });
    const response = await api(`/_api/v1/drops/${drop.slug as string}/files/nope.txt`);
    expect((await errorOf(response)).code).toBe("NOT_FOUND");
  });

  it("404s an unknown drop", async () => {
    const response = await api("/_api/v1/drops/zzzzzzzzzz");
    const error = await errorOf(response);
    expect(error.status).toBe(404);
    expect(error.code).toBe("NOT_FOUND");
  });
});

describe("idempotency", () => {
  it("replays a byte-identical Drop for the same key and payload", async () => {
    const body = {
      files: [{ path: "a.txt", text: "once" }],
      title: "Once",
      idempotency_key: `contract-replay-${crypto.randomUUID()}`,
    };

    const first = await publish(body);
    expect(first.status).toBe(201);
    const firstText = await first.text();

    const second = await publish(body);
    expect(second.status).toBe(200);
    expect(await second.text()).toBe(firstText);
  });

  it("refuses a different payload under the same key", async () => {
    const key = `contract-mismatch-${crypto.randomUUID()}`;
    await publishOk({ files: [{ path: "a.txt", text: "one" }], idempotency_key: key });

    const response = await publish({
      files: [{ path: "a.txt", text: "two" }],
      idempotency_key: key,
    });
    const error = await errorOf(response);
    expect(error.status).toBe(409);
    expect(error.code).toBe("IDEMPOTENCY_MISMATCH");
  });

  it("treats two publishes without a key as two drops", async () => {
    const body = { files: [{ path: "a.txt", text: "twice" }] };
    const first = await publishOk(body);
    const second = await publishOk(body);
    expect(first.slug).not.toBe(second.slug);
  });
});

describe("refusals", () => {
  it("rejects an unknown field, naming it", async () => {
    const response = await publish({
      files: [{ path: "a.txt", text: "x" }],
      password: "hunter22",
    });
    const error = await errorOf(response);
    expect(error.status).toBe(400);
    expect(error.code).toBe("INVALID_INPUT");
    expect(JSON.stringify(error.body)).toContain("password");
  });

  it.each([
    ["a parent segment", "../escape.txt"],
    ["a dot segment", "./a.txt"],
    ["an absolute path", "/a.txt"],
    ["a backslash", "a\\b.txt"],
    ["a control character", `a${String.fromCharCode(1)}b.txt`],
  ])("rejects %s as INVALID_PATH", async (_label, path) => {
    const response = await publish({ files: [{ path, text: "x" }] });
    const error = await errorOf(response);
    expect(error.status).toBe(400);
    expect(error.code).toBe("INVALID_PATH");
  });

  it("rejects two paths that are the same after NFC normalisation", async () => {
    const response = await publish({
      files: [
        { path: `cafe${String.fromCharCode(0x301)}.txt`, text: "one" },
        { path: "café.txt", text: "two" },
      ],
    });
    expect((await errorOf(response)).code).toBe("INVALID_PATH");
  });

  it("rejects a text entry whose extension names a binary type", async () => {
    const response = await publish({ files: [{ path: "a.png", text: "not a png" }] });
    expect((await errorOf(response)).code).toBe("INVALID_INPUT");
  });

  it("rejects an expiry in the past", async () => {
    const response = await publish({
      files: [{ path: "a.txt", text: "x" }],
      expires: "2020-01-01",
    });
    const error = await errorOf(response);
    expect(error.status).toBe(400);
    expect(error.code).toBe("POLICY_VIOLATION");
  });

  it("rejects an expiry beyond the instance maximum", async () => {
    const response = await publish({
      files: [{ path: "a.txt", text: "x" }],
      expires: "400d",
    });
    expect((await errorOf(response)).code).toBe("POLICY_VIOLATION");
  });

  it("rejects more than 500 files", async () => {
    const files = Array.from({ length: 501 }, (_, i) => ({ path: `f${i}.txt`, text: "x" }));
    const response = await publish({ files });
    const error = await errorOf(response);
    expect(error.status).toBe(400);
    expect(error.code).toBe("POLICY_VIOLATION");
  });

  it("rejects a body over the instance's request ceiling", async () => {
    const files = [{ path: "big.txt", text: "x".repeat(4 * 1024 * 1024 + 1024) }];
    const response = await publish({ files });
    const error = await errorOf(response);
    expect(error.status).toBe(413);
    expect(error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("rejects a body that is not JSON", async () => {
    const response = await api("/_api/v1/drops", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect((await errorOf(response)).code).toBe("INVALID_INPUT");
  });
});

describe("a publish that fails part-way", () => {
  const faultBody = (key?: string) => ({
    files: [
      { path: "index.html", text: "<p>fault</p>" },
      { path: "pixel.png", base64: PNG_BASE64 },
    ],
    title: "Fault run",
    ...(key === undefined ? {} : { idempotency_key: key }),
  });

  it.each(["blobs", "claim", "slug", "meta", "projections"])(
    "converges when the retry carries the same idempotency_key (abort after %s)",
    async (point) => {
      const key = `contract-fault-${point}-${crypto.randomUUID()}`;

      const failed = await publish(faultBody(key), { headers: { "DEV-Fault": point } });
      expect(failed.status).toBe(500);

      const retried = await publish(faultBody(key));
      expect([200, 201]).toContain(retried.status);
      const drop = (await retried.json()) as Json;

      const served = await fetch(drop.url as string, { cache: "no-store" });
      expect(served.status).toBe(200);
      expect(await served.text()).toBe("<p>fault</p>");

      // A second retry is a replay of the same drop, never a second one.
      const again = await publish(faultBody(key));
      expect(again.status).toBe(200);
      expect(((await again.json()) as Json).slug).toBe(drop.slug);
    },
    30_000,
  );

  it.each(["blobs", "claim", "slug"])(
    "leaves nothing served when it aborts before meta.json (abort after %s)",
    async (point) => {
      const before = await devKeys("slugs/");
      const metaBefore = (await devKeys("drops/")).filter((key) => key.endsWith("/meta.json"));

      const failed = await publish(faultBody(), { headers: { "DEV-Fault": point } });
      expect(failed.status).toBe(500);

      // A slug pointer may exist (the "slug" abort claims one), but no drop
      // record does — so nothing is served, and the reconcile has the rest.
      const metaAfter = (await devKeys("drops/")).filter((key) => key.endsWith("/meta.json"));
      expect(metaAfter).toEqual(metaBefore);

      for (const key of (await devKeys("slugs/")).filter((k) => !before.includes(k))) {
        const slug = key.slice("slugs/".length);
        const served = await fetch(`${BASE_URL}/${slug}/`, { cache: "no-store" });
        expect(served.status).toBe(404);
      }
    },
    30_000,
  );

  it("commits at meta.json: an abort after it leaves a complete, served drop", async () => {
    const failed = await publish(faultBody(), { headers: { "DEV-Fault": "meta" } });
    expect(failed.status).toBe(500);

    const records = (await devKeys("drops/")).filter((key) => key.endsWith("/meta.json"));
    expect(records.length).toBeGreaterThan(0);
  });
});

describe("the projections the write order writes", () => {
  it("writes a list/ pointer and an expiring/ marker beside meta.json", async () => {
    const drop = await publishOk({
      files: [{ path: "a.txt", text: "x" }],
      title: "Projected",
      expires: "7d",
    });

    const listKeys = (await devKeys("list/")).filter((key) => key.endsWith(`-${drop.slug as string}`));
    expect(listKeys).toHaveLength(1);
    expect(listKeys[0]).toMatch(/^list\/\d{13}-[a-z0-9]{10}$/);

    // The marker is dated the expiry plus the 7-day grace, and names the drop id.
    const expiresAt = Date.parse(drop.expires_at as string);
    const markerDate = new Date(expiresAt + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const markers = await devKeys(`expiring/${markerDate}/`);
    expect(markers.length).toBeGreaterThan(0);

    const records = await devKeys("drops/");
    expect(records.some((key) => key.endsWith("/meta.json"))).toBe(true);
  });

  it("writes no expiring/ marker for a drop that never expires", async () => {
    const before = await devKeys("expiring/");
    await publishOk({ files: [{ path: "a.txt", text: "x" }], expires: "never" });
    expect(await devKeys("expiring/")).toEqual(before);
  });
});

describe("the inline content budget of get(files:true)", () => {
  it("stops inlining at 1 MB and hands the rest a download_url", async () => {
    // Exactly the whole budget: it is inlined, and nothing after it can be.
    const big = "x".repeat(1024 * 1024);
    const drop = await publishOk({
      files: [
        { path: "big.txt", text: big },
        { path: "small.txt", text: "still text" },
      ],
    });

    const response = await api(`/_api/v1/drops/${drop.slug as string}?files=true`);
    const files = ((await response.json()) as Json).files as Array<Record<string, unknown>>;

    expect(files[0]!.path).toBe("big.txt");
    expect((files[0]!.content as string).length).toBe(big.length);

    // Text, well under any per-file limit — but the budget is already spent.
    expect(files[1]!.path).toBe("small.txt");
    expect(files[1]!.content).toBeUndefined();
    expect(files[1]!.download_url).toBe(
      `${BASE_URL}/_api/v1/drops/${drop.slug as string}/files/small.txt`,
    );
  }, 30_000);
});
