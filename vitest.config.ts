import { defineConfig } from "vitest/config";

/**
 * `.md` files import as their text, the way Wrangler's `Text` rule bundles
 * them for the Worker — so `skills/instance-skill.md` is one source read by
 * both the deployed `/_skill.md` route and the unit tests.
 */
const markdownAsText = {
  name: "markdown-as-text",
  enforce: "pre" as const,
  transform(code: string, id: string) {
    if (!id.endsWith(".md")) return null;
    return { code: `export default ${JSON.stringify(code)};`, map: null };
  },
};

/**
 * `@cloudflare/workers-oauth-provider` imports `cloudflare:workers` at load,
 * and under Node that module does not exist. Every project that loads the
 * Worker app needs the stub: the unit tests run it in-process, and the `cli`
 * tests serve it on localhost for the binary to talk to.
 */
const workersRuntimeStub = {
  alias: {
    "cloudflare:workers": new URL(
      "./packages/worker/test/stubs/cloudflare-workers.ts",
      import.meta.url,
    ).pathname,
  },
  // Inlined so the alias applies: an external module is loaded by Node itself.
  server: { deps: { inline: ["@cloudflare/workers-oauth-provider"] } },
};

export default defineConfig({
  test: {
    projects: [
      {
        // Inline projects are their own Vite configs: the plugin goes on each.
        plugins: [markdownAsText],
        test: {
          name: "unit",
          ...workersRuntimeStub,
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
          exclude: ["**/node_modules/**", "packages/dropthis/test/cli*.test.ts"],
          environment: "node",
          testTimeout: 30_000,
        },
      },
      {
        plugins: [markdownAsText],
        test: {
          name: "cli",
          ...workersRuntimeStub,
          /**
           * Seam 2: the built `dropthis` binary as a subprocess, against the
           * real Worker app served on localhost. One build per run (the
           * global setup), then the files one at a time: each spawns servers
           * and processes, and a rebuild racing a running binary — tsup
           * cleans `dist/` first — produced empty output and reset sockets.
           */
          sequence: { groupOrder: 1 },
          include: ["packages/dropthis/test/cli*.test.ts"],
          environment: "node",
          testTimeout: 30_000,
          globalSetup: ["packages/dropthis/test/build-cli.ts"],
          fileParallelism: false,
        },
      },
      {
        test: {
          name: "contract",
          /** After the unit and cli projects; see the note on unit. */
          sequence: { groupOrder: 2 },
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
