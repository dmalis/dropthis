import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A wrangler that behaves like a deploy without being one: it reports what it
 * uploaded to the fake account API, which is what makes the secret rule and
 * the KV-binding check answerable offline.
 */
export async function stubWranglerBinary(cfOrigin: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dropthis-wr-"));
  const path = join(dir, "wrangler.js");
  await writeFile(
    path,
    [
      "const { readFileSync } = require('node:fs');",
      "const argv = process.argv.slice(2);",
      "const at = (flag) => { const i = argv.indexOf(flag); return i === -1 ? null : argv[i + 1]; };",
      "const config = JSON.parse(readFileSync(at('-c'), 'utf8'));",
      "const secretsPath = at('--secrets-file');",
      "const secrets = secretsPath ? Object.keys(JSON.parse(readFileSync(secretsPath, 'utf8'))) : [];",
      `fetch(${JSON.stringify(`${cfOrigin}/__deploy`)}, {`,
      "  method: 'POST', headers: { 'content-type': 'application/json' },",
      "  body: JSON.stringify({ name: config.name, secrets, bindings: [",
      "    { type: 'r2_bucket', name: 'BUCKET', bucket_name: config.r2_buckets[0].bucket_name },",
      "    { type: 'kv_namespace', name: 'OAUTH_KV', namespace_id: config.kv_namespaces[0].id },",
      "  ] })",
      "}).then(() => process.exit(0), () => process.exit(1));",
    ].join("\n"),
    "utf8",
  );
  return path;
}
