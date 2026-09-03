import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startFakeCloudflare } from "../../../../test/fake-cloudflare/src/server.js";
import { bootstrapAdminKey } from "../../src/init/admin-bootstrap.js";
import { makeClient } from "../../src/init/cloudflare-client.js";
import { getObjectJson } from "../../src/init/r2-objects.js";

const teardown: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (teardown.length > 0) await teardown.pop()!();
});

async function fake(options: Parameters<typeof startFakeCloudflare>[0] = {}) {
  const started = await startFakeCloudflare(options);
  teardown.push(() => started.close());
  return started;
}

const ACCOUNT = "fake-account-id";
const BUCKET = "dropthis-x-drops";

describe("bootstrapAdminKey — fresh install", () => {
  it("mints a key, writes the three records, and returns the key exactly once", async () => {
    const cf = await fake({ buckets: [BUCKET] });
    const client = makeClient({ apiToken: "fake-token", accountId: ACCOUNT, apiBase: cf.apiBase });

    const result = await bootstrapAdminKey(client, ACCOUNT, BUCKET);

    expect(result.status).toBe("created");
    expect(result.key).toBeDefined();
    expect(result.key).toMatch(/^[0-9a-f]{64}$/);

    const keyRecord = await getObjectJson<{ id: string; label: string; scope: string; hash: string }>(
      client,
      ACCOUNT,
      BUCKET,
      "keys/admin.json",
    );
    expect(keyRecord).toMatchObject({ id: "admin", label: "admin", scope: "admin" });
    expect(keyRecord!.hash).toBe(createHash("sha256").update(result.key!).digest("hex"));

    const hashPointer = await getObjectJson<{ id: string }>(
      client,
      ACCOUNT,
      BUCKET,
      `keyhash/${keyRecord!.hash}`,
    );
    expect(hashPointer).toEqual({ id: "admin" });

    const userPointer = await getObjectJson<{ id: string }>(client, ACCOUNT, BUCKET, "users/admin");
    expect(userPointer).toEqual({ id: "admin" });
  });

  it("never writes the key to stdout, stderr or console", async () => {
    const cf = await fake({ buckets: [BUCKET] });
    const client = makeClient({ apiToken: "fake-token", accountId: ACCOUNT, apiBase: cf.apiBase });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const result = await bootstrapAdminKey(client, ACCOUNT, BUCKET);

    for (const spy of [logSpy, errorSpy, stdoutSpy, stderrSpy]) {
      for (const call of spy.mock.calls) {
        expect(String(call[0])).not.toContain(result.key);
      }
    }
    logSpy.mockRestore();
    errorSpy.mockRestore();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });
});

describe("bootstrapAdminKey — rerun", () => {
  it("finds the existing admin and never re-derives or returns the key", async () => {
    const cf = await fake({ buckets: [BUCKET] });
    const client = makeClient({ apiToken: "fake-token", accountId: ACCOUNT, apiBase: cf.apiBase });

    const first = await bootstrapAdminKey(client, ACCOUNT, BUCKET);
    const second = await bootstrapAdminKey(client, ACCOUNT, BUCKET);

    expect(second.status).toBe("existing");
    expect(second.key).toBeUndefined();
    // the stdout/stderr surface never carries the key past the one return —
    // assert the fake never saw a second key/keyhash write for a different hash.
    const keyRecord = await getObjectJson<{ hash: string }>(client, ACCOUNT, BUCKET, "keys/admin.json");
    expect(keyRecord!.hash).toBe(createHash("sha256").update(first.key!).digest("hex"));
  });
});

describe("bootstrapAdminKey — crash between writes", () => {
  it("finishes cleanly when a previous run wrote the key record but not the user pointer", async () => {
    const cf = await fake({ buckets: [BUCKET] });
    const client = makeClient({ apiToken: "fake-token", accountId: ACCOUNT, apiBase: cf.apiBase });

    // Simulate a crash after step 1 (keys/admin.json) but before keyhash/ and
    // users/admin ever landed.
    const orphanHash = "0".repeat(64);
    const { putObjectJson } = await import("../../src/init/r2-objects.js");
    await putObjectJson(client, ACCOUNT, BUCKET, "keys/admin.json", {
      id: "admin",
      label: "admin",
      scope: "admin",
      hash: orphanHash,
      created: "2020-01-01T00:00:00.000Z",
    });

    const result = await bootstrapAdminKey(client, ACCOUNT, BUCKET);

    expect(result.status).toBe("created");
    expect(result.key).toBeDefined();
    const userPointer = await getObjectJson<{ id: string }>(client, ACCOUNT, BUCKET, "users/admin");
    expect(userPointer).toEqual({ id: "admin" });
    const keyRecord = await getObjectJson<{ hash: string }>(client, ACCOUNT, BUCKET, "keys/admin.json");
    expect(keyRecord!.hash).not.toBe(orphanHash);
  });
});
