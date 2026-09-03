/**
 * Which Cloudflare credential this `init` runs with (decision #67).
 *
 * Two modes, one rule: never guess the account.
 *
 *   automation  `CLOUDFLARE_API_TOKEN` (+ optional `CLOUDFLARE_ACCOUNT_ID`).
 *               An env token ALWAYS wins, even at a terminal — a run in CI and
 *               a run on a laptop must not deploy to different accounts.
 *   human       No token, a real terminal, no agent: wrangler's browser login,
 *               one Allow click. Allowed only when exactly one account is
 *               visible; more than one and the run stops with the list, because
 *               a wrong-account deploy is not something an operator can undo.
 *
 * Non-interactive with no token is exit 4 (`gh`'s "auth required") and names
 * the token page and the four permissions verbatim, so the remediation is the
 * whole fix.
 */
export const TOKEN_URL = "https://dash.cloudflare.com/profile/api-tokens";

/** The dashboard's own names, echoed verbatim (decision #41). */
export const TOKEN_PERMISSIONS = [
  "Workers Scripts — Edit",
  "Workers KV Storage — Edit",
  "Workers R2 Storage — Edit",
  "Account Settings — Read",
] as const;

/** Only `--domain` needs these, so they are named separately. */
export const DOMAIN_TOKEN_PERMISSIONS = ["Zone DNS — Edit", "Zone Workers Routes — Edit"] as const;

export type LoginOutcome =
  | { ok: true; token: string; accounts: Array<{ id: string; name: string }> }
  | { ok: false; detail: string };

export type CredentialInput = {
  env: Record<string, string | undefined>;
  interactive: boolean;
  /** `--account-id`, the explicit answer to "which account". */
  accountId?: string;
  browserLogin: () => Promise<LoginOutcome>;
};

export type CredentialResult =
  | { ok: true; token: string; accountId?: string; source: "env" | "browser-login" }
  | { ok: false; exitCode: 1 | 4; message: string; remediation: string };

const EXIT_FAILURE = 1;
const EXIT_AUTH = 4;

export async function resolveCloudflareCredential(input: CredentialInput): Promise<CredentialResult> {
  const token = nonEmpty(input.env.CLOUDFLARE_API_TOKEN);
  const envAccount = nonEmpty(input.env.CLOUDFLARE_ACCOUNT_ID);

  if (token !== undefined) {
    const accountId = input.accountId ?? envAccount;
    return { ok: true, token, source: "env", ...(accountId === undefined ? {} : { accountId }) };
  }

  if (envAccount !== undefined) {
    return {
      ok: false,
      exitCode: EXIT_AUTH,
      message: "CLOUDFLARE_ACCOUNT_ID is set but CLOUDFLARE_API_TOKEN is not.",
      remediation: `Set CLOUDFLARE_API_TOKEN too. Create one at ${TOKEN_URL} with: ${TOKEN_PERMISSIONS.join(", ")}.`,
    };
  }

  if (!input.interactive) {
    return {
      ok: false,
      exitCode: EXIT_AUTH,
      message: "No Cloudflare credential: CLOUDFLARE_API_TOKEN is not set and this run cannot open a browser.",
      remediation: `Create a token at ${TOKEN_URL} with these permissions: ${TOKEN_PERMISSIONS.join(", ")} (add ${DOMAIN_TOKEN_PERMISSIONS.join(" and ")} for --domain), then set CLOUDFLARE_API_TOKEN.`,
    };
  }

  const login = await input.browserLogin();
  if (!login.ok) {
    return {
      ok: false,
      exitCode: EXIT_FAILURE,
      message: `Signing in to Cloudflare failed: ${login.detail}`,
      remediation: `Try again, or create a token at ${TOKEN_URL} with: ${TOKEN_PERMISSIONS.join(", ")}.`,
    };
  }

  if (input.accountId !== undefined) {
    return { ok: true, token: login.token, accountId: input.accountId, source: "browser-login" };
  }
  if (login.accounts.length === 1) {
    return { ok: true, token: login.token, accountId: login.accounts[0]!.id, source: "browser-login" };
  }
  if (login.accounts.length === 0) {
    return {
      ok: false,
      exitCode: EXIT_FAILURE,
      message: "That Cloudflare login sees no accounts.",
      remediation: "Sign in with an account that has one, or pass a token for the right account.",
    };
  }
  return {
    ok: false,
    exitCode: EXIT_FAILURE,
    message: `That Cloudflare login sees several accounts, and this installer never guesses which one to deploy into: ${login.accounts
      .map((account) => `${account.name} (${account.id})`)
      .join(", ")}.`,
    remediation: "Run init again with --account-id <id>, or set CLOUDFLARE_API_TOKEN scoped to one account.",
  };
}

const nonEmpty = (value: string | undefined): string | undefined =>
  value !== undefined && value.length > 0 ? value : undefined;
