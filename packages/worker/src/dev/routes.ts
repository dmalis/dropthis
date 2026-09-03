/**
 * Dev-only probes. They exist so seam 1 can prove what REMOTE R2 does — a
 * failed precondition, a per-key write-rate refusal, a digest R2 rejects — and
 * so the Free plan's CPU ceiling can be measured instead of guessed.
 *
 * They are not part of the product: the production entry point
 * (`src/index.ts`) never imports this module, so a production bundle does not
 * contain it (pinned by `test/build-guard.test.ts`), and the dev entry point
 * still refuses to mount them unless the deployed instance sets `DEV_ROUTES=1`.
 */
import { Hono } from "hono";
import type { Env } from "../bindings.js";
import { errorBody, ERRORS } from "../errors.js";
import { loadInstanceConfig } from "../instance-config.js";
import { runCron } from "../operations/cron.js";
import { StorageError, casPut, claimKey, createPut, mapStorageError, putBlob } from "../storage/r2.js";
import type { DevHooks } from "./hooks.js";

const encoder = new TextEncoder();

export function devRoutes(hooks: DevHooks) {
  const dev = new Hono<{ Bindings: Env }>();

  dev.use("*", async (c, next) => {
    if (c.env.DEV_ROUTES !== "1") {
      return c.json(errorBody("NOT_FOUND", "No such route."), 404);
    }
    await next();
  });

  // A mapped storage failure leaves on the wire in the product's own shape,
  // so the contract tests assert the real error object and its Retry-After.
  dev.onError((error, c) => {
    if (!(error instanceof StorageError)) throw error;
    const status = ERRORS[error.code].status as 400;
    const response = c.json(errorBody(error.code, error.message), status);
    if (error.retryAfterSeconds !== undefined) {
      response.headers.set("Retry-After", String(error.retryAfterSeconds));
    }
    return response;
  });

  dev.post("/r2/claim", async (c) => {
    const { key, body } = await c.req.json<{ key: string; body: string }>();
    return c.json(await claimKey(c.env.BUCKET, key, body));
  });

  // No `etag` = create (If-None-Match: *); an `etag` = compare-and-swap.
  dev.post("/r2/cas", async (c) => {
    const { key, body, etag } = await c.req.json<{ key: string; body: string; etag?: string }>();
    const result =
      etag === undefined
        ? await createPut(c.env.BUCKET, key, body)
        : await casPut(c.env.BUCKET, key, body, etag);
    return c.json(result);
  });

  dev.post("/r2/blob", async (c) => {
    const { key, body, sha256 } = await c.req.json<{ key: string; body: string; sha256: string }>();
    const written = await putBlob(c.env.BUCKET, key, encoder.encode(body), sha256);
    return c.json({ ok: true, etag: written.etag, size: written.size ?? null });
  });

  dev.post("/r2/get", async (c) => {
    const { key } = await c.req.json<{ key: string }>();
    const object = await c.env.BUCKET.get(key);
    if (object === null) return c.json({ found: false });
    return c.json({ found: true, body: await object.text(), etag: object.etag });
  });

  dev.post("/r2/head", async (c) => {
    const { key } = await c.req.json<{ key: string }>();
    const object = await c.env.BUCKET.head(key);
    if (object === null) return c.json({ found: false });
    // `uploaded` is how seam 1 proves a write did NOT happen: an unchanged file
    // that was re-uploaded would carry a newer instant.
    return c.json({
      found: true,
      size: object.size ?? null,
      uploaded: object.uploaded?.toISOString() ?? null,
      customMetadata: object.customMetadata ?? null,
    });
  });

  /**
   * `count` writes to ONE key, as fast as the Worker can issue them: all in
   * flight at once (`concurrent`, the shape that provokes R2's per-key limit)
   * or one after another (`sequential`, which measures whether the documented
   * ~1 write/second holds for a serial writer). Every outcome is reported,
   * mapped and raw, because the finding itself is the value: if R2 no longer
   * refuses at this rate, the transcript has to say so.
   */
  dev.post("/r2/burst", async (c) => {
    const {
      key,
      count = 10,
      mode = "concurrent",
    } = await c.req.json<{ key: string; count?: number; mode?: "concurrent" | "sequential" }>();
    const started = Date.now();
    const write = (i: number) =>
      c.env.BUCKET.put(key, `write-${i}`).then((written) => written?.etag ?? null);
    let settled: PromiseSettledResult<string | null>[];
    if (mode === "sequential") {
      settled = [];
      for (let i = 0; i < count; i += 1) {
        settled.push(
          await write(i).then(
            (value) => ({ status: "fulfilled" as const, value }),
            (reason: unknown) => ({ status: "rejected" as const, reason }),
          ),
        );
      }
    } else {
      settled = await Promise.allSettled(Array.from({ length: count }, (_, i) => write(i)));
    }
    const writes = settled.map((outcome, i) =>
      outcome.status === "fulfilled"
        ? { i, ok: true as const, etag: outcome.value }
        : {
            i,
            ok: false as const,
            code: mapStorageError(outcome.reason, key).code,
            raw: String(outcome.reason instanceof Error ? outcome.reason.message : outcome.reason),
          },
    );
    return c.json({
      key,
      count,
      mode,
      elapsed_ms: Date.now() - started,
      ok: writes.filter((w) => w.ok).length,
      rate_limited: writes.filter((w) => !w.ok && w.code === "R2_RATE_LIMIT").length,
      writes,
    });
  });

  /**
   * Times PBKDF2-SHA256 at a given iteration count in the deployed isolate.
   * `doctor`'s `pbkdf2_benchmark` check reuses this exact shape.
   */
  dev.get("/bench/pbkdf2", async (c) => {
    const iterations = Number(c.req.query("iterations") ?? "5000");
    const rounds = Number(c.req.query("rounds") ?? "1");
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode("a-password-of-realistic-length"),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    const timings: number[] = [];
    for (let i = 0; i < rounds; i += 1) {
      const started = Date.now();
      await crypto.subtle.deriveBits(
        { name: "PBKDF2", hash: "SHA-256", salt, iterations },
        key,
        256,
      );
      timings.push(Date.now() - started);
    }
    return c.json({ iterations, rounds, timings_ms: timings, max_ms: Math.max(...timings) });
  });

  /**
   * Which awaited call, if any, makes a Worker's frozen clock account for CPU
   * time spent inside the request (issue #16).
   *
   * The shape is one bracket: read `Date.now()`, do `derives` PBKDF2 derives,
   * await `io`, read the clock again — measured first with no derives, so the
   * I/O's own cost is subtracted. Seam 1 pins the answer
   * (`contract-tests/worker-clock.test.ts`): NONE of the in-process waits does.
   * `io=self` is the exception, and the reason: the CPU is then spent in
   * ANOTHER request, so the caller sees it as the duration of its own I/O.
   *
   *   head | get | list   an R2 binding call (internal subrequest)
   *   timer                setTimeout(0)
   *   fetch                a real external request
   *   none                 no wait at all
   *   self                 a subrequest to this Worker that runs the derives
   */
  dev.get("/bench/bracket", async (c) => {
    const derives = Number(c.req.query("derives") ?? "8");
    const iterations = Number(c.req.query("iterations") ?? "25000");
    const mode = c.req.query("io") ?? "head";
    const bucket = c.env.BUCKET;
    const origin = new URL(c.req.url).origin;
    const selfDerive = (rounds: number) =>
      fetch(`${origin}/_dev/bench/pbkdf2?iterations=${iterations}&rounds=${rounds}`).then((r) =>
        r.text(),
      );

    const io = async () => {
      if (mode === "get") await bucket.get("system/config.json");
      else if (mode === "list") await bucket.list({ prefix: "system/", limit: 1 });
      else if (mode === "timer") await new Promise((resolve) => setTimeout(resolve, 0));
      else if (mode === "fetch") await fetch("https://cloudflare.com/cdn-cgi/trace", { cache: "no-store" });
      else if (mode === "self") await selfDerive(0);
      else if (mode === "none") return;
      else await bucket.head("system/config.json");
    };

    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode("a-password-of-realistic-length"),
      "PBKDF2",
      false,
      ["deriveBits"],
    );

    // The prime: every clock read has to follow an await, or it carries
    // however much CPU ran since the last one.
    await io();
    const b0 = Date.now();
    await io();
    const baseline_ms = Date.now() - b0;

    const s0 = Date.now();
    if (mode === "self") {
      await selfDerive(derives);
    } else {
      for (let i = 0; i < derives; i += 1) {
        await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
      }
      await io();
    }
    const bracket_ms = Date.now() - s0;

    return c.json({ derives, iterations, io: mode, baseline_ms, bracket_ms });
  });

  /**
   * A calibrated CPU load: `rounds` SHA-256 digests over 1 KB. The plan's CPU
   * ceiling is found by raising `rounds` until the isolate is killed (the edge
   * answers 1102) — `Date.now()` inside a Worker only advances on I/O, so the
   * honest timing is the client's wall clock and the honest ceiling is the kill.
   */
  dev.get("/bench/cpu", async (c) => {
    const rounds = Number(c.req.query("rounds") ?? "100");
    const block = crypto.getRandomValues(new Uint8Array(1024));
    let last = new Uint8Array(0);
    for (let i = 0; i < rounds; i += 1) {
      last = new Uint8Array(await crypto.subtle.digest("SHA-256", block));
    }
    return c.json({ rounds, last_byte: last[0] ?? null });
  });

  /**
   * The inline-upload ceiling: parse the JSON body, base64-decode every entry
   * and hash the bytes — exactly the work `publish` will do before any R2 write
   * — and report the wall time. A body too large for the plan's CPU budget
   * never reaches the response: the isolate is killed and the client sees a
   * 1102 from the edge. That kill is the measurement.
   */
  dev.post("/bench/inline", async (c) => {
    const decoder = c.req.query("decoder") ?? "auto";
    const started = Date.now();
    const raw = await c.req.text();
    const readAt = Date.now();
    const payload = JSON.parse(raw) as { files: Array<{ path: string; base64: string }> };
    const parsedAt = Date.now();
    let bytes = 0;
    const digests: string[] = [];
    for (const file of payload.files) {
      const buffer = decodeBase64(file.base64, decoder);
      bytes += buffer.length;
      const digest = await crypto.subtle.digest("SHA-256", buffer);
      digests.push(hex(digest).slice(0, 8));
    }
    return c.json({
      ok: true,
      files: payload.files.length,
      decoder: activeDecoder(decoder),
      request_bytes: raw.length,
      decoded_bytes: bytes,
      read_ms: readAt - started,
      parse_ms: parsedAt - readAt,
      total_ms: Date.now() - started,
      digest_prefixes: digests.slice(0, 3),
    });
  });

  /**
   * The keys under a prefix. Seam 1 uses it to assert what a FAILED write left
   * behind — "no meta.json, no slug pointer, only unreferenced blobs" is a
   * claim about keys, and this is the only way to check it from outside.
   */
  dev.post("/r2/list", async (c) => {
    const { prefix = "" } = await c.req.json<{ prefix?: string }>();
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const listing = await c.env.BUCKET.list(cursor === undefined ? { prefix } : { prefix, cursor });
      for (const object of listing.objects) keys.push(object.key);
      cursor = listing.truncated ? listing.cursor : undefined;
    } while (cursor !== undefined);
    return c.json({ prefix, keys });
  });

  /**
   * Runs the hourly cron NOW, through the same function the scheduled handler
   * calls — a contract test cannot wait an hour, and asserting the cron on a
   * copy of its logic would assert nothing. `budget` overrides
   * `cron_ops_budget` for this one run, so the budget-exhausted case can be
   * proven without a `config set` that would leak into every other test file.
   */
  dev.post("/cron", async (c) => {
    const body = await c.req.json<{ budget?: number; force?: "sweep" | "reconcile" }>().catch(
      () => ({}) as { budget?: number; force?: "sweep" | "reconcile" },
    );
    const config = await loadInstanceConfig(c.env.BUCKET, c.req.url);
    return c.json(
      await runCron({
        bucket: c.env.BUCKET,
        now: hooks.now(c.env, c.req.raw),
        budget: body.budget ?? config.policy.cron_ops_budget,
        ...(body.force === undefined ? {} : { force: body.force }),
      }),
    );
  });

  /**
   * Deletes exact keys. Seam 1 uses it to MANUFACTURE the states the write
   * order is designed to survive — an orphaned `list/` pointer, a lost listing
   * row — which no ordinary call can produce on purpose.
   */
  dev.post("/r2/delete", async (c) => {
    const { keys } = await c.req.json<{ keys: string[] }>();
    if (keys.length > 0) await c.env.BUCKET.delete(keys);
    return c.json({ deleted: keys.length });
  });

  /** Empties the bucket so a contract run starts from nothing. */
  dev.post("/reset", async (c) => {
    let deleted = 0;
    let cursor: string | undefined;
    do {
      const listing = await c.env.BUCKET.list(cursor === undefined ? {} : { cursor });
      const keys = listing.objects.map((object) => object.key);
      if (keys.length > 0) {
        await c.env.BUCKET.delete(keys);
        deleted += keys.length;
      }
      cursor = listing.truncated ? listing.cursor : undefined;
    } while (cursor !== undefined);
    return c.json({ deleted });
  });

  return dev;
}

/**
 * Which base64 decoder the runtime gives us. `Uint8Array.fromBase64` is a
 * native, single-call decode; the `atob` + per-character loop is the portable
 * fallback and costs an order of magnitude more CPU per megabyte. Which one
 * `publish` uses decides the inline ceiling, so the benchmark reports it.
 */
type Base64Api = { fromBase64?: (text: string) => Uint8Array<ArrayBufferLike> };

function activeDecoder(requested: string): string {
  const native = (Uint8Array as unknown as Base64Api).fromBase64;
  if (requested === "charcode") return "charcode";
  if (requested === "fromBase64") return native ? "fromBase64" : "unavailable";
  return native ? "fromBase64" : "charcode";
}

function decodeBase64(text: string, requested: string): Uint8Array<ArrayBuffer> {
  if (activeDecoder(requested) === "fromBase64") {
    const native = (Uint8Array as unknown as Required<Base64Api>).fromBase64(text);
    return new Uint8Array(native.buffer as ArrayBuffer, native.byteOffset, native.byteLength);
  }
  const binary = atob(text);
  const buffer = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) buffer[i] = binary.charCodeAt(i);
  return buffer;
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

