import { afterAll, describe, expect, it } from "vitest";
import { BASE_URL } from "./base-url.js";
import { api, apiJson, errorOf } from "./client.js";
import type { Json } from "./client.js";

/**
 * `url` file entries, against the deployed dev Worker (issue #15).
 *
 * These are the assertions no unit test can make: that the Worker's own fetch
 * reaches a public target, that R2 verifies a streamed digest and leaves the
 * key absent when it does not match, and that the caps answer the frozen
 * codes on a real instance.
 *
 * The target of most cases is another drop on this same instance — a public,
 * password-free URL that this run created, so nothing depends on a third
 * party being up. One case fetches a genuinely external image, because
 * "public" is the whole point of the feature.
 */

const publish = (body: unknown, init?: RequestInit) =>
  api("/_api/v1/drops", {
    ...init,
    method: "POST",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    body: JSON.stringify(body),
  });

async function publishOk(body: unknown, init?: RequestInit): Promise<Json> {
  const response = await publish(body, init);
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as Json;
}

const devKeys = async (prefix: string): Promise<string[]> => {
  const response = await apiJson("/_dev/r2/list", "POST", { prefix });
  return ((await response.json()) as { keys: string[] }).keys;
};

const sha256Of = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const filesOf = (drop: Json) => drop.files as Array<{ path: string; sha256: string; size: number; content_type: string }>;

/** One public source drop, published once and reused: every fetch target lives in it. */
const SOURCE_TEXT = "<h1>the source drop</h1>";
const OTHER_TEXT = "<h1>the other body</h1>";
/** Over the smallest `max_unhashed_bytes` policy allows (1024), so the cap is reachable. */
const BIG_TEXT = "x".repeat(2048);
/**
 * Its own body, and its own digest: the retry case DELETES the blob by digest,
 * and a digest shared with another drop would delete that drop's blob too.
 */
const RETRY_TEXT = `<h1>retry ${Date.now()}-${Math.random()}</h1>`;
let source: Json | undefined;

async function sourceUrls(): Promise<{
  one: string;
  two: string;
  big: string;
  retry: string;
  slug: string;
}> {
  if (source === undefined) {
    source = await publishOk({
      files: [
        { path: "one.html", text: SOURCE_TEXT },
        { path: "two.html", text: OTHER_TEXT },
        { path: "big.txt", text: BIG_TEXT },
        { path: "retry.html", text: RETRY_TEXT },
      ],
      title: "Fetch source",
      expires: "1d",
    });
  }
  const slug = source.slug as string;
  return {
    one: `${BASE_URL}/${slug}/one.html`,
    two: `${BASE_URL}/${slug}/two.html`,
    big: `${BASE_URL}/${slug}/big.txt`,
    retry: `${BASE_URL}/${slug}/retry.html`,
    slug,
  };
}

describe("publish with a url entry", () => {
  it("fetches the bytes, types them from the extension and serves them", async () => {
    const { one } = await sourceUrls();
    const drop = await publishOk({
      files: [
        { path: "index.html", text: '<a href="copy.html">copy</a>' },
        { path: "copy.html", url: one },
      ],
      title: "Fetched by url",
      expires: "1d",
    });

    const copy = filesOf(drop).find((file) => file.path === "copy.html")!;
    expect(copy.sha256).toBe(await sha256Of(SOURCE_TEXT));
    expect(copy.size).toBe(SOURCE_TEXT.length);
    expect(copy.content_type).toBe("text/html");

    const served = await fetch(`${drop.url as string}copy.html`, { cache: "no-store" });
    expect(served.status).toBe(200);
    expect(await served.text()).toBe(SOURCE_TEXT);
  });

  it("streams a url entry that carries its digest, and R2 verifies it", async () => {
    const { one } = await sourceUrls();
    const digest = await sha256Of(SOURCE_TEXT);
    const drop = await publishOk({
      files: [{ path: "copy.html", url: one, sha256: digest }],
      title: "Streamed by digest",
      expires: "1d",
    });
    expect(filesOf(drop)[0]!.sha256).toBe(digest);
    expect(await (await fetch(drop.url as string, { cache: "no-store" })).text()).toBe(SOURCE_TEXT);
  });

  it("refuses a wrong digest as HASH_MISMATCH and leaves no blob behind", async () => {
    const { one } = await sourceUrls();
    const wrong = "0".repeat(64);
    const refused = await publish({
      files: [{ path: "copy.html", url: one, sha256: wrong }],
      title: "Wrong digest",
    });
    const error = await errorOf(refused);
    expect(error.status).toBe(422);
    expect(error.code).toBe("HASH_MISMATCH");

    // The digest R2 rejects leaves the key absent: no drop holds it anywhere.
    const stray = (await devKeys("drops/")).filter((key) => key.endsWith(`/blobs/${wrong}`));
    expect(stray).toEqual([]);
  });

  it("answers FETCH_FAILED for a target that is not there", async () => {
    const { slug } = await sourceUrls();
    const error = await errorOf(
      await publish({ files: [{ path: "a.html", url: `${BASE_URL}/${slug}/missing.html` }] }),
    );
    expect(error.status).toBe(422);
    expect(error.code).toBe("FETCH_FAILED");
    expect(String((error.body.error as Json).message)).toContain("404");
  });

  it("answers FETCH_FAILED for a target this instance will never fetch", async () => {
    for (const url of ["http://169.254.169.254/latest/meta-data/", "file:///etc/passwd", "http://localhost/x"]) {
      const error = await errorOf(await publish({ files: [{ path: "a.html", url }] }));
      expect(error.code, url).toBe("FETCH_FAILED");
    }
  });

  it("refuses more url entries than one call may fetch", async () => {
    const { one } = await sourceUrls();
    const files = Array.from({ length: 21 }, (_, i) => ({ path: `a${i}.html`, url: one }));
    const error = await errorOf(await publish({ files }));
    expect(error.status).toBe(400);
    expect(error.code).toBe("INVALID_INPUT");
  });
});

describe("the undigested ceiling", () => {
  const restore = () =>
    apiJson("/_api/v1/config", "PATCH", { max_unhashed_bytes: 2 * 1024 * 1024 });
  afterAll(restore);

  it("refuses a body over max_unhashed_bytes when the caller sent no digest", async () => {
    const { big } = await sourceUrls();
    const tightened = await apiJson("/_api/v1/config", "PATCH", { max_unhashed_bytes: 1024 });
    expect(tightened.status, await tightened.clone().text()).toBe(200);

    // 2048 bytes with no sha256: the Worker would have to hash it itself.
    const error = await errorOf(await publish({ files: [{ path: "big.txt", url: big }] }));
    expect(error.status).toBe(413);
    expect(error.code).toBe("PAYLOAD_TOO_LARGE");

    // The same body WITH a digest streams past the same cap: R2 verifies it.
    const digest = await sha256Of(BIG_TEXT);
    const ok = await publishOk({
      files: [{ path: "big.txt", url: big, sha256: digest }],
      title: "Digested past the cap",
      expires: "1d",
    });
    expect(filesOf(ok)[0]!.size).toBe(2048);
    await restore();
  });
});

describe("update with url entries", () => {
  it("keeps an unchanged url entry without fetching it, and swaps the other", async () => {
    const { one, two } = await sourceUrls();
    const oneDigest = await sha256Of(SOURCE_TEXT);
    const twoDigest = await sha256Of(OTHER_TEXT);

    const drop = await publishOk({
      files: [
        { path: "kept.html", url: one, sha256: oneDigest },
        { path: "swapped.html", url: one, sha256: oneDigest },
      ],
      title: "Two by url",
      expires: "1d",
    });

    // The kept entry names a digest the drop already holds, so nothing is
    // fetched for it; the swapped one is a new digest and a new generation.
    const response = await apiJson(`/_api/v1/drops/${drop.slug as string}`, "PATCH", {
      files: [
        { path: "kept.html", url: `${BASE_URL}/does-not-exist/x.html`, sha256: oneDigest },
        { path: "swapped.html", url: two, sha256: twoDigest },
      ],
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const updated = (await response.json()) as Json;

    expect(filesOf(updated).find((f) => f.path === "kept.html")!.sha256).toBe(oneDigest);
    expect(filesOf(updated).find((f) => f.path === "swapped.html")!.sha256).toBe(twoDigest);
    expect(updated.updated).not.toBe(drop.updated);
    expect(await (await fetch(`${updated.url as string}swapped.html`, { cache: "no-store" })).text()).toBe(
      OTHER_TEXT,
    );
  });
});

describe("an idempotent retry over a url entry", () => {
  it("re-fetches a blob that is gone and converges on the same drop", async () => {
    const { retry } = await sourceUrls();
    const digest = await sha256Of(RETRY_TEXT);
    const key = `k-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const body = {
      files: [{ path: "copy.html", url: retry, sha256: digest }],
      title: "Retry me",
      expires: "1d",
      idempotency_key: key,
    };

    // Only the blob this attempt writes may be deleted: the source drop holds
    // the same bytes under the same digest, and deleting ITS blob would break
    // the target instead of testing the retry.
    const before = new Set(await devKeys("drops/"));

    // Abort after the claim: the identity is fixed, `meta.json` is not there.
    const failed = await publish(body, { headers: { "DEV-Fault": "claim" } });
    expect(failed.status).toBe(500);

    const claimed = (await devKeys("drops/")).filter(
      (k) => k.endsWith(`/blobs/${digest}`) && !before.has(k),
    );
    expect(claimed.length).toBe(1);
    await apiJson("/_dev/r2/delete", "POST", { keys: claimed });

    const retried = await publish(body);
    expect(retried.status, await retried.clone().text()).toBe(201);
    const drop = (await retried.json()) as Json;
    expect(filesOf(drop)[0]!.sha256).toBe(digest);
    expect(await (await fetch(drop.url as string, { cache: "no-store" })).text()).toBe(RETRY_TEXT);
  });
});

describe("the served skill", () => {
  it("teaches the three entry kinds and this instance's own fetch limits", async () => {
    const text = await (await fetch(`${BASE_URL}/_skill.md`, { cache: "no-store" })).text();
    expect(text).toContain("{path, url}");
    expect(text).toContain("one output token per byte");
    expect(text).toContain("2097152 bytes");
    expect(text).toContain("104857600 bytes");
    expect(text).toContain("128 px");
    expect(text).not.toMatch(/\{\{|\}\}/);
  });
});
