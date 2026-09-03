import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
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
          include: ["contract-tests/**/*.test.ts"],
          environment: "node",
          testTimeout: 30_000,
          globalSetup: ["contract-tests/global-setup.ts"],
          /**
           * One deployed Worker, one bucket, one instance policy — so the
           * contract files share mutable state and cannot run in parallel.
           * `config set` is prospective and instance-wide, and `usage` counts
           * every drop in the bucket: a file that publishes while another
           * file has tightened expiry fails for a reason that has nothing to
           * do with the contract.
           */
          fileParallelism: false,
        },
      },
    ],
  },
});
