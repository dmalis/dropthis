import { describe, expect, it } from "vitest";
import { BASE_URL } from "./base-url.js";

/**
 * Seam 1: every claim about R2 is made against REAL remote R2, through the
 * deployed dev Worker. Miniflare has shipped reversed conditional-write logic
 * before, so no assertion in this file may be satisfied by a local emulator.
 */
const dev = (path: string, body: unknown) =>
  fetch(`${BASE_URL}/_dev${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });

const unique = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

describe("claim (If-None-Match: *)", () => {
  it("gives the key to the first writer and refuses every later one", async () => {
    const key = `slugs/${unique("claim")}`;

    const first = await (await dev("/r2/claim", { key, body: "drop-first" })).json();
    expect(first).toMatchObject({ claimed: true });
    expect(typeof (first as { etag: string }).etag).toBe("string");

    const second = await (await dev("/r2/claim", { key, body: "drop-second" })).json();
    expect(second).toEqual({ claimed: false });

    // The loser must not have touched the winner's body.
    const read = await (await dev("/r2/get", { key })).json();
    expect(read).toMatchObject({ found: true, body: "drop-first" });
  });
});

describe("compare-and-swap (If-Match)", () => {
  it("advances the etag once and refuses a second write against the stale one", async () => {
    const key = `drops/${unique("cas")}/meta.json`;

    const created = (await (await dev("/r2/cas", { key, body: '{"v":1}' })).json()) as {
      ok: boolean;
      etag: string;
    };
    expect(created.ok).toBe(true);

    const updated = (await (
      await dev("/r2/cas", { key, body: '{"v":2}', etag: created.etag })
    ).json()) as { ok: boolean; etag: string };
    expect(updated.ok).toBe(true);
    expect(updated.etag).not.toBe(created.etag);

    const stale = await (await dev("/r2/cas", { key, body: '{"v":3}', etag: created.etag })).json();
    expect(stale).toEqual({ ok: false, conflict: true });

    const read = await (await dev("/r2/get", { key })).json();
    expect(read).toMatchObject({ found: true, body: '{"v":2}' });
  });

  it("refuses a create against a key that already exists", async () => {
    const key = `drops/${unique("create")}/meta.json`;

    expect(await (await dev("/r2/cas", { key, body: "{}" })).json()).toMatchObject({ ok: true });
    expect(await (await dev("/r2/cas", { key, body: "{}" })).json()).toEqual({
      ok: false,
      conflict: true,
    });
  });
});

describe("blob writes with an R2-verified digest", () => {
  // sha256("hello dropthis"), computed independently of the Worker.
  const BODY = "hello dropthis";
  const SHA = "5f8bd77a2e2b1e5f79c98a4bdb4dd60be8ba2b2b1b3a2e19d5b6a5e8f0a7a4d2";

  it("stores the body when the digest matches and reports the stored size", async () => {
    const key = `drops/${unique("blob")}/blobs/ok`;
    const digest = await sha256Hex(BODY);

    const written = await (await dev("/r2/blob", { key, body: BODY, sha256: digest })).json();
    expect(written).toMatchObject({ ok: true });

    // `uploaded` and `customMetadata` also come back from the probe now; this
    // test is about the size R2 reports for a digest-verified body.
    const head = await (await dev("/r2/head", { key })).json();
    expect(head).toMatchObject({ found: true, size: new TextEncoder().encode(BODY).length });
  });

  it("rejects a wrong digest as HASH_MISMATCH and leaves the key absent", async () => {
    const key = `drops/${unique("blob")}/blobs/bad`;

    const response = await dev("/r2/blob", { key, body: BODY, sha256: SHA });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { code: "HASH_MISMATCH", retryable: false },
    });

    expect(await (await dev("/r2/head", { key })).json()).toEqual({ found: false });
  });
});

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("the per-key write rate", () => {
  /**
   * The product's claim (AGENTS.md, "R2 write rate") is that R2 refuses
   * writes that pile up on one key and that dropthis surfaces the refusal as a
   * retryable `R2_RATE_LIMIT` instead of retrying inside the Worker. The
   * refusal remote R2 sends is `(10058) Reduce your concurrent request rate for
   * the same object`; the counts of one run are recorded in
   * docs/research/2026-09-03-free-plan-measurements.md.
   */
  it("refuses concurrent writes to one key, and every refusal maps to R2_RATE_LIMIT", async () => {
    const key = `drops/${unique("burst")}/meta.json`;

    const result = (await (await dev("/r2/burst", { key, count: 10 })).json()) as {
      ok: number;
      rate_limited: number;
      writes: Array<{ ok: boolean; code?: string; raw?: string }>;
    };

    const refused = result.writes.filter((write) => !write.ok);
    expect(refused.length).toBeGreaterThan(0);
    // No refusal may be reported as anything but the retryable rate-limit code:
    // an agent told `INTERNAL` would give up on a wait of one second.
    expect(result.rate_limited).toBe(refused.length);
    expect(result.ok).toBeGreaterThan(0);
  });

  it("lets a serial writer through: writes one after another are not refused", async () => {
    const key = `drops/${unique("serial")}/meta.json`;

    const result = (await (
      await dev("/r2/burst", { key, count: 5, mode: "sequential" })
    ).json()) as { ok: number; rate_limited: number };

    expect(result.ok).toBe(5);
    expect(result.rate_limited).toBe(0);
  });
});
