import { describe, expect, it } from "vitest";
import { BASE_URL } from "./base-url.js";

/**
 * Seam 1: what a Worker's clock can and cannot see, measured on the deployed
 * instance. Nothing here is provable in Node or Miniflare — both run the clock
 * freely, which is exactly why `doctor`'s `pbkdf2_benchmark` reported "0 ms,
 * inside the budget" on every real instance and looked healthy (issue #16).
 *
 * A Worker freezes `Date.now()` inside a request. Issue #16 assumed the clock
 * catches up to real time at an I/O boundary, so bracketing N derives with a
 * binding call would make them measurable. It does not: the clock advances by
 * what the I/O itself cost and never by the CPU burned before it. These tests
 * pin that, because it is the reason the check cannot answer with a number.
 */
const DERIVES = 32;
/** 25,000 iterations cost 6.1 ms per derive on Free (docs/research/2026-09-03-free-plan-measurements.md). */
const REFERENCE_MS = 6.1;
const EXPECTED_CPU_MS = DERIVES * REFERENCE_MS;

type Bracket = { derives: number; baseline_ms: number; bracket_ms: number };

/** The fastest of a few: the floor, the one a busy colo cannot inflate. */
async function bracket(io: string, derives: number): Promise<Bracket> {
  let best: Bracket | null = null;
  for (let round = 0; round < 3; round += 1) {
    const response = await fetch(
      `${BASE_URL}/_dev/bench/bracket?io=${io}&derives=${derives}&iterations=25000`,
      { cache: "no-store" },
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const row = (await response.json()) as Bracket;
    if (best === null || row.bracket_ms < best.bracket_ms) best = row;
  }
  return best!;
}

/** The wall clock the Worker cannot see: the caller's own. */
async function wallMs(io: string, derives: number): Promise<number> {
  let best = Number.POSITIVE_INFINITY;
  for (let round = 0; round < 3; round += 1) {
    const started = performance.now();
    await (
      await fetch(`${BASE_URL}/_dev/bench/bracket?io=${io}&derives=${derives}&iterations=25000`, {
        cache: "no-store",
      })
    ).text();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

describe("the Worker clock and CPU time", () => {
  it("really does spend the CPU: the caller's wall clock sees the derives", async () => {
    const idle = await wallMs("none", 0);
    const busy = await wallMs("none", DERIVES);

    expect(busy - idle, `idle ${idle} ms, busy ${busy} ms`).toBeGreaterThan(EXPECTED_CPU_MS / 2);
  });

  /**
   * The finding. An R2 binding call is a real subrequest and it does move the
   * clock — by its own latency. Thirty-two derives before it, ~195 ms of CPU,
   * move it by nothing.
   */
  it.each(["head", "get", "list", "timer", "fetch"])(
    "does not advance across an awaited %s, whatever CPU ran before it",
    async (io) => {
      const idle = await bracket(io, 0);
      const busy = await bracket(io, DERIVES);

      expect(
        busy.bracket_ms - idle.bracket_ms,
        `io=${io}: ${idle.bracket_ms} ms idle vs ${busy.bracket_ms} ms after ${DERIVES} derives`,
      ).toBeLessThan(EXPECTED_CPU_MS / 4);
    },
  );
});
