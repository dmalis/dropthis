import { buildCli } from "./cli-harness.js";

/** The `cli` project's global setup: build `dist/cli.cjs` once for every file. */
export default async function setup(): Promise<void> {
  await buildCli();
}
