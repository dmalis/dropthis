/**
 * The two things `init` does AFTER wrangler says it deployed: wait until the
 * instance actually answers, then make it prove itself.
 *
 * "wrangler exited 0" is not "the instance works" — the deploy still has to
 * propagate, and a version-correct deploy with a dead MCP endpoint is a broken
 * deploy (AGENTS.md, "Installer principles"). So the poll is on `/_api/v1/health`,
 * the one unauthenticated route, and the proof is the instance's own `doctor`.
 *
 * Neither ever throws: an installer that dies on a network blip has told the
 * operator nothing. Both answer with a result the caller turns into a step.
 */
import type { DoctorReport } from "../../../worker/src/operations/doctor.js";

export type PollOptions = {
  /** Bounded on purpose: an agent must never wait on this forever. */
  timeoutMs?: number;
  intervalMs?: number;
};

export type PollResult = { ok: boolean; attempts: number; detail: string };

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_INTERVAL_MS = 2_000;
/** One attempt's own budget: a hung socket must not eat the whole deadline. */
const ATTEMPT_TIMEOUT_MS = 10_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function pollHealth(baseUrl: string, options: PollOptions = {}): Promise<PollResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const url = `${baseUrl.replace(/\/+$/, "")}/_api/v1/health`;
  const deadline = Date.now() + timeoutMs;

  let attempts = 0;
  let last = "no answer yet";
  for (;;) {
    attempts += 1;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS) });
      const text = await response.text();
      // A 200 is not enough: a captive portal and a parked domain both answer
      // 200 with HTML. Only this instance's own `{ok: true}` counts.
      if (response.ok && isHealthy(text)) {
        return { ok: true, attempts, detail: `${url} answered ok after ${attempts} attempt(s).` };
      }
      last = `HTTP ${response.status}: ${text.slice(0, 120)}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() + intervalMs >= deadline) {
      return { ok: false, attempts, detail: `${url} did not answer within ${timeoutMs} ms — last: ${last}` };
    }
    await sleep(intervalMs);
  }
}

function isHealthy(text: string): boolean {
  try {
    return (JSON.parse(text) as { ok?: unknown }).ok === true;
  } catch {
    return false;
  }
}

/**
 * The instance's `doctor`, over HTTP, with the admin key. A transport failure
 * or a rejected key becomes a report that fails — never an exception, and
 * never a message carrying the key.
 */
export async function runRemoteDoctor(baseUrl: string, key: string): Promise<DoctorReport> {
  const url = `${baseUrl.replace(/\/+$/, "")}/_api/v1/doctor`;
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    if (!response.ok) {
      return unreachable(`${url} answered HTTP ${response.status}: ${redact(text.slice(0, 200), key)}`);
    }
    const parsed = JSON.parse(text) as DoctorReport;
    if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed.checks)) {
      return unreachable(`${url} answered something that is not a doctor report.`);
    }
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return unreachable(`${url} could not be reached: ${redact(message, key)}`);
  }
}

/**
 * `doctor` could not run at all. It is reported as the one check that always
 * exists, so the caller has the same `{id, status, evidence, remediation}`
 * row shape whether the instance answered or not.
 */
function unreachable(evidence: string): DoctorReport {
  return {
    ok: false,
    checks: [
      {
        id: "hello_drop",
        status: "fail",
        evidence,
        remediation: "Check the instance URL and the admin key, then run `dropthis doctor` again.",
      },
    ],
  };
}

const redact = (text: string, key: string): string => (key.length > 0 ? text.split(key).join("<redacted>") : text);
