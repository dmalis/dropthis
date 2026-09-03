import { afterEach, describe, expect, it } from "vitest";
import { startFakeCloudflare } from "../../../../test/fake-cloudflare/src/server.js";
import { makeClient } from "../../src/init/cloudflare-client.js";
import { workerSecretNames } from "../../src/init/worker-secrets.js";

const teardown: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (teardown.length > 0) await teardown.pop()!();
});

async function fake() {
  const started = await startFakeCloudflare();
  teardown.push(() => started.close());
  return started;
}

const ACCOUNT = "fake-account-id";
const client = (cf: Awaited<ReturnType<typeof fake>>) =>
  makeClient({ apiToken: "fake-token", accountId: ACCOUNT, apiBase: cf.apiBase });

describe("workerSecretNames", () => {
  it("is undefined for a Worker that was never deployed", async () => {
    const cf = await fake();

    expect(await workerSecretNames(client(cf), ACCOUNT, "dropthis-main")).toBeUndefined();
  });

  it("lists the names a deployed Worker holds, never a value", async () => {
    const cf = await fake();
    cf.state.scripts.set("dropthis-main", {
      name: "dropthis-main",
      secrets: ["HMAC_SECRET"],
      bindings: [],
    });

    const names = await workerSecretNames(client(cf), ACCOUNT, "dropthis-main");

    expect(names).toEqual(["HMAC_SECRET"]);
  });
});
