import Cloudflare from "cloudflare";

/**
 * Credentials + optional API base (tests point this at the fake). `accountId`
 * is carried here for callers' convenience (a known account skips
 * `pinAccount`'s guesswork) but the Cloudflare client itself never needs it
 * at construction — every SDK call takes `account_id` per-request.
 */
export type CloudflareCreds = {
  apiToken: string;
  accountId?: string;
  apiBase?: string;
};

/**
 * More retries than the SDK's default two. `init` makes dozens of API calls in
 * one run and a single dropped connection anywhere in the middle leaves an
 * account half provisioned — the one outcome the installer exists to avoid.
 * A transient reset is not a decision the operator should have to make.
 */
const MAX_RETRIES = 5;

export function makeClient(creds: CloudflareCreds): Cloudflare {
  return new Cloudflare({
    apiToken: creds.apiToken,
    maxRetries: MAX_RETRIES,
    ...(creds.apiBase ? { baseURL: creds.apiBase } : {}),
  });
}
