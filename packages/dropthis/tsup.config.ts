import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli.ts" },
  format: ["cjs"],
  target: "node22",
  clean: true,
  banner: { js: "#!/usr/bin/env node" },
});
