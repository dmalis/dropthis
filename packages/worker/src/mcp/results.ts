/**
 * How a tool answers (docs/spec-v1.md, "Error wire shape"; decision #80).
 *
 * `structuredContent` is the SAME object REST returns — one `Drop`, one page,
 * one error object — so a client that reads structure parses one thing
 * whatever the surface. The text channel opens with one load-bearing line
 * ("Published: <url>") and then carries the same JSON, because text-only
 * clients still exist and a generated password that only lived in structured
 * content would be lost on them. An error is `isError: true` with the
 * catalogue object in both channels and nothing else.
 *
 * No `next` hints on success (decision #51): the URL is the id.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { errorBody } from "../errors.js";
import type { ApiError } from "../errors.js";
import { OPERATIONS } from "../registry/index.js";

export function successResult(
  operation: string,
  input: Record<string, unknown>,
  value: unknown,
): CallToolResult {
  // The line lives ON the operation entry: one registry, not two.
  const line = OPERATIONS.find((op) => op.name === operation)?.resultLine;
  if (line === undefined) throw new Error(`Operation ${operation} has no result line.`);
  const head = line(input, value);

  // `204`-style operations return nothing: the line is the whole answer.
  if (value === null || value === undefined) return { content: [{ type: "text", text: head }] };

  return {
    content: [{ type: "text", text: `${head}\n${JSON.stringify(value)}` }],
    structuredContent: value as Record<string, unknown>,
  };
}

export function errorResult(error: ApiError): CallToolResult {
  const body = errorBody(error.code, error.message);
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(body) }],
    structuredContent: body,
  };
}
