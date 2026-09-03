import Cloudflare from "cloudflare";

/** Credentials + optional API base (tests point this at the fake). */
export type CloudflareCreds = {
  apiToken: string;
  accountId: string;
  apiBase?: string;
};

export function makeClient(creds: CloudflareCreds): Cloudflare {
  return new Cloudflare({
    apiToken: creds.apiToken,
    ...(creds.apiBase ? { baseURL: creds.apiBase } : {}),
  });
}
