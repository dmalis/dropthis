import { describe, expect, it } from "vitest";
import {
  BENCHMARK_BASELINE_ROUNDS,
  BENCHMARK_DERIVES,
  BENCHMARK_SIGNAL_ROUNDS,
  measurePbkdf2,
} from "../src/operations/doctor.js";

/**
 * A Worker freezes `Date.now()` inside a request: CPU work advances nothing and
 * the clock catches up only at an I/O boundary (issue #16). This probe is that
 * runtime, so the measurement is proved against the one it exists for instead
 * of against Node's free-running clock, where it already looked fine.
 */
function frozenClock(options: { deriveMs: number; ioMs: number[] | number }) {
  let visible = 0;
  let real = 0;
  let ios = 0;
  const io = Array.isArray(options.ioMs) ? options.ioMs : [options.ioMs];
  return {
    now: () => visible,
    derive: async () => {
      real += options.deriveMs;
    },
    io: async () => {
      real += io[Math.min(ios, io.length - 1)]!;
      ios += 1;
      visible = real;
    },
    get ioCount() {
      return ios;
    },
  };
}

describe("measurePbkdf2", () => {
  it("recovers the per-derive cost on a runtime whose clock moves only at I/O", async () => {
    const probe = frozenClock({ deriveMs: 6.1, ioMs: 2 });

    const measured = await measurePbkdf2(probe);

    expect(measured.perDeriveMs).toBeCloseTo(6.1, 5);
    expect(measured.baselineMs).toBe(2);
    expect(measured.derives).toBe(BENCHMARK_DERIVES);
  });

  it("brackets every read of the clock with an I/O, so none carries stale time", async () => {
    const probe = frozenClock({ deriveMs: 6.1, ioMs: 2 });

    await measurePbkdf2(probe);

    expect(probe.ioCount).toBe(1 + BENCHMARK_BASELINE_ROUNDS + BENCHMARK_SIGNAL_ROUNDS);
  });

  it("takes the fastest bracket, so one slow I/O does not inflate the derive", async () => {
    // Prime, three baselines, then a 50 ms hiccup on the first signal bracket.
    const probe = frozenClock({ deriveMs: 6.1, ioMs: [2, 2, 2, 2, 50, 2] });

    const measured = await measurePbkdf2(probe);

    expect(measured.perDeriveMs).toBeCloseTo(6.1, 5);
  });

  it("reports no number when the I/O baseline is half the signal or more", async () => {
    const probe = frozenClock({ deriveMs: 0.5, ioMs: 40 });

    const measured = await measurePbkdf2(probe);

    expect(measured.perDeriveMs).toBeNull();
    expect(measured.baselineMs).toBe(40);
  });

  it("reports no number when the clock never advances at all", async () => {
    const stuck = { now: () => 0, derive: async () => {}, io: async () => {} };

    expect((await measurePbkdf2(stuck)).perDeriveMs).toBeNull();
  });
});
