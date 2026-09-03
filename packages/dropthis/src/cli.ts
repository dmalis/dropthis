import manifest from "../package.json";

/**
 * The one `dropthis` binary: installer, client and stdio MCP proxy live here.
 * It currently knows one thing — its own version — and says so plainly for
 * everything else, because an agent must never be left guessing what ran.
 */
export function run(argv: string[]): number {
  if (argv.length === 1 && argv[0] === "--version") {
    process.stdout.write(`${manifest.version}\n`);
    return 0;
  }
  process.stderr.write(
    `dropthis: this build only supports \`dropthis --version\`.\n`,
  );
  return 1;
}

process.exitCode = run(process.argv.slice(2));
