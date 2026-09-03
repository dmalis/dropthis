import manifest from "../package.json";
import { main } from "./cli/main.js";

/**
 * The one `dropthis` binary: installer, client and stdio MCP proxy live here.
 * Every command is generated from the operation registry (`src/cli/`); the
 * installer (`src/init/`) joins when issue #10 wires it.
 */
main(process.argv.slice(2), manifest.version, {
  env: process.env,
  cwd: process.cwd(),
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
}).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`dropthis: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
