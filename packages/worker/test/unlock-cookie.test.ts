import { describe, expect, it } from "vitest";
import {
  UNLOCK_COOKIE,
  cookieExpiry,
  readCookie,
  setCookieHeader,
  signUnlock,
  verifyUnlock,
} from "../src/viewer/unlock-cookie.js";

const SECRET = "a-dev-hmac-secret";
const SLUG = "abcdefghij";
const NONCE = "0123456789abcdef0123456789abcdef";
const NOW = new Date("2026-01-01T00:00:00Z");

const later = (ms: number) => new Date(NOW.getTime() + ms);

describe("the unlock cookie", () => {
  it("verifies the token it signed", async () => {
    const token = await signUnlock(SECRET, { slug: SLUG, nonce: NONCE, expiresAt: later(1000) });
    expect(await verifyUnlock(SECRET, token, { slug: SLUG, nonce: NONCE, now: NOW })).toBe(true);
  });

  /**
   * The nonce is the revocation lever: a real password change rotates it and
   * every cookie signed over the old one has to stop opening the drop.
   */
  it("refuses a token signed over a rotated nonce", async () => {
    const token = await signUnlock(SECRET, { slug: SLUG, nonce: NONCE, expiresAt: later(1000) });
    const rotated = "ffffffffffffffffffffffffffffffff";
    expect(await verifyUnlock(SECRET, token, { slug: SLUG, nonce: rotated, now: NOW })).toBe(false);
  });

  it("refuses a token minted for another drop", async () => {
    const token = await signUnlock(SECRET, { slug: SLUG, nonce: NONCE, expiresAt: later(1000) });
    expect(
      await verifyUnlock(SECRET, token, { slug: "zzzzzzzzzz", nonce: NONCE, now: NOW }),
    ).toBe(false);
  });

  it("refuses a token past its own expiry", async () => {
    const token = await signUnlock(SECRET, { slug: SLUG, nonce: NONCE, expiresAt: later(1000) });
    expect(
      await verifyUnlock(SECRET, token, { slug: SLUG, nonce: NONCE, now: later(1001) }),
    ).toBe(false);
  });

  it("refuses a token whose expiry was edited, because the expiry is signed", async () => {
    const token = await signUnlock(SECRET, { slug: SLUG, nonce: NONCE, expiresAt: later(1000) });
    const [, mac] = token.split(".");
    const extended = `${later(9_000_000).getTime()}.${mac}`;
    expect(
      await verifyUnlock(SECRET, extended, { slug: SLUG, nonce: NONCE, now: later(2000) }),
    ).toBe(false);
  });

  it("refuses a token signed with another instance's secret", async () => {
    const token = await signUnlock("another-secret", {
      slug: SLUG,
      nonce: NONCE,
      expiresAt: later(1000),
    });
    expect(await verifyUnlock(SECRET, token, { slug: SLUG, nonce: NONCE, now: NOW })).toBe(false);
  });

  it("refuses anything that is not a token", async () => {
    for (const junk of ["", ".", "abc", "1.", ".ff", "not-a-number.ff"]) {
      expect(await verifyUnlock(SECRET, junk, { slug: SLUG, nonce: NONCE, now: NOW })).toBe(false);
    }
  });
});

describe("how long an unlock lasts", () => {
  it("is a week when the drop outlives it", () => {
    const at = cookieExpiry(NOW, "2027-01-01T00:00:00Z");
    expect(at.getTime()).toBe(NOW.getTime() + 7 * 24 * 60 * 60 * 1000);
  });

  it("never outlives the drop it opens", () => {
    const at = cookieExpiry(NOW, "2026-01-02T00:00:00Z");
    expect(at.toISOString()).toBe("2026-01-02T00:00:00.000Z");
  });

  it("is a week for a drop that never expires", () => {
    const at = cookieExpiry(NOW, null);
    expect(at.getTime()).toBe(NOW.getTime() + 7 * 24 * 60 * 60 * 1000);
  });
});

describe("the Set-Cookie header", () => {
  it("carries exactly the attributes docs/spec-v1.md froze", () => {
    const header = setCookieHeader(SLUG, "token-value", later(1000));
    expect(header).toContain(`${UNLOCK_COOKIE}=token-value`);
    expect(header).toContain(`Path=/${SLUG}/`);
    expect(header).toContain("Secure");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Expires=");
    // Host-only: a `Domain` attribute would hand the cookie to every subdomain.
    expect(header).not.toContain("Domain");
  });
});

describe("reading a cookie back off a request", () => {
  it("finds the unlock cookie among others", () => {
    expect(readCookie(`a=1; ${UNLOCK_COOKIE}=wanted; b=2`, UNLOCK_COOKIE)).toBe("wanted");
  });

  it("is null when the header is absent or holds no such cookie", () => {
    expect(readCookie(null, UNLOCK_COOKIE)).toBeNull();
    expect(readCookie("a=1; b=2", UNLOCK_COOKIE)).toBeNull();
  });

  it("does not match a cookie whose name merely ends with ours", () => {
    expect(readCookie(`x_${UNLOCK_COOKIE}=other`, UNLOCK_COOKIE)).toBeNull();
  });
});
