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
           * One deployed Worker, one bucket, one run. Files that publish drops
           * while another file is asserting what the bucket contains are
           * measuring each other, not the contract — so the contract project
           * runs one file at a time.
           */
          fileParallelism: false,
        },
      },
    ],
  },
});
