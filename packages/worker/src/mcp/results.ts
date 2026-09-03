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

type Line = (input: Record<string, unknown>, value: unknown) => string;

const asDrop = (value: unknown) => value as { url: string; state: string };
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** The one line per operation a text-only client must see. */
const LINES: Record<string, Line> = {
  publish: (_input, value) => `Published: ${asDrop(value).url}`,
  update: (_input, value) => `Updated: ${asDrop(value).url}`,
  get: (_input, value) => `Drop: ${asDrop(value).url} (${asDrop(value).state})`,
  list: (_input, value) => {
    const page = value as { drops: unknown[]; has_more: boolean };
    return `${count(page.drops.length, "drop")}${page.has_more ? ", more on the next page" : ""}`;
  },
  delete: (input) => `Deleted: ${String(input.target)}`,
  "user.add": (_input, value) =>
    `Added ${(value as { user: { label: string } }).user.label}; the key is in this response once.`,
  "user.list": (_input, value) => count((value as { users: unknown[] }).users.length, "key"),
  "user.remove": (input) => `Removed ${String(input.label)}; their key no longer works.`,
  "config.get": () => "The instance policy.",
  "config.set": () => "Policy changed; it applies to future calls only.",
  usage: (_input, value) => `Usage: ${count((value as { total: { count: number } }).total.count, "drop")}`,
  prune: (input, value) => {
    const report = value as { total: { count: number } };
    return input.dry_run === false
      ? `Pruned; ${count(report.total.count, "drop")} remain`
      : `Prune, dry run: ${count(report.total.count, "drop")} counted, nothing deleted`;
  },
  doctor: (_input, value) => ((value as { ok: boolean }).ok ? "Doctor: ok" : "Doctor: FAILED"),
  "doctor.checks": (_input, value) => count((value as { checks: unknown[] }).checks.length, "check"),
};

export function successResult(
  operation: string,
  input: Record<string, unknown>,
  value: unknown,
): CallToolResult {
  const line = LINES[operation];
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
