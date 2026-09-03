#!/usr/bin/env node
/**
 * Measures the largest inline (base64-in-JSON) request the deployed Worker can
 * parse, decode and hash — the work `publish` does before its first R2 write.
 * The answer becomes policy `max_request_bytes`.
 *
 *   node contract-tests/measure/inline-ceiling.mjs [--runs 10] [--json out.json]
 *                                                  [--sizes 256,512,…] [--files 1]
 *                                                  [--pause 5000] [--in-order]
 *                                                  [--decoder auto|fromBase64|charcode]
 *
 * The dev instance runs on the Workers FREE plan — proved, not assumed: a
 * deploy carrying `limits.cpu_ms` is refused with "CPU limits are not supported
 * for the Free plan". So what passes here is what passes for a Free user.
 *
 * Method, and why it is not a simple ascending ladder: the Free plan's CPU
 * allowance behaves like a refilling budget, not a per-request ceiling. An
 * ascending ladder run back-to-back therefore measures the ORDER of the
 * samples, not their size — a first pass had 6 MB failing 10/10 and 8 MB
 * passing 10/10 in the same run. Every (size, run) pair is shuffled into one
 * plan and executed with a uniform pause, so the budget's state is
 * uncorrelated with the size under test.
 */
import { writeFile } from "node:fs/promises";
import { base, median, round1, sleep, timed } from "./measure-lib.mjs";

const argValue = (flag, fallback) => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : process.argv[index + 1];
};

const SIZES_KB = String(argValue("--sizes", "256,512,1024,2048,3072,4096,6144,8192"))
  .split(",")
  .map(Number);
const RUNS = Number(argValue("--runs", 10));
const FILES = Number(argValue("--files", 1));
const PAUSE_MS = Number(argValue("--pause", 5000));
const IN_ORDER = process.argv.includes("--in-order");
const DECODER = String(argValue("--decoder", "auto"));
const jsonOut = argValue("--json", undefined);

/** A JSON body of ~`targetBytes` spread over `FILES` base64 entries. */
function bodyOfSize(targetBytes) {
  const paths = Array.from({ length: FILES }, (_, i) => `assets/part-${i}.bin`);
  const envelope = JSON.stringify({ files: paths.map((path) => ({ path, base64: "" })) }).length;
  const base64Chars = Math.max(4 * FILES, targetBytes - envelope);
  const rawBytes = Math.floor((base64Chars / FILES / 4) * 3);
  const raw = Buffer.alloc(rawBytes);
  for (let i = 0; i < rawBytes; i += 1) raw[i] = (i * 31 + 7) & 0xff;
  const base64 = raw.toString("base64");
  return JSON.stringify({ files: paths.map((path) => ({ path, base64 })) });
}

const bodies = new Map(SIZES_KB.map((kb) => [kb, bodyOfSize(kb * 1024)]));
const plan = SIZES_KB.flatMap((kb) => Array.from({ length: RUNS }, () => kb));
if (!IN_ORDER) {
  for (let i = plan.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [plan[i], plan[j]] = [plan[j], plan[i]];
  }
}

console.log(
  `inline ceiling against ${base}\n` +
    `${RUNS} runs per size, ${FILES} file(s) per body, ${PAUSE_MS} ms between samples, ` +
    `${IN_ORDER ? "in order" : "shuffled"}\n`,
);

const samples = new Map(SIZES_KB.map((kb) => [kb, []]));
for (const [index, kb] of plan.entries()) {
  const sample = await timed(`/_dev/bench/inline?decoder=${DECODER}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: bodies.get(kb),
  });
  samples.get(kb).push(sample);
  if (process.stdout.isTTY) {
    process.stdout.write(
      `\r  sample ${index + 1}/${plan.length} (${kb} KB → ${sample.ok ? "ok" : sample.body})      `,
    );
  }
  await sleep(PAUSE_MS);
}
process.stdout.write("\r".padEnd(70) + "\r");

const results = SIZES_KB.map((kb) => {
  const runs = samples.get(kb);
  const passed = runs.filter((s) => s.ok);
  const walls = passed.map((s) => s.wallMs);
  return {
    size_kb: kb,
    request_bytes: Buffer.byteLength(bodies.get(kb)),
    files: FILES,
    runs: runs.length,
    passed: passed.length,
    median_ms: walls.length > 0 ? round1(median(walls)) : null,
    max_ms: walls.length > 0 ? round1(Math.max(...walls)) : null,
    decoded_bytes: passed[0]?.body?.decoded_bytes ?? null,
    failures: [...new Set(runs.filter((s) => !s.ok).map((s) => `${s.status} ${s.body}`))],
  };
});

console.log("size      | pass  | median ms | max ms | failures");
console.log("----------|-------|-----------|--------|---------");
for (const row of results) {
  console.log(
    `${`${row.size_kb} KB`.padEnd(9)} | ${`${row.passed}/${row.runs}`.padEnd(5)} | ` +
      `${String(row.median_ms ?? "-").padEnd(9)} | ${String(row.max_ms ?? "-").padEnd(6)} | ` +
      `${row.failures.join(", ") || "-"}`,
  );
}

const firstBad = results.find((r) => r.passed !== r.runs);
const clean = results.filter((r) => r.passed === r.runs && (!firstBad || r.size_kb < firstBad.size_kb));
console.log(
  `\nlargest size passing ${RUNS}/${RUNS} below the first failure: ` +
    `${clean.length > 0 ? `${clean[clean.length - 1].size_kb} KB` : "none"}` +
    `${firstBad ? `; first failure at ${firstBad.size_kb} KB` : "; no failure in range"}`,
);

if (jsonOut !== undefined) {
  await writeFile(
    jsonOut,
    `${JSON.stringify({ base, runs: RUNS, files: FILES, pause_ms: PAUSE_MS, shuffled: !IN_ORDER, decoder: DECODER, results }, null, 2)}\n`,
  );
  console.log(`raw results → ${jsonOut}`);
}
