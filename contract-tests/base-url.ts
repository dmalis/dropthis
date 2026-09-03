/**
 * The deployed dev instance every contract test runs against.
 *
 * It is one instance per developer, not one shared one: the run resets the
 * bucket and deploys its own build, so two runs against the same instance
 * answer each other's requests. `DROPTHIS_DEV_INSTANCE` picks the instance,
 * exactly as `scripts/deploy-dev.mjs --instance <name>` deploys it, and
 * `DROPTHIS_DEV_URL` overrides the URL when the Worker is not on the default
 * `workers.dev` subdomain.
 */
export const DEV_INSTANCE = process.env.DROPTHIS_DEV_INSTANCE ?? "dev";

export const BASE_URL = (
  process.env.DROPTHIS_DEV_URL ?? `https://dropthis-${DEV_INSTANCE}.dropthis-app.workers.dev`
).replace(/\/$/, "");

export const DEV_BUCKET = `dropthis-${DEV_INSTANCE}-drops`;

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

/**
 * The admin key `global-setup.ts` mints for this run. It is provided rather
 * than stored: a fixed key in the repo would be a live credential on a real
 * instance, and the dev instance is real.
 */
declare module "vitest" {
  interface ProvidedContext {
    adminKey: string;
  }
}
