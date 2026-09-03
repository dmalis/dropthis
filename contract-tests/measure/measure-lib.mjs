/**
 * Shared plumbing for the two Free-plan measurements.
 *
 * Two facts about a Worker shape everything here:
 *  - `Date.now()` inside a Worker only advances on I/O, so in-isolate timings
 *    read as 0. The client's wall clock is the only honest timer.
 *  - An isolate that has exceeded its CPU budget keeps failing fast for a
 *    while, so a heavy sample poisons the samples that follow it. Every run
 *    therefore pauses between samples and reports failures rather than
 *    retrying them away.
 */
const BASE_URL = (
  process.env.DROPTHIS_DEV_URL ?? "https://dropthis-dev.dropthis-app.workers.dev"
).replace(/\/$/, "");

export const base = BASE_URL;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * An isolate killed for exceeding its budget keeps failing fast for a while, so
 * a sample taken right after a failure measures the poisoning, not the size.
 * Every caller waits longer after a failure than after a pass.
 */
export const PAUSE_OK_MS = 3000;
export const PAUSE_FAIL_MS = 10000;

/** One timed request. Never throws: a failure is a data point. */
export async function timed(path, init = {}) {
  const started = process.hrtime.bigint();
  try {
    const response = await fetch(`${BASE_URL}${path}`, { cache: "no-store", ...init });
    const text = await response.text();
    const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      // Cloudflare's edge answers a killed isolate with an HTML page; the
      // only part worth keeping is the error number (1102 = "Worker exceeded
      // resource limits").
      const plain = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
      const code = /error(?: code)?:? (\d{4})/i.exec(plain);
      body = code === null ? plain.trim().slice(0, 120) : `cloudflare ${code[1]}`;
    }
    return { ok: response.ok, status: response.status, wallMs, body };
  } catch (error) {
    const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
    return { ok: false, status: 0, wallMs, body: String(error) };
  }
}

export const median = (numbers) => {
  const sorted = [...numbers].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

export const round1 = (n) => Math.round(n * 10) / 10;
