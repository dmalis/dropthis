/**
 * One place where a thrown failure becomes the wire object.
 *
 * Every layer below throws its own typed error — a bad path from the path
 * rules, a policy refusal from expiry, a throttle from storage. This maps all
 * of them onto the frozen catalogue, so an agent sees one error shape whatever
 * failed, and an unrecognised throw is `INTERNAL` rather than a stack trace.
 */
import type { Context } from "hono";
import { ExpiryError } from "../domain/expiry.js";
import { PathError } from "../domain/paths.js";
import { TargetError } from "../domain/target.js";
import { ApiError, ERRORS, errorBody } from "../errors.js";
import { StorageError } from "../storage/r2.js";

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof StorageError) {
    return new ApiError(error.code, error.message, error.retryAfterSeconds);
  }
  if (error instanceof PathError) return new ApiError("INVALID_PATH", error.message);
  if (error instanceof ExpiryError) return new ApiError(error.code, error.message);
  if (error instanceof TargetError) return new ApiError(error.code, error.message);
  return new ApiError("INTERNAL", error instanceof Error ? error.message : String(error));
}

/** The JSON error response, with `Retry-After` when the code carries one. */
export function errorResponse(c: Context, error: unknown): Response {
  const api = toApiError(error);
  const status = ERRORS[api.code].status as 400;
  const response = c.json(errorBody(api.code, api.message), status);
  if (api.retryAfterSeconds !== undefined) {
    response.headers.set("Retry-After", String(api.retryAfterSeconds));
  }
  return response;
}
