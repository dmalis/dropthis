import { describe, expect, it } from "vitest";
import { decryptResult, encryptResult } from "../src/storage/result-crypto.js";

const SECRET = "a-test-hmac-secret-of-decent-length";

describe("result encryption", () => {
  it("round-trips a stored response", async () => {
    const plaintext = JSON.stringify({ url: "https://x/abcdefghij/", password: "hunter22hunter22" });
    expect(await decryptResult(SECRET, await encryptResult(SECRET, plaintext))).toBe(plaintext);
  });

  it("never repeats a ciphertext, because the nonce is fresh each time", async () => {
    const a = await encryptResult(SECRET, "same");
    const b = await encryptResult(SECRET, "same");
    expect(a).not.toBe(b);
    expect(await decryptResult(SECRET, a)).toBe("same");
    expect(await decryptResult(SECRET, b)).toBe("same");
  });

  it("does not leak the plaintext into the stored token", async () => {
    const token = await encryptResult(SECRET, "hunter22hunter22");
    expect(token).not.toContain("hunter22");
  });

  it("refuses a ciphertext from another instance's secret", async () => {
    const token = await encryptResult(SECRET, "secret");
    await expect(decryptResult("a-different-instance-secret", token)).rejects.toThrow();
  });

  it("refuses a tampered ciphertext", async () => {
    const token = await encryptResult(SECRET, "secret");
    const flipped = `${token.slice(0, -2)}${token.at(-2) === "A" ? "B" : "A"}${token.at(-1)}`;
    await expect(decryptResult(SECRET, flipped)).rejects.toThrow();
  });

  it("refuses a token that is too short to hold a nonce", async () => {
    await expect(decryptResult(SECRET, "AAAA")).rejects.toThrow();
  });
});
