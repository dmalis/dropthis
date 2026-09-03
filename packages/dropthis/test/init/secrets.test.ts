import { describe, expect, it } from "vitest";
import { generateHmacSecret } from "../../src/init/secrets.js";

describe("generateHmacSecret", () => {
  it("returns 32 random bytes as a hex string", () => {
    const secret = generateHmacSecret();
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never returns the same value twice", () => {
    expect(generateHmacSecret()).not.toBe(generateHmacSecret());
  });
});
