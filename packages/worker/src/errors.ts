/**
 * The frozen error catalogue (docs/spec-v1.md, "Error catalogue").
 *
 * Every failure an agent can see is one of these codes. `status` and
 * `retryable` are the contract; `remediation` is the one hint dropthis ever
 * sends — one imperative sentence the agent can act on. Callers choose the
 * `message`; they never choose the remediation.
 */
export type ErrorEntry = {
  readonly status: number;
  readonly retryable: boolean;
  readonly remediation: string;
};

export const ERRORS = {
  INVALID_INPUT: {
    status: 400,
    retryable: false,
    remediation: "Fix the named field and send the call again.",
  },
  INVALID_PATH: {
    status: 400,
    retryable: false,
    remediation:
      "Send a relative path with forward slashes and no `.` or `..` segments.",
  },
  POLICY_VIOLATION: {
    status: 400,
    retryable: false,
    remediation:
      "Read this instance's limits with `config get` and send a value inside them.",
  },
  UNAUTHENTICATED: {
    status: 401,
    retryable: false,
    remediation: "Send the instance key as `Authorization: Bearer <key>`.",
  },
  FORBIDDEN_SCOPE: {
    status: 403,
    retryable: false,
    remediation: "Use the admin key of this instance for this operation.",
  },
  NOT_FOUND: {
    status: 404,
    retryable: false,
    remediation: "See /_skill.md for the operation list.",
  },
  WRONG_INSTANCE: {
    status: 404,
    retryable: false,
    remediation: "Send this URL to the instance that published it.",
  },
  EXPIRED_NEEDS_EXPIRES: {
    status: 409,
    retryable: false,
    remediation: "Send `expires` with a future value in the same update.",
  },
  UPDATE_CONFLICT: {
    status: 409,
    retryable: true,
    remediation: "Read the drop again with `get` and retry the update.",
  },
  IDEMPOTENCY_MISMATCH: {
    status: 409,
    retryable: false,
    remediation:
      "Send a new `idempotency_key` for this payload, or resend the original payload.",
  },
  LABEL_TAKEN: {
    status: 409,
    retryable: false,
    remediation: "Choose another label; list the taken ones with `user list`.",
  },
  NAME_TAKEN: {
    status: 409,
    retryable: false,
    remediation: "Choose another instance name with `--name <name>`.",
  },
  EXPIRED_FINAL: {
    status: 410,
    retryable: false,
    remediation: "Publish the content again; this drop is past recovery.",
  },
  UPLOAD_EXPIRED: {
    status: 410,
    retryable: false,
    remediation: "Start a new upload session and send the files again.",
  },
  PAYLOAD_TOO_LARGE: {
    status: 413,
    retryable: false,
    remediation:
      "Send large files as `url` entries, or split the call into smaller ones.",
  },
  HASH_MISMATCH: {
    status: 422,
    retryable: false,
    remediation: "Recompute the sha256 of the bytes you send and retry.",
  },
  FETCH_FAILED: {
    status: 422,
    retryable: false,
    remediation:
      "Check that the URL is publicly reachable over https and send it again.",
  },
  R2_RATE_LIMIT: {
    status: 429,
    retryable: true,
    remediation: "Wait for the `Retry-After` seconds and send the call again.",
  },
  INTERNAL: {
    status: 500,
    retryable: true,
    remediation: "Retry the call; if it keeps failing, run `doctor`.",
  },
} as const satisfies Record<string, ErrorEntry>;

export type ErrorCode = keyof typeof ERRORS;

export type ErrorBody = {
  error: {
    code: ErrorCode;
    message: string;
    remediation: string;
    retryable: boolean;
  };
};

/** The wire shape of every dropthis error, on every surface. */
export function errorBody(code: ErrorCode, message: string): ErrorBody {
  const entry = ERRORS[code];
  return {
    error: {
      code,
      message,
      remediation: entry.remediation,
      retryable: entry.retryable,
    },
  };
}
