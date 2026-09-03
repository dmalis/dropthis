#!/usr/bin/env node
/**
 * Measures PBKDF2-SHA256 cost per unlock in the deployed Worker, so policy
 * `pbkdf2_iterations` is the highest count that fits the budget instead of a
 * guess. `doctor`'s `pbkdf2_benchmark` check reuses this method.
 *
 *   node contract-tests/measure/pbkdf2.mjs [--runs 5] [--json out.json]
 *
 * `Date.now()` inside a Worker only advances on I/O, so a derive cannot be
 * timed in-isolate: every in-worker timing reads 0. The cost is recovered from
 * the client's wall clock instead — the same request is served with 1 derive
 * and with `rounds` derives, and the difference divided by `rounds - 1` is the
 * per-derive cost with the network and the isolate's own start-up removed.
 */
import { writeFile } from "node:fs/promises";
import { base, median, round1, sleep, timed } from "./measure-lib.mjs";

const argValue = (flag, fallback) => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : process.argv[index + 1];
};

const ITERATIONS = [5000, 10000, 25000, 50000, 100000, 200000];
const RUNS = Number(argValue("--runs", 5));
const ROUNDS = Number(argValue("--rounds", 11));
const PAUSE_MS = Number(argValue("--pause", 2000));
const BUDGET_MS = 8;
const jsonOut = argValue("--json", undefined);

console.log(`pbkdf2 against ${base}, ${RUNS} runs per count, ${ROUNDS} derives per heavy call\n`);
console.log("iterations | ok    | per-derive ms | budget 8 ms");
console.log("-----------|-------|---------------|------------");

const results = [];
for (const iterations of ITERATIONS) {
  const perDerive = [];
  const failures = [];
  for (let run = 0; run < RUNS; run += 1) {
    const one = await timed(`/_dev/bench/pbkdf2?iterations=${iterations}&rounds=1`);
    await sleep(PAUSE_MS);
    const many = await timed(`/_dev/bench/pbkdf2?iterations=${iterations}&rounds=${ROUNDS}`);
    await sleep(PAUSE_MS);
    if (one.ok && many.ok) perDerive.push((many.wallMs - one.wallMs) / (ROUNDS - 1));
    else failures.push(`${one.ok ? many.status : one.status} ${one.ok ? many.body : one.body}`);
  }
  const cost = perDerive.length > 0 ? round1(median(perDerive)) : null;
  results.push({
    iterations,
    runs: RUNS,
    ok: perDerive.length,
    per_derive_ms: cost,
    within_budget: cost !== null && cost <= BUDGET_MS,
    failures: [...new Set(failures)],
  });
  console.log(
    `${String(iterations).padEnd(10)} | ${`${perDerive.length}/${RUNS}`.padEnd(5)} | ` +
      `${String(cost ?? "-").padEnd(13)} | ` +
      `${cost === null ? failures[0] ?? "-" : cost <= BUDGET_MS ? "fits" : "over"}`,
  );
}

const fitting = results.filter((r) => r.ok === r.runs && r.within_budget);
console.log(
  `\nhighest count within ${BUDGET_MS} ms in ${RUNS}/${RUNS} runs: ` +
    `${fitting.length > 0 ? fitting[fitting.length - 1].iterations : "none"}`,
);

if (jsonOut !== undefined) {
  await writeFile(
    jsonOut,
    `${JSON.stringify({ base, runs: RUNS, rounds: ROUNDS, budget_ms: BUDGET_MS, results }, null, 2)}\n`,
  );
  console.log(`raw results → ${jsonOut}`);
}
