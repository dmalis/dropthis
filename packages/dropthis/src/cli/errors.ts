/**
 * The one error shape the CLI ever prints: the frozen catalogue object
 * `{code, message, remediation, retryable}` (AGENTS.md, "Responses and
 * errors"), whether the failure came back over the wire or happened before a
 * request was made. A wire error keeps the instance's own remediation; a local
 * one carries the CLI's, because the fix for "no credentials" is an
 * environment variable, not a header.
 *
 * Exit codes follow `gh`: 0 ok, 1 failure, 2 cancelled, 4 auth required.
 */
import { ERRORS } from "../../../worker/src/errors.js";
import type { ErrorCode } from "../../../worker/src/errors.js";

export type ErrorObject = {
  code: ErrorCode;
  message: string;
  remediation: string;
  retryable: boolean;
};

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_CANCELLED = 2;
export const EXIT_AUTH = 4;

export class CliError extends Error {
  readonly code: ErrorCode;
  readonly remediation: string;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, remediation?: string, retryable?: boolean) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.remediation = remediation ?? ERRORS[code].remediation;
    this.retryable = retryable ?? ERRORS[code].retryable;
  }

  toObject(): ErrorObject {
    return {
      code: this.code,
      message: this.message,
      remediation: this.remediation,
      retryable: this.retryable,
    };
  }

  get exitCode(): number {
    return this.code === "UNAUTHENTICATED" || this.code === "FORBIDDEN_SCOPE" ? EXIT_AUTH : EXIT_FAILURE;
  }
}

/** The user said no, or pressed Ctrl-C at a prompt. */
export class Cancelled extends Error {
  constructor() {
    super("Cancelled.");
    this.name = "Cancelled";
  }
}

export function isErrorObject(value: unknown): value is ErrorObject {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.code === "string" &&
    candidate.code in ERRORS &&
    typeof candidate.message === "string" &&
    typeof candidate.remediation === "string" &&
    typeof candidate.retryable === "boolean"
  );
}
