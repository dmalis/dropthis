/**
 * Which secrets the deployed Worker already holds.
 *
 * `HMAC_SECRET` signs unlock cookies and staged-upload URLs, and it encrypts
 * every stored idempotency result. Re-shipping a fresh one on a rerun of
 * `init` would silently invalidate all three — every unlocked visitor is
 * locked out again, every in-flight signed upload URL stops verifying, and
 * every stored result becomes unreadable. So a rerun ships the secret only
 * when the Worker has none, and this is the question that decides it.
 *
 * Names only: Cloudflare never returns a secret's value, and neither does
 * this.
 */
import type Cloudflare from "cloudflare";

/** `undefined` means the script does not exist yet — this is a first deploy. */
export async function workerSecretNames(
  client: Cloudflare,
  accountId: string,
  scriptName: string,
): Promise<string[] | undefined> {
  const names: string[] = [];
  try {
    for await (const secret of client.workers.scripts.secrets.list(scriptName, { account_id: accountId })) {
      if (typeof secret.name === "string") names.push(secret.name);
    }
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  return names;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status?: number }).status === 404
  );
}
