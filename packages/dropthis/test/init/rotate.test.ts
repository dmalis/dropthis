import { afterEach, describe, expect, it } from "vitest";
import { startFakeCloudflare } from "../../../../test/fake-cloudflare/src/server.js";
import { startFakeInstance } from "../../../../test/fake-cloudflare/src/instance.js";
import { bootstrapAdminKey } from "../../src/init/admin-bootstrap.js";
import { makeClient } from "../../src/init/cloudflare-client.js";
import { getObjectJson } from "../../src/init/r2-objects.js";
import { rotateAdminKey } from "../../src/init/rotate.js";

const teardown: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (teardown.length > 0) await teardown.pop()!();
});

const ACCOUNT = "fake-account-id";
const BUCKET = "dropthis-main-drops";

async function fake() {
  const started = await startFakeCloudflare({ buckets: [BUCKET] });
  teardown.push(() => started.close());
  return { ...started, client: makeClient({ apiToken: "fake-token", accountId: ACCOUNT, apiBase: started.apiBase }) };
}

/** The installer's bucket, served by the real Worker app. */
async function serveBucket(cf: Awaited<ReturnType<typeof fake>>) {
  const objects = [...(cf.state.objects.get(BUCKET) ?? new Map()).entries()].map(
    ([key, object]) => [key, object.body] as [string, Uint8Array],
  );
  const started = await startFakeInstance({ objects });
  teardown.push(() => started.close());
  return started;
}

type UserPointer = { id: string; previous?: string; pending?: string };

const keys = (cf: Awaited<ReturnType<typeof fake>>) => [...(cf.state.objects.get(BUCKET)?.keys() ?? [])];

describe("rotateAdminKey", () => {
  it("mints a new key, revokes the old one and leaves one admin record", async () => {
    const cf = await fake();
    const first = await bootstrapAdminKey(cf.client, ACCOUNT, BUCKET);
    if (first.status !== "created") throw new Error("bootstrap did not mint a key");

    const rotated = await rotateAdminKey(cf.client, ACCOUNT, BUCKET);

    expect(rotated.key).toMatch(/^[0-9a-f]{64}$/);
    expect(rotated.key).not.toBe(first.key);
    const user = await getObjectJson<{ id: string; previous?: string }>(cf.client, ACCOUNT, BUCKET, "users/admin");
    expect(user?.id).toBe(rotated.id);
    expect(user?.previous).toBeUndefined();
    expect(keys(cf).filter((key) => key.startsWith("keyhash/"))).toHaveLength(1);
    expect(keys(cf).filter((key) => key.startsWith("keys/"))).toHaveLength(1);
  });

  it("the instance refuses the old key and accepts the new one", async () => {
    const cf = await fake();
    const first = await bootstrapAdminKey(cf.client, ACCOUNT, BUCKET);
    if (first.status !== "created") throw new Error("bootstrap did not mint a key");
    const rotated = await rotateAdminKey(cf.client, ACCOUNT, BUCKET);

    const instance = await serveBucket(cf);
    const call = (key: string) =>
      fetch(`${instance.url}/_api/v1/config`, { headers: { authorization: `Bearer ${key}` } });

    expect((await call(first.key)).status).toBe(401);
    expect((await call(rotated.key)).status).toBe(200);
  });

  it("finishes an interrupted rotation before starting a new one", async () => {
    const cf = await fake();
    const first = await bootstrapAdminKey(cf.client, ACCOUNT, BUCKET);
    if (first.status !== "created") throw new Error("bootstrap did not mint a key");
    // A run that died right after the users/admin write: the old records are
    // still there and the old key still works.
    const halfway = await rotateAdminKey(cf.client, ACCOUNT, BUCKET, { stopAfter: "claim" });
    expect(keys(cf).filter((key) => key.startsWith("keyhash/"))).toHaveLength(2);

    const finished = await rotateAdminKey(cf.client, ACCOUNT, BUCKET);

    expect(keys(cf).filter((key) => key.startsWith("keyhash/"))).toHaveLength(1);
    expect(keys(cf).filter((key) => key.startsWith("keys/"))).toHaveLength(1);
    const user = await getObjectJson<{ id: string; previous?: string }>(cf.client, ACCOUNT, BUCKET, "users/admin");
    expect(user?.id).toBe(finished.id);
    expect(user?.previous).toBeUndefined();

    const instance = await serveBucket(cf);
    const call = (key: string) =>
      fetch(`${instance.url}/_api/v1/config`, { headers: { authorization: `Bearer ${key}` } });
    expect((await call(first.key)).status).toBe(401);
    expect((await call(halfway.key)).status).toBe(401);
    expect((await call(finished.key)).status).toBe(200);
  });

  it("a crash between minting and the switch leaves no key a rerun cannot revoke", async () => {
    const cf = await fake();
    const first = await bootstrapAdminKey(cf.client, ACCOUNT, BUCKET);
    if (first.status !== "created") throw new Error("bootstrap did not mint a key");
    // A run that died after the new key became usable but before `users/admin`
    // named it: without a written-down intent nothing knows that key exists.
    const orphan = await rotateAdminKey(cf.client, ACCOUNT, BUCKET, { stopAfter: "mint" });
    expect(keys(cf).filter((key) => key.startsWith("keyhash/"))).toHaveLength(2);

    const finished = await rotateAdminKey(cf.client, ACCOUNT, BUCKET);

    expect(keys(cf).filter((key) => key.startsWith("keyhash/"))).toHaveLength(1);
    expect(keys(cf).filter((key) => key.startsWith("keys/"))).toHaveLength(1);
    const instance = await serveBucket(cf);
    const call = (key: string) =>
      fetch(`${instance.url}/_api/v1/config`, { headers: { authorization: `Bearer ${key}` } });
    expect((await call(orphan.key)).status).toBe(401);
    expect((await call(first.key)).status).toBe(401);
    expect((await call(finished.key)).status).toBe(200);
  });

  it("a crash before the new key exists leaves the old key working and a clean rerun", async () => {
    const cf = await fake();
    const first = await bootstrapAdminKey(cf.client, ACCOUNT, BUCKET);
    if (first.status !== "created") throw new Error("bootstrap did not mint a key");
    // The intent was written and then the run died: nothing changed yet, so
    // the old key must still administer the instance.
    await rotateAdminKey(cf.client, ACCOUNT, BUCKET, { stopAfter: "intent" });
    const halfway = await serveBucket(cf);
    expect(
      (
        await fetch(`${halfway.url}/_api/v1/config`, {
          headers: { authorization: `Bearer ${first.key}` },
        })
      ).status,
    ).toBe(200);

    const finished = await rotateAdminKey(cf.client, ACCOUNT, BUCKET);

    expect(keys(cf).filter((key) => key.startsWith("keyhash/"))).toHaveLength(1);
    expect(keys(cf).filter((key) => key.startsWith("keys/"))).toHaveLength(1);
    const user = await getObjectJson<UserPointer>(cf.client, ACCOUNT, BUCKET, "users/admin");
    expect(user).toEqual({ id: finished.id });

    const instance = await serveBucket(cf);
    const call = (key: string) =>
      fetch(`${instance.url}/_api/v1/config`, { headers: { authorization: `Bearer ${key}` } });
    expect((await call(first.key)).status).toBe(401);
    expect((await call(finished.key)).status).toBe(200);
  });

  it("refuses to rotate an instance that has no admin record", async () => {
    const cf = await fake();

    await expect(rotateAdminKey(cf.client, ACCOUNT, BUCKET)).rejects.toThrow(/users\/admin/);
  });
});
