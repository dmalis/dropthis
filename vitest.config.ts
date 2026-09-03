import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          /**
           * `@cloudflare/workers-oauth-provider` imports `cloudflare:workers`
           * at load; under Node that module does not exist. The stub gives it
           * the one class it wants, so the OAuth dance can run in-memory here.
           */
          alias: { "cloudflare:workers": new URL("./packages/worker/test/stubs/cloudflare-workers.ts", import.meta.url).pathname },
          // Inlined so the alias applies: an external module is loaded by Node itself.
          server: { deps: { inline: ["@cloudflare/workers-oauth-provider"] } },
          // The unit project runs FIRST and alone (groupOrder). Its installer
          // tests each start a localhost fake of the Cloudflare API; running
          // them beside the contract project's twenty minutes of network I/O
          // starved those servers and produced socket resets that look like
          // product failures. Measured: three false failures in that shape.
          sequence: { groupOrder: 0 },
          include: [
            "packages/*/test/**/*.test.ts",
            "test/fake-cloudflare/test/**/*.test.ts",
          ],
          environment: "node",
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: "contract",
          /** After the unit project; see the note there. */
          sequence: { groupOrder: 1 },
          include: ["contract-tests/**/*.test.ts"],
          environment: "node",
          /**
           * Measured against the deployed dev instance: one publish is ~3.6 s
           * (nine sequential R2 round trips plus the two the bearer lookup
           * costs) and a 100-row `list` page ~10 s (one head per row). A test
           * that publishes a handful of drops and lists them needs a budget in
           * that shape; 30 s was written when requests were unauthenticated
           * and the bucket was empty.
           */
          testTimeout: 120_000,
          globalSetup: ["contract-tests/global-setup.ts"],
          /**
           * One deployed Worker, one bucket, one instance policy — so the
           * contract files share mutable state and cannot run in parallel.
           * `config set` is prospective and instance-wide, and `usage` counts
           * every drop in the bucket: a file that publishes while another
           * file has tightened expiry, or is asserting what the bucket
           * contains, measures the other file and not the contract.
           */
          fileParallelism: false,
        },
      },
    ],
  },
});
