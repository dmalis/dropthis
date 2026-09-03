import { describe, expect, it } from "vitest";
import { ERRORS, errorBody, type ErrorCode } from "../src/errors.js";

// The matrix below is transcribed from docs/spec-v1.md line 197 (the frozen
// error catalogue). It is the spec, not a copy of the implementation.
const SPEC: Array<[ErrorCode, number, boolean]> = [
  ["INVALID_INPUT", 400, false],
  ["INVALID_PATH", 400, false],
  ["POLICY_VIOLATION", 400, false],
  ["UNAUTHENTICATED", 401, false],
  ["FORBIDDEN_SCOPE", 403, false],
  ["NOT_FOUND", 404, false],
  ["WRONG_INSTANCE", 404, false],
  ["EXPIRED_NEEDS_EXPIRES", 409, false],
  ["UPDATE_CONFLICT", 409, true],
  ["IDEMPOTENCY_MISMATCH", 409, false],
  ["LABEL_TAKEN", 409, false],
  ["NAME_TAKEN", 409, false],
  ["EXPIRED_FINAL", 410, false],
  ["UPLOAD_EXPIRED", 410, false],
  ["PAYLOAD_TOO_LARGE", 413, false],
  ["HASH_MISMATCH", 422, false],
  ["FETCH_FAILED", 422, false],
  ["R2_RATE_LIMIT", 429, true],
  ["INTERNAL", 500, true],
];

describe("error catalogue", () => {
  it("holds exactly the codes the spec freezes", () => {
    expect(Object.keys(ERRORS).sort()).toEqual(SPEC.map(([c]) => c).sort());
  });

  it.each(SPEC)("%s → status %i, retryable %s", (code, status, retryable) => {
    const entry = ERRORS[code];
    expect(entry.status).toBe(status);
    expect(entry.retryable).toBe(retryable);
  });

  it("gives every code a non-empty imperative remediation", () => {
    for (const [code] of SPEC) {
      const remediation = ERRORS[code].remediation;
      expect(remediation.length, code).toBeGreaterThan(0);
      expect(remediation.trim(), code).toBe(remediation);
      expect(remediation.endsWith("."), code).toBe(true);
    }
  });
});

describe("errorBody", () => {
  it("renders the wire shape with the catalogue's remediation and retryability", () => {
    expect(errorBody("NOT_FOUND", "No such route.")).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "No such route.",
        remediation: ERRORS.NOT_FOUND.remediation,
        retryable: false,
      },
    });
  });

  it("marks a retryable code retryable", () => {
    expect(errorBody("R2_RATE_LIMIT", "Too fast.").error.retryable).toBe(true);
  });
});
