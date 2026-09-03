import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli.ts" },
  format: ["cjs"],
  target: "node22",
  clean: true,
  banner: { js: "#!/usr/bin/env node" },
  // The registry (and with it zod and canonicalize) is bundled from the worker
  // package; the three CLI libraries are bundled too so the built file has no
  // ESM-only require at runtime.
  noExternal: ["commander", "@clack/prompts", "@vercel/detect-agent"],
});
