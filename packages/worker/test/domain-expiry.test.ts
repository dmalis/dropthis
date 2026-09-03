import { describe, expect, it } from "vitest";
import {
  dropState,
  expiringMarkerDate,
  ExpiryError,
  GRACE_MS,
  resolveExpiry,
} from "../src/domain/expiry.js";

const NOW = new Date("2026-09-03T12:00:00Z");
const POLICY = { max: "365d", allowNever: true };

const resolve = (value: string, policy = POLICY) => resolveExpiry(value, policy, NOW);

describe("resolveExpiry", () => {
  it('turns "7d" into a timestamp seven days out', () => {
    expect(resolve("7d")).toBe("2026-09-10T12:00:00Z");
  });

  it('reads a bare date as midnight UTC', () => {
    expect(resolve("2026-12-31")).toBe("2026-12-31T00:00:00Z");
  });

  it("accepts an RFC 3339 timestamp and normalises it to UTC seconds", () => {
    expect(resolve("2026-10-01T08:30:00.500Z")).toBe("2026-10-01T08:30:00Z");
    expect(resolve("2026-10-01T10:30:00+02:00")).toBe("2026-10-01T08:30:00Z");
  });

  it('turns "never" into null when policy allows it', () => {
    expect(resolve("never")).toBe(null);
  });

  it('refuses "never" when policy forbids it', () => {
    expect(() => resolve("never", { max: "365d", allowNever: false })).toThrow(
      expect.objectContaining({ code: "POLICY_VIOLATION" }),
    );
  });

  it("refuses a value in the past", () => {
    expect(() => resolve("2020-01-01")).toThrow(
      expect.objectContaining({ code: "POLICY_VIOLATION" }),
    );
  });

  it("refuses the present instant — an expiry must be in the future", () => {
    expect(() => resolve("2026-09-03T12:00:00Z")).toThrow(ExpiryError);
    expect(() => resolve("0d")).toThrow(ExpiryError);
  });

  it("refuses a value beyond the policy maximum", () => {
    expect(() => resolve("400d")).toThrow(expect.objectContaining({ code: "POLICY_VIOLATION" }));
  });

  it("accepts a value exactly at the policy maximum", () => {
    expect(resolve("365d")).toBe("2027-09-03T12:00:00Z");
  });

  it("applies the policy maximum to `never` only through allow_never", () => {
    expect(resolveExpiry("never", { max: "30d", allowNever: true }, NOW)).toBe(null);
  });

  it.each(["", "7", "d", "7 d", "-1d", "7.5d", "tomorrow", "2026-13-40", "2026-12-31T99:00:00Z"])(
    "refuses %s as INVALID_INPUT",
    (value) => {
      expect(() => resolve(value)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    },
  );
});

describe("dropState", () => {
  const at = (iso: string) => new Date(iso);

  it("is live while the expiry is in the future", () => {
    expect(dropState("2026-09-10T12:00:00Z", NOW)).toBe("live");
  });

  it("is live forever when there is no expiry", () => {
    expect(dropState(null, NOW)).toBe("live");
  });

  it("enters grace at the expiry instant", () => {
    expect(dropState("2026-09-03T12:00:00Z", NOW)).toBe("expired_grace");
  });

  it("stays in grace for seven days", () => {
    expect(dropState("2026-09-03T12:00:00Z", at("2026-09-10T11:59:59Z"))).toBe("expired_grace");
  });

  it("is final once the grace window closes", () => {
    expect(dropState("2026-09-03T12:00:00Z", at("2026-09-10T12:00:00Z"))).toBe("expired_final");
  });

  it("uses a seven-day grace", () => {
    expect(GRACE_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe("expiringMarkerDate", () => {
  it("dates the marker at expiry plus grace, in UTC", () => {
    expect(expiringMarkerDate("2026-09-03T12:00:00Z")).toBe("2026-09-10");
  });

  it("rolls to the next day when the grace crosses midnight", () => {
    expect(expiringMarkerDate("2026-09-03T23:30:00Z")).toBe("2026-09-10");
    expect(expiringMarkerDate("2026-09-03T00:30:00Z")).toBe("2026-09-10");
  });
});
