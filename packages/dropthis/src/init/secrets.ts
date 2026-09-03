import { randomBytes } from "node:crypto";

/** One HMAC_SECRET, generated once at install time and never re-derivable. */
export function generateHmacSecret(): string {
  return randomBytes(32).toString("hex");
}

/** The payload shape `wrangler deploy --secrets-file` expects. */
export function secretsFilePayload(hmacSecret: string): Record<string, string> {
  return { HMAC_SECRET: hmacSecret };
}
