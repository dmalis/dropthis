/**
 * The shared test seam for `runInit`: a deploy that leaves behind exactly what
 * a real one does — a script registered with the account API, and the bucket
 * it just wrote served by the REAL Worker app. So `health` and `doctor` are
 * answered by the product, offline, and no test waits on a network timeout.
 */
import { startFakeInstance } from "../../../../test/fake-cloudflare/src/instance.js";
import type { startFakeCloudflare } from "../../../../test/fake-cloudflare/src/server.js";
import type { RenderedWranglerConfig } from "../../src/init/plan-render.js";

type Fake = Awaited<ReturnType<typeof startFakeCloudflare>>;

export type DeployCall = { config: RenderedWranglerConfig; secrets: Record<string, string> | undefined };

/** Fast and bounded: nothing in a unit test may wait on a real deadline. */
export const FAST_POLL = { timeoutMs: 5_000, intervalMs: 10 };

/** The bucket as the installer wrote it, in the shape `startFakeInstance` seeds. */
export function bucketObjects(cf: Fake, bucketName: string): Array<[string, Uint8Array]> {
  return [...(cf.state.objects.get(bucketName) ?? new Map()).entries()].map(
    ([key, object]) => [key, object.body] as [string, Uint8Array],
  );
}

export function stubDeploy(cf: Fake, teardown: Array<() => Promise<void>>) {
  const calls: DeployCall[] = [];
  const deploy = async (config: RenderedWranglerConfig, secrets: Record<string, string> | undefined) => {
    calls.push({ config, secrets });
    await fetch(`${cf.origin}/__deploy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: config.name,
        secrets: Object.keys(secrets ?? {}),
        bindings: [
          { type: "r2_bucket", name: "BUCKET", bucket_name: config.r2_buckets[0]!.bucket_name },
          { type: "kv_namespace", name: "OAUTH_KV", namespace_id: config.kv_namespaces[0]!.id },
        ],
      }),
    });
    const instance = await startFakeInstance({
      objects: bucketObjects(cf, config.r2_buckets[0]!.bucket_name),
    });
    teardown.push(() => instance.close());
    return { url: instance.url };
  };
  return { deploy, calls };
}
