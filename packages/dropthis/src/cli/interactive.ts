/**
 * Whether this run may ask a question, and how it asks one.
 *
 * Non-interactive by default when stdin or stdout is not a terminal or an
 * agent is detected (`@vercel/detect-agent`, the Vercel CLI's own rule);
 * `--yes` is the explicit form. A non-interactive run never prompts: it
 * proceeds as if every question were answered yes, because a hung prompt is
 * the one failure an agent cannot recover from. `DROPTHIS_INTERACTIVE=1`
 * forces prompts on (as `GH_FORCE_TTY` does for gh) so the prompt path itself
 * can be tested through a pipe; `0` forces them off.
 *
 * Prompts go to stderr and read stdin: stdout stays the result.
 */
import type { Readable, Writable } from "node:stream";
import { confirm as clackConfirm, isCancel } from "@clack/prompts";
import { determineAgent } from "@vercel/detect-agent";
import { Cancelled } from "./errors.js";

export type Interactivity = {
  env: Record<string, string | undefined>;
  stdin: Readable & { isTTY?: boolean };
  stdout: Writable & { isTTY?: boolean };
  yes: boolean;
};

export async function isInteractive(input: Interactivity): Promise<boolean> {
  if (input.yes) return false;
  const forced = input.env.DROPTHIS_INTERACTIVE;
  if (forced === "1") return true;
  if (forced === "0") return false;
  if (input.stdin.isTTY !== true || input.stdout.isTTY !== true) return false;
  return !(await determineAgent()).isAgent;
}

export type ConfirmIo = { stdin: Readable; stderr: Writable };

/**
 * Yes or no, or `Cancelled` (exit 2) on "no", Ctrl-C or SIGINT. The signal
 * handler exists for the last: a SIGINT that arrives as a signal, not as a
 * keypress in raw mode, would otherwise end the process with no exit code of
 * ours at all. It aborts the prompt, which closes the prompt's own readline —
 * the process then has nothing left open and exits with our code. Once
 * interrupted, the listener stays: a second SIGINT while we are already on
 * our way out must not turn exit 2 into a death by signal.
 */
export async function confirm(message: string, io: ConfirmIo): Promise<void> {
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.on("SIGINT", onSigint);
  const answer = await clackConfirm({
    message,
    input: io.stdin,
    output: io.stderr,
    initialValue: false,
    signal: controller.signal,
  });
  if (!controller.signal.aborted) process.removeListener("SIGINT", onSigint);
  if (isCancel(answer) || answer !== true) throw new Cancelled();
}
