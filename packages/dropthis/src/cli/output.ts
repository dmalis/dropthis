/**
 * The output contract (AGENTS.md, "CLI conventions"): stdout carries the
 * result and nothing else; `--json` is exactly one JSON document; on
 * `publish` and `update` the plain result is the URL alone, so it pipes.
 * Errors are the frozen object on stderr — as JSON under `--json`, as one
 * readable line plus the remediation otherwise.
 */
import type { Writable } from "node:stream";
import type { CliError } from "./errors.js";

export type Mode = "plain" | "json" | "jsonl";

export type Io = {
  stdout: Writable;
  stderr: Writable;
};

export const jsonLine = (value: unknown): string => `${JSON.stringify(value)}\n`;

/** The one document `--json` prints, or the plain rendering of the same value. */
export function renderResult(io: Io, mode: Mode, opName: string, value: unknown): void {
  if (mode !== "plain") {
    io.stdout.write(jsonLine(value));
    return;
  }
  if (opName === "publish" || opName === "update") {
    io.stdout.write(`${(value as { url: string }).url}\n`);
    return;
  }
  if (opName === "delete") {
    io.stderr.write(`deleted ${(value as { slug: string }).slug}\n`);
    return;
  }
  io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function renderError(io: Io, mode: Mode, error: CliError): void {
  if (mode !== "plain") {
    io.stderr.write(jsonLine(error.toObject()));
    return;
  }
  io.stderr.write(`dropthis: ${error.code}: ${error.message}\n  ${error.remediation}\n`);
}
