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

export function makeClient(creds: CloudflareCreds): Cloudflare {
  return new Cloudflare({
    apiToken: creds.apiToken,
    ...(creds.apiBase ? { baseURL: creds.apiBase } : {}),
  });
}
