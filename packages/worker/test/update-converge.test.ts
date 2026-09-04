/**
 * Two rules of the write order that only a retry can show (AGENTS.md,
 * "Writes and idempotency"; issue #24, findings 9 and 10):
 *
 *   - "A generated password is returned once … to identical retries under the
 *     same key within 7 days." A retry that LOSES the compare-and-swap to its
 *     own twin is still that call, so it still owes the password, the sealed
 *     result and the projections.
 *   - "`list/` and `expiring/` are repaired both ways … by the next
 *     `get`/`update`." Both markers, not only the listing row.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { expiringMarkerDate } from "../src/domain/expiry.js";
import type { Drop, DropMeta } from "../src/domain/meta.js";
import { expiringKey, listKeyForDrop, metaKey } from "../src/storage/keys.js";
import { harness, USER_KEY } from "./app-harness.js";
import type { Harness } from "./app-harness.js";

let h: Harness;

beforeEach(async () => {
  h = await harness();
});

const publish = async (body: Record<string, unknown>): Promise<Drop> => {
  const response = await h.json("/_api/v1/drops", "POST", body, { key: USER_KEY });
  expect(response.status).toBe(201);
  return h.body<Drop>(response);
};

const metaOf = (drop: Drop): DropMeta =>
  JSON.parse(h.bucket.read(metaKey(idOf(drop)))!) as DropMeta;

const idOf = (drop: Drop): string => {
  const pointer = h.bucket.read(`slugs/${drop.slug}`)!;
  return pointer.trim();
};

/**
 * Make the next compare-and-swap of `meta.json` lose to a twin that stored
 * exactly the same bytes — the shape a second retry of one idempotent call
 * takes when both are in flight.
 */
function twinWinsTheNextCas(dropId: string): void {
  const key = metaKey(dropId);
  const put = h.bucket.put.bind(h.bucket);
  let done = false;
  h.bucket.put = async (k, value, options?) => {
    if (!done && k === key && options?.onlyIf?.etagMatches !== undefined) {
      done = true;
      h.bucket.seed(k, value as string);
      return null;
    }
    return put(k, value, options);
  };
}

describe("an identical retry that loses the CAS (finding 9)", () => {
  it("still returns the generated password and seals the result", async () => {
    const drop = await publish({ files: [{ path: "a.txt", text: "one" }], title: "A" });
    const id = idOf(drop);

    // The first attempt writes the claim and dies before the flip.
    const aborted = await h.json(
      `/_api/v1/drops/${drop.slug}`,
      "PATCH",
      { title: "B", password: "generate", idempotency_key: "k1" },
      { key: USER_KEY, headers: { "DEV-Fault": "claim" } },
    );
    expect(aborted.status).toBe(500);

    twinWinsTheNextCas(id);
    const retry = await h.json(
      `/_api/v1/drops/${drop.slug}`,
      "PATCH",
      { title: "B", password: "generate", idempotency_key: "k1" },
      { key: USER_KEY },
    );
    expect(retry.status).toBe(200);
    const body = await h.body<Drop>(retry);
    expect(body.title).toBe("B");
    // The password the claim fixed, not a second generated one.
    expect(body.password).toHaveLength(16);

    // And it is replayable: the result was sealed before returning.
    const again = await h.json(
      `/_api/v1/drops/${drop.slug}`,
      "PATCH",
      { title: "B", password: "generate", idempotency_key: "k1" },
      { key: USER_KEY },
    );
    expect((await h.body<Drop>(again)).password).toBe(body.password);
  });

  it("still writes the listing row and the expiry marker", async () => {
    const drop = await publish({ files: [{ path: "a.txt", text: "one" }], title: "A" });
    const id = idOf(drop);

    await h.json(
      `/_api/v1/drops/${drop.slug}`,
      "PATCH",
      { expires: "90d", idempotency_key: "k2" },
      { key: USER_KEY, headers: { "DEV-Fault": "claim" } },
    );

    // Wipe both projections, so only this call can put them back.
    const listKey = listKeyForDrop(id, drop.slug);
    await h.bucket.delete([listKey, expiringKey(expiringMarkerDate(drop.expires_at!), id)]);

    twinWinsTheNextCas(id);
    const retry = await h.json(
      `/_api/v1/drops/${drop.slug}`,
      "PATCH",
      { expires: "90d", idempotency_key: "k2" },
      { key: USER_KEY },
    );
    expect(retry.status).toBe(200);

    const stored = metaOf(drop);
    expect(h.bucket.keys("list/")).toContain(listKey);
    expect(h.bucket.keys("expiring/")).toContain(
      expiringKey(expiringMarkerDate(stored.expires_at!), id),
    );
  });
});

describe("the expiring/ marker is repaired both ways (finding 10)", () => {
  it("get puts back a marker that went missing", async () => {
    const drop = await publish({ files: [{ path: "a.txt", text: "one" }], expires: "30d" });
    const id = idOf(drop);
    const marker = expiringKey(expiringMarkerDate(drop.expires_at!), id);
    await h.bucket.delete(marker);

    const response = await h.call(`/_api/v1/drops/${drop.slug}`, {}, USER_KEY);
    expect(response.status).toBe(200);
    expect(h.bucket.keys("expiring/")).toContain(marker);
  });

  it("an update that moves the expiry deletes the marker it knew about", async () => {
    const drop = await publish({ files: [{ path: "a.txt", text: "one" }], expires: "30d" });
    const id = idOf(drop);
    const before = expiringKey(expiringMarkerDate(drop.expires_at!), id);

    const response = await h.json(
      `/_api/v1/drops/${drop.slug}`,
      "PATCH",
      { expires: "90d" },
      { key: USER_KEY },
    );
    const after = await h.body<Drop>(response);
    expect(h.bucket.keys("expiring/")).toEqual([
      expiringKey(expiringMarkerDate(after.expires_at!), id),
    ]);
    expect(h.bucket.keys("expiring/")).not.toContain(before);
  });

  it("a no-op update repairs the marker too", async () => {
    const drop = await publish({ files: [{ path: "a.txt", text: "one" }], expires: "30d" });
    const id = idOf(drop);
    const marker = expiringKey(expiringMarkerDate(drop.expires_at!), id);
    await h.bucket.delete(marker);

    const response = await h.json(
      `/_api/v1/drops/${drop.slug}`,
      "PATCH",
      { title: null },
      { key: USER_KEY },
    );
    expect(response.status).toBe(200);
    expect(h.bucket.keys("expiring/")).toContain(marker);
  });
});
