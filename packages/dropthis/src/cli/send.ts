/**
 * Moving a file set to the instance: inline when it fits, staged when it does
 * not (AGENTS.md, "One call uploads a drop").
 *
 * Inline is one `publish`/`update` with base64 entries, each carrying its
 * digest. Staged is session → one PUT per missing blob → commit, and the
 * settings ride on the commit exactly as they would on `publish`. The caller
 * cannot tell which path ran: both return the same `Drop`.
 *
 * Two answers make the CLI switch or start over on its own:
 *   PAYLOAD_TOO_LARGE  the instance's ceiling is below the packaged default —
 *                      fall back to staged, once;
 *   UPDATE_CONFLICT    the target moved while the session was open — a fresh
 *                      session reads the new etag, once;
 *   UPLOAD_EXPIRED     the session died between steps — a fresh session, once,
 *                      unless an idempotency key pins this upload to it.
 */
import { readFile } from "node:fs/promises";
import { operation } from "../../../worker/src/registry/index.js";
import type { Operation } from "../../../worker/src/registry/index.js";
import { ApiClient } from "./client.js";
import type { Answer } from "./client.js";
import { CliError } from "./errors.js";
import type { LocalFile } from "./files.js";
import { chooseTransfer } from "./transfer.js";

export type Settings = Record<string, unknown>;

export type SendOptions = {
  /** The slug being updated; absent on publish. */
  target?: string | undefined;
  files: LocalFile[];
  settings: Settings;
};

type StagedSession = {
  upload_id: string;
  slug: string;
  missing: string[];
  put_urls: Record<string, string>;
};

const publishOp = () => operation("publish");
const updateOp = () => operation("update");
const uploadCreate = () => operation("upload.create");
const uploadCommit = () => operation("upload.commit");

export async function sendFiles(client: ApiClient, options: SendOptions): Promise<Answer> {
  if (chooseTransfer(options.files, options.settings) === "inline") {
    try {
      return await sendInline(client, options);
    } catch (error) {
      if (!(error instanceof CliError && error.code === "PAYLOAD_TOO_LARGE")) throw error;
    }
  }
  return sendStaged(client, options);
}

async function sendInline(client: ApiClient, options: SendOptions): Promise<Answer> {
  const files = [];
  for (const file of options.files) {
    files.push({
      path: file.path,
      base64: (await readFile(file.file)).toString("base64"),
      sha256: file.sha256,
    });
  }
  const body = { ...options.settings, files };
  if (options.target === undefined) return client.call(publishOp(), body);
  return client.call(updateOp(), { slug: options.target, ...body });
}

async function sendStaged(client: ApiClient, options: SendOptions): Promise<Answer> {
  const { idempotency_key: idempotencyKey, ...settings } = options.settings;
  const pinned = idempotencyKey !== undefined;

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await stageOnce(client, options, settings, idempotencyKey);
    } catch (error) {
      const restartable =
        error instanceof CliError &&
        attempt === 0 &&
        ((error.code === "UPDATE_CONFLICT" && options.target !== undefined) ||
          (error.code === "UPLOAD_EXPIRED" && !pinned));
      if (!restartable) throw error;
    }
  }
}

async function stageOnce(
  client: ApiClient,
  options: SendOptions,
  settings: Settings,
  idempotencyKey: unknown,
): Promise<Answer> {
  const manifest = options.files.map((file) => ({ path: file.path, size: file.size, sha256: file.sha256 }));
  const opened = await client.call<StagedSession>(uploadCreate() as Operation<never>, {
    ...(options.target === undefined ? {} : { target: options.target }),
    manifest,
    ...(idempotencyKey === undefined ? {} : { idempotency_key: idempotencyKey }),
  });
  const session = opened.value;

  const byDigest = new Map(options.files.map((file) => [file.sha256, file]));
  for (const digest of session.missing) {
    const url = session.put_urls[digest];
    const file = byDigest.get(digest);
    if (url === undefined || file === undefined) {
      throw new CliError("INTERNAL", `The instance asked for a blob this upload does not have: ${digest}.`);
    }
    await client.putBlob(url, file);
  }

  return client.call(uploadCommit() as Operation<never>, { id: session.upload_id, ...settings });
}
