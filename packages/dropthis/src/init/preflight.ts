import type Cloudflare from "cloudflare";

/**
 * Account preflight (AGENTS.md "Installer principles" / spec-v1.md
 * "Installer"): named permissions instead of raw HTTP codes, refuse to
 * guess between several accounts, the exact dashboard URL when R2 was
 * never enabled. Lives inside `init`, never in `doctor` (decision #44 /
 * spec-v1.md operation registry).
 */

export type TokenCheck = { ok: true; status: "active" } | { ok: false; status: string };

export async function checkToken(client: Cloudflare): Promise<TokenCheck> {
  try {
    const verified = await client.user.tokens.verify();
    if (verified.status === "active") return { ok: true, status: "active" };
    return { ok: false, status: verified.status };
  } catch {
    return { ok: false, status: "invalid" };
  }
}

export type AccountPinResult =
  | { ok: true; accountId: string }
  | { ok: false; code: "NO_ACCOUNTS" }
  | { ok: false; code: "ACCOUNT_NOT_VISIBLE" }
  | { ok: false; code: "MULTIPLE_ACCOUNTS"; accounts: Array<{ id: string; name: string }> };

export async function pinAccount(client: Cloudflare, explicitAccountId?: string): Promise<AccountPinResult> {
  const accounts: Array<{ id: string; name: string }> = [];
  for await (const account of client.accounts.list()) {
    accounts.push({ id: account.id, name: account.name });
  }

  if (accounts.length === 0) return { ok: false, code: "NO_ACCOUNTS" };

  if (explicitAccountId !== undefined) {
    const found = accounts.find((a) => a.id === explicitAccountId);
    if (!found) return { ok: false, code: "ACCOUNT_NOT_VISIBLE" };
    return { ok: true, accountId: explicitAccountId };
  }

  if (accounts.length === 1) return { ok: true, accountId: accounts[0]!.id };
  return { ok: false, code: "MULTIPLE_ACCOUNTS", accounts };
}

export type R2SubscriptionCheck = { ok: true } | { ok: false; dashboardUrl: string };

/** Cloudflare's real error code for "R2 subscription not enabled on this account". */
const R2_NOT_ENABLED_CODE = 10042;

export async function checkR2Subscription(client: Cloudflare, accountId: string): Promise<R2SubscriptionCheck> {
  try {
    await client.r2.buckets.list({ account_id: accountId, per_page: 1 });
    return { ok: true };
  } catch (error) {
    if (isCloudflareErrorCode(error, R2_NOT_ENABLED_CODE)) {
      return { ok: false, dashboardUrl: `https://dash.cloudflare.com/${accountId}/r2` };
    }
    throw error;
  }
}

export type MissingPermission = { permission: string };
export type PermissionsCheck = { ok: boolean; missing: MissingPermission[] };

/** One cheap read per permission, named as the dashboard would (AGENTS.md). */
export async function checkPermissions(client: Cloudflare, accountId: string): Promise<PermissionsCheck> {
  const probes: Array<{ permission: string; run: () => Promise<unknown> }> = [
    {
      permission: "Workers R2 Storage:Edit",
      run: () => client.r2.buckets.list({ account_id: accountId, per_page: 1 }),
    },
    {
      permission: "Workers KV Storage:Edit",
      run: async () => {
        for await (const _ns of client.kv.namespaces.list({ account_id: accountId, per_page: 1 })) break;
      },
    },
    {
      permission: "Workers Scripts:Edit",
      run: () => client.workers.subdomains.get({ account_id: accountId }),
    },
  ];

  const missing: MissingPermission[] = [];
  for (const probe of probes) {
    try {
      await probe.run();
    } catch (error) {
      if (isForbidden(error)) missing.push({ permission: probe.permission });
      else throw error;
    }
  }
  return { ok: missing.length === 0, missing };
}

/**
 * The `cloudflare` package ships both ESM and CJS builds, so `instanceof
 * APIError` is unreliable depending on which build resolved a given import
 * (a classic dual-package hazard) — duck-type on the SDK's own error shape
 * instead: `{status, errors: [{code, message}]}`.
 */
function asApiError(error: unknown): { status?: number; errors?: Array<{ code?: number }> } | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if (!("status" in error) && !("errors" in error)) return undefined;
  return error as { status?: number; errors?: Array<{ code?: number }> };
}

function isForbidden(error: unknown): boolean {
  return asApiError(error)?.status === 403;
}

function isCloudflareErrorCode(error: unknown, code: number): boolean {
  return asApiError(error)?.errors?.some((e) => e.code === code) ?? false;
}
