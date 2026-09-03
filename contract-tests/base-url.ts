/** The deployed dev Worker every contract test runs against. */
export const BASE_URL = (
  process.env.DROPTHIS_DEV_URL ?? "https://dropthis-dev.dropthis-app.workers.dev"
).replace(/\/$/, "");

export const DEV_BUCKET = "dropthis-dev-drops";

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `${name} is not set. Source the dev credentials first: ` +
        "`source ~/.config/dropthis/dev.env` (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID).",
    );
  }
  return value;
}
