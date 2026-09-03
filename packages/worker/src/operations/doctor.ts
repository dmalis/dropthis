/**
 * `doctor` — a named check registry (decision #29).
 *
 * Every check here is answerable with the INSTANCE key alone. Account-level
 * checks (lifecycle rules, the KV binding, the attached domain) need the
 * Cloudflare token and belong to `init --check`, never here: an operator
 * running `doctor` against a client's instance has the key, not the account.
 *
 * A check whose subject does not exist yet is `skip`, never `pass`. A green
 * report has to mean "this was proved", and a check that did not run proves
 * nothing.
 *
 * `hello_drop` is the one that matters: a version-correct deploy that cannot
 * publish is a broken deploy, so the check publishes, reads the bytes back and
 * deletes — the whole write order, against the real bucket, on demand.
 */
import type { Bucket } from "../bindings.js";
import { CONFIG_KEY, blobKey, metaKey, slugKey, userKey } from "../storage/keys.js";
import type { InstanceConfig } from "../instance-config.js";
import { INITIAL_POLICY } from "../policy/defaults.js";
import { deleteDrop } from "./delete.js";
import { publish } from "./publish.js";

export const CHECK_IDS = [
  "hello_drop",
  "mcp_initialize",
  "policy_readable",
  "cron_state",
  "canonical_origin",
  "pbkdf2_benchmark",
  "admin_rotation_clean",
] as const;

export type CheckId = (typeof CHECK_IDS)[number];
export type CheckStatus = "pass" | "fail" | "skip";

export type CheckResult = {
  id: CheckId;
  status: CheckStatus;
  /** What was observed. Never a secret, never a key. */
  evidence: string;
  /** One imperative sentence, present only when the check did not pass. */
  remediation?: string;
};

export type DoctorReport = { ok: boolean; checks: CheckResult[] };

export const CHECK_DESCRIPTIONS: Record<CheckId, string> = {
  hello_drop: "Publish a drop, read its bytes back and delete it.",
  mcp_initialize: "Ask the MCP endpoint to initialize and answer with its tool list.",
  policy_readable: "Read system/config.json and confirm it parses into a policy.",
  cron_state: "Read the cron's checkpoint and confirm it is not stranded.",
  canonical_origin: "Confirm the instance knows the origin its URLs are built from.",
  pbkdf2_benchmark: "Time one PBKDF2 derive at this instance's iteration count.",
  admin_rotation_clean: "Confirm no admin key rotation is half finished.",
};

export function checkList(): Array<{ id: CheckId; description: string }> {
  return CHECK_IDS.map((id) => ({ id, description: CHECK_DESCRIPTIONS[id] }));
}

export type DoctorContext = {
  bucket: Bucket;
  config: InstanceConfig;
  now: Date;
  secret: string;
  /** The `doctor` call itself: its origin and its credential feed the MCP probe. */
  request: Request;
  /** This Worker, in-process (`OperationContext.self`). */
  self(request: Request): Promise<Response>;
};

/** The unlock budget the measured default was chosen to fit (decision #73). */
export const UNLOCK_BUDGET_MS = 8;

/**
 * Derives to time before judging. The cost of a derive is what the check is
 * about; a single sample also measures whatever else the machine was doing at
 * that moment, so the report is the FASTEST of a few — the honest floor of
 * what an unlock will cost.
 */
const BENCHMARK_ROUNDS = 3;

export async function doctor(ctx: DoctorContext): Promise<DoctorReport> {
  // One read of the stored config, shared by the two checks that judge it.
  // The RESOLVED config cannot answer either question: its reader is tolerant
  // on purpose, so a missing `canonical_url` falls back to whatever host the
  // request arrived on and looks correct exactly when it is wrong.
  const stored = await readStoredConfig(ctx.bucket);

  const checks: CheckResult[] = [
    await helloDrop(ctx),
    await mcpInitialize(ctx),
    policyReadable(stored),
    {
      id: "cron_state",
      status: "skip",
      evidence: "This instance runs no cron yet; it arrives with issue #6.",
    },
    canonicalOrigin(stored),
    await pbkdf2Benchmark(ctx),
    await adminRotationClean(ctx),
  ];

  return { ok: checks.every((check) => check.status !== "fail"), checks };
}

/**
 * Publish → read back → delete, through the real write order. It uses no
 * idempotency key: the point is to exercise the path a caller takes, and the
 * drop is removed whatever happens, so a failed run leaves the bucket as it
 * found it.
 */
async function helloDrop(ctx: DoctorContext): Promise<CheckResult> {
  const body = `dropthis doctor ${ctx.now.toISOString()}`;
  let slug: string | null = null;

  try {
    const result = await publish(
      {
        files: [{ path: "hello.txt", text: body }],
        title: "doctor",
        expires: "1d",
        noindex: true,
      },
      {
        bucket: ctx.bucket,
        config: ctx.config,
        caller: { id: "doctor", label: "doctor" },
        now: ctx.now,
        secret: ctx.secret,
      },
    );
    slug = result.drop.slug;

    const pointer = await ctx.bucket.get(slugKey(slug));
    if (pointer === null) throw new Error("the slug pointer was not written");
    const dropId = (await pointer.text()).trim();

    const meta = await ctx.bucket.get(metaKey(dropId));
    if (meta === null) throw new Error("meta.json was not written");
    const parsed = JSON.parse(await meta.text()) as {
      manifest: Record<string, { sha256: string }>;
    };

    const entry = parsed.manifest["hello.txt"];
    if (entry === undefined) throw new Error("the manifest holds no hello.txt");
    const blob = await ctx.bucket.get(blobKey(dropId, entry.sha256));
    if (blob === null) throw new Error("the file body was not written");
    const served = await blob.text();
    if (served !== body) throw new Error("the bytes read back differ from the bytes published");

    // The real `delete`, not a second implementation of it: a check that
    // cleaned up its own way would stop proving the delete path works, and
    // would drift from it (it did — issue #5 moved the listing key).
    await deleteDrop(ctx.bucket, slug);

    return {
      id: "hello_drop",
      status: "pass",
      evidence: `Published, read back ${served.length} bytes and deleted a drop at /${slug}/.`,
    };
  } catch (error) {
    if (slug !== null) await bestEffortCleanup(ctx.bucket, slug);
    return {
      id: "hello_drop",
      status: "fail",
      evidence: `Publishing a drop failed: ${error instanceof Error ? error.message : String(error)}`,
      remediation: "Check the bucket binding and redeploy this instance.",
    };
  }
}

/**
 * `initialize` and `tools/list` against this Worker's own `/_api/mcp`, in
 * process, with the credential the `doctor` call carried. A version-correct
 * deploy with a dead MCP endpoint is a broken deploy (AGENTS.md, "Installer
 * principles"), and this is the check that says so. In-process rather than
 * over the network: a Worker cannot reliably fetch its own hostname, and a
 * service binding to itself would be one more thing `init` has to render.
 */
async function mcpInitialize(ctx: DoctorContext): Promise<CheckResult> {
  const fail = (evidence: string): CheckResult => ({
    id: "mcp_initialize",
    status: "fail",
    evidence,
    remediation: "Redeploy this instance; its MCP endpoint did not answer.",
  });

  try {
    const initialized = await mcpCall(ctx, 1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "dropthis-doctor", version: "0" },
    });
    if (initialized.status !== 200) {
      return fail(`initialize answered HTTP ${initialized.status}: ${initialized.text.slice(0, 200)}`);
    }
    const info = initialized.body?.result as { serverInfo?: { name?: string; version?: string } } | undefined;
    if (info?.serverInfo?.name !== "dropthis") {
      return fail(`initialize answered without a dropthis serverInfo: ${initialized.text.slice(0, 200)}`);
    }

    const listed = await mcpCall(ctx, 2, "tools/list", {});
    const tools = (listed.body?.result as { tools?: Array<{ name: string }> } | undefined)?.tools;
    if (listed.status !== 200 || !Array.isArray(tools) || tools.length === 0) {
      return fail(`tools/list answered HTTP ${listed.status} with no tools: ${listed.text.slice(0, 200)}`);
    }

    return {
      id: "mcp_initialize",
      status: "pass",
      evidence: `initialize answered dropthis ${info.serverInfo.version ?? "?"}; tools/list offers ${tools.length} tools.`,
    };
  } catch (error) {
    return fail(`The MCP probe threw: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function mcpCall(
  ctx: DoctorContext,
  id: number,
  method: string,
  params: unknown,
): Promise<{ status: number; text: string; body: { result?: unknown } | null }> {
  const headers = new Headers({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  });
  const credential = ctx.request.headers.get("authorization");
  if (credential !== null) headers.set("authorization", credential);

  const response = await ctx.self(
    new Request(`${new URL(ctx.request.url).origin}/_api/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    }),
  );
  const text = await response.text();
  let body: { result?: unknown } | null = null;
  try {
    body = JSON.parse(text) as { result?: unknown };
  } catch {
    body = null;
  }
  return { status: response.status, text, body };
}

/** A failed hello drop still must not leave a drop serving on the instance. */
async function bestEffortCleanup(bucket: Bucket, slug: string): Promise<void> {
  try {
    const pointer = await bucket.get(slugKey(slug));
    if (pointer === null) return;
    const dropId = (await pointer.text()).trim();
    const listing = await bucket.list({ prefix: `drops/${dropId}/` });
    await bucket.delete([...listing.objects.map((object) => object.key), slugKey(slug)]);
  } catch {
    // The report already says the instance is broken; a cleanup that also
    // fails adds nothing an operator can act on.
  }
}

/** `system/config.json` as it is on disk: present, parseable, or neither. */
type StoredConfig = { present: boolean; parsed: Record<string, unknown> | null };

async function readStoredConfig(bucket: Bucket): Promise<StoredConfig> {
  const object = await bucket.get(CONFIG_KEY);
  if (object === null) return { present: false, parsed: null };
  try {
    return { present: true, parsed: JSON.parse(await object.text()) as Record<string, unknown> };
  } catch {
    return { present: true, parsed: null };
  }
}

function policyReadable(stored: StoredConfig): CheckResult {
  if (!stored.present) {
    return {
      id: "policy_readable",
      status: "fail",
      evidence: `${CONFIG_KEY} does not exist.`,
      remediation: "Rerun `dropthis init` for this instance; it writes the config.",
    };
  }
  if (stored.parsed === null) {
    return {
      id: "policy_readable",
      status: "fail",
      evidence: `${CONFIG_KEY} is not valid JSON, so this instance is serving built-in defaults.`,
      remediation: "Rerun `dropthis init` for this instance to rewrite the config.",
    };
  }
  const missing = Object.keys(INITIAL_POLICY).filter((key) => stored.parsed![key] === undefined);
  return {
    id: "policy_readable",
    status: "pass",
    evidence:
      missing.length === 0
        ? `${CONFIG_KEY} holds every policy field.`
        : `${CONFIG_KEY} parses; ${missing.length} field(s) fall back to the built-in defaults.`,
  };
}

function canonicalOrigin(stored: StoredConfig): CheckResult {
  const value = stored.parsed?.canonical_url;
  if (typeof value !== "string" || !value.startsWith("http")) {
    return {
      id: "canonical_origin",
      status: "fail",
      evidence:
        `${CONFIG_KEY} holds no canonical_url, so drop URLs follow whichever host a ` +
        "request arrives on.",
      remediation: "Rerun `dropthis init` so it writes this instance's canonical URL.",
    };
  }
  return {
    id: "canonical_origin",
    status: "pass",
    evidence: `Drop URLs are built from ${value}.`,
  };
}

async function pbkdf2Benchmark(ctx: DoctorContext): Promise<CheckResult> {
  const iterations = ctx.config.policy.pbkdf2_iterations;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("a-password-of-realistic-length"),
    "PBKDF2",
    false,
    ["deriveBits"],
  );

  let elapsed = Number.POSITIVE_INFINITY;
  for (let round = 0; round < BENCHMARK_ROUNDS; round += 1) {
    const started = Date.now();
    await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
    elapsed = Math.min(elapsed, Date.now() - started);
  }

  if (elapsed > UNLOCK_BUDGET_MS) {
    return {
      id: "pbkdf2_benchmark",
      status: "fail",
      evidence: `${iterations} iterations cost ${elapsed} ms, over the ${UNLOCK_BUDGET_MS} ms unlock budget.`,
      remediation: "Lower pbkdf2_iterations with `config set` until a derive fits the budget.",
    };
  }
  return {
    id: "pbkdf2_benchmark",
    status: "pass",
    evidence: `${iterations} iterations cost ${elapsed} ms, inside the ${UNLOCK_BUDGET_MS} ms unlock budget.`,
  };
}

/**
 * `--rotate-admin-key` is crash-safe, not atomic: it writes `users/admin` as
 * `{id, previous}` and clears `previous` on a LATER run. A `previous` still
 * present means the old key's records may still exist — so the old key may
 * still work, which is the one thing a rotation had to end.
 */
async function adminRotationClean(ctx: DoctorContext): Promise<CheckResult> {
  const object = await ctx.bucket.get(userKey("admin"));
  if (object === null) {
    return {
      id: "admin_rotation_clean",
      status: "fail",
      evidence: "users/admin does not exist, so this instance has no admin key on record.",
      remediation: "Rerun `dropthis init` for this instance to restore the admin record.",
    };
  }
  try {
    const parsed = JSON.parse(await object.text()) as { id?: unknown; previous?: unknown };
    if (typeof parsed.previous === "string" && parsed.previous.length > 0) {
      return {
        id: "admin_rotation_clean",
        status: "fail",
        evidence: `users/admin still names a previous key id, so a rotation did not finish.`,
        remediation: "Rerun `dropthis init --rotate-admin-key`; it finishes the deletes first.",
      };
    }
    return {
      id: "admin_rotation_clean",
      status: "pass",
      evidence: `users/admin names one key id and no previous one.`,
    };
  } catch {
    return {
      id: "admin_rotation_clean",
      status: "fail",
      evidence: "users/admin is not valid JSON.",
      remediation: "Rerun `dropthis init` for this instance to rewrite the admin record.",
    };
  }
}
