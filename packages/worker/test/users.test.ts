import { beforeEach, describe, expect, it } from "vitest";
import { hashKey } from "../src/auth/key.js";
import type { Env } from "../src/bindings.js";
import { DEV_HOOKS } from "../src/dev/enabled-hooks.js";
import { createApp } from "../src/index.js";
import { INITIAL_POLICY } from "../src/policy/defaults.js";
import { CONFIG_KEY, keyHashKey, keyRecordKey, userKey } from "../src/storage/keys.js";
import { memoryBucket } from "./memory-bucket.js";
import type { MemoryBucket } from "./memory-bucket.js";

/**
 * `user add|list|remove` (AGENTS.md, "Team model").
 *
 * A label is a person: `users/<normalized-label>` is CLAIMED, not checked, so
 * two agents adding "Anna" at once end with one key, not two. Removal deletes
 * the `keyhash/` pointer first, because that is the read every request makes —
 * access ends on the first step, and every later step tolerates a 404 so a
 * rerun finishes an interrupted removal.
 */
const ADMIN_KEY = "a".repeat(64);

let bucket: MemoryBucket;
let env: Env;

beforeEach(async () => {
  bucket = memoryBucket();
  bucket.seed(
    CONFIG_KEY,
    JSON.stringify({
      ...INITIAL_POLICY,
      canonical_url: "https://drops.test",
      alias_origins: [],
      instance_name: "acme",
    }),
  );
  const hash = await hashKey(ADMIN_KEY);
  bucket.seed(keyHashKey(hash), JSON.stringify({ id: "admin" }));
  bucket.seed(
    keyRecordKey("admin"),
    JSON.stringify({
      id: "admin",
      label: "admin",
      scope: "admin",
      hash,
      created: "2026-09-01T00:00:00Z",
    }),
  );
  bucket.seed(userKey("admin"), JSON.stringify({ id: "admin" }));
  env = { BUCKET: bucket, OAUTH_KV: {} as never, HMAC_SECRET: "s".repeat(32), DEV_ROUTES: "1" };
});

const app = () => createApp(DEV_HOOKS);

async function call(path: string, init: RequestInit = {}, key = ADMIN_KEY): Promise<Response> {
  return app().fetch(
    new Request(`https://drops.test${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    }),
    env,
  );
}

const addUser = (body: unknown, headers: Record<string, string> = {}) =>
  call("/_api/v1/users", { method: "POST", body: JSON.stringify(body), headers });

type AddResult = {
  user: { id: string; label: string; scope: string; created: string };
  key: string;
  connect: { mcp_url: string };
  message: string;
};

async function addOk(body: unknown, headers: Record<string, string> = {}): Promise<AddResult> {
  const response = await addUser(body, headers);
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as AddResult;
}

async function errorOf(response: Response): Promise<{ status: number; code: string }> {
  const body = (await response.json()) as { error: { code: string } };
  return { status: response.status, code: body.error.code };
}

describe("user add", () => {
  it("returns the key once, with the user, the connect object and a message", async () => {
    const result = await addOk({ label: "Anna" });

    expect(result.key).toMatch(/^[0-9a-f]{64}$/);
    expect(result.user.label).toBe("anna");
    expect(result.user.scope).toBe("user");
    expect(result.user.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(result.connect.mcp_url).toBe("https://drops.test/_api/mcp");
    expect(result.message).toContain("anna");
  });

  it("writes the three records in the order that makes the claim meaningful", async () => {
    bucket.log.length = 0;
    const result = await addOk({ label: "anna" });

    const writes = bucket.log.filter((entry) => entry.startsWith("put "));
    expect(writes).toEqual([
      `put ${keyRecordKey(result.user.id)}`,
      `put ${keyHashKey(await hashKey(result.key))}`,
      `put ${userKey("anna")}`,
    ]);
  });

  it("makes the key work immediately", async () => {
    const result = await addOk({ label: "anna" });

    const response = await call(
      "/_api/v1/drops",
      { method: "POST", body: JSON.stringify({ files: [{ path: "a.txt", text: "hi" }] }) },
      result.key,
    );
    expect(response.status, await response.clone().text()).toBe(201);
    const drop = (await response.json()) as { created_by: unknown };
    expect(drop.created_by).toEqual({ id: result.user.id, label: "anna" });
  });

  it("never returns the key again from user list", async () => {
    const result = await addOk({ label: "anna" });
    const listed = (await (await call("/_api/v1/users")).json()) as { users: unknown[] };

    expect(JSON.stringify(listed)).not.toContain(result.key);
    expect(JSON.stringify(listed)).not.toContain(await hashKey(result.key));
    expect(listed.users).toContainEqual({
      id: result.user.id,
      label: "anna",
      scope: "user",
      created: result.user.created,
    });
  });

  it("refuses a second person whose label normalizes onto the first", async () => {
    await addOk({ label: "Anna" });
    expect(await errorOf(await addUser({ label: "  anna  " }))).toEqual({
      status: 409,
      code: "LABEL_TAKEN",
    });
  });

  it("leaves no orphan record behind when the label was taken", async () => {
    await addOk({ label: "anna" });
    const before = bucket.keys("keys/").length;

    await addUser({ label: "ANNA" });

    expect(bucket.keys("keys/").length).toBe(before);
    expect(bucket.keys("keyhash/").length).toBe(before);
  });

  it("refuses the admin label, which the instance already holds", async () => {
    expect(await errorOf(await addUser({ label: "admin" }))).toEqual({
      status: 409,
      code: "LABEL_TAKEN",
    });
  });

  it("refuses a label the normalization cannot make legal", async () => {
    expect(await errorOf(await addUser({ label: "-nope" }))).toEqual({
      status: 400,
      code: "INVALID_INPUT",
    });
  });

  it("refuses an unknown field rather than ignoring it", async () => {
    expect(await errorOf(await addUser({ label: "anna", scope: "admin" }))).toEqual({
      status: 400,
      code: "INVALID_INPUT",
    });
  });
});

describe("user add, idempotency", () => {
  it("returns the same key to an identical retry", async () => {
    const first = await addOk({ label: "anna", idempotency_key: "onboard-anna" });
    const second = await addOk({ label: "anna", idempotency_key: "onboard-anna" });

    expect(second.key).toBe(first.key);
    expect(second.user.id).toBe(first.user.id);
    expect(bucket.keys("keys/")).toHaveLength(2); // admin plus anna, once
  });

  it("refuses a different payload under the same key", async () => {
    await addOk({ label: "anna", idempotency_key: "onboard" });
    expect(await errorOf(await addUser({ label: "bob", idempotency_key: "onboard" }))).toEqual({
      status: 409,
      code: "IDEMPOTENCY_MISMATCH",
    });
  });

  it("stores nothing readable: the sealed result holds no key in clear", async () => {
    const result = await addOk({ label: "anna", idempotency_key: "onboard" });
    const stored = bucket.keys("requests/").map((key) => bucket.read(key)).join("\n");

    expect(stored).not.toContain(result.key);
  });
});

describe("user add, crash safety", () => {
  const points = ["record", "keyhash", "label"];

  it.each(points)("a crash at %s leaves a rerun able to finish", async (point) => {
    const crashed = await addUser({ label: "anna", idempotency_key: "onboard" }, {
      "DEV-Fault": point,
    });
    expect(crashed.status).toBe(500);

    const result = await addOk({ label: "anna", idempotency_key: "onboard" });

    // Whatever the crash left, the rerun ends with ONE live key for the label
    // and that key working.
    expect(bucket.keys(`users/`)).toEqual(["users/admin", "users/anna"]);
    const response = await call("/_api/v1/users", {}, result.key);
    expect((await errorOf(response)).code).toBe("FORBIDDEN_SCOPE");
  });

  it("a crash before the label claim does not strand the label", async () => {
    await addUser({ label: "anna" }, { "DEV-Fault": "keyhash" });
    const result = await addOk({ label: "anna" });

    expect(result.user.label).toBe("anna");
    expect(bucket.read(userKey("anna"))).toContain(result.user.id);
  });
});

describe("user remove", () => {
  it("ends access on its first step and deletes in the documented order", async () => {
    const result = await addOk({ label: "anna" });
    bucket.log.length = 0;

    const response = await call("/_api/v1/users/anna", { method: "DELETE" });
    expect(response.status).toBe(204);

    const deletes = bucket.log.filter((entry) => entry.startsWith("delete "));
    expect(deletes).toEqual([
      `delete ${keyHashKey(await hashKey(result.key))}`,
      `delete ${keyRecordKey(result.user.id)}`,
      `delete ${userKey("anna")}`,
    ]);
  });

  it("leaves the removed key unable to do anything", async () => {
    const result = await addOk({ label: "anna" });
    await call("/_api/v1/users/anna", { method: "DELETE" });

    const response = await call("/_api/v1/drops/abcdefghij", {}, result.key);
    expect(await errorOf(response)).toEqual({ status: 401, code: "UNAUTHENTICATED" });
  });

  it("frees the label for a new person with a new id", async () => {
    const first = await addOk({ label: "anna" });
    await call("/_api/v1/users/anna", { method: "DELETE" });
    const second = await addOk({ label: "anna" });

    expect(second.user.id).not.toBe(first.user.id);
    expect(second.key).not.toBe(first.key);
  });

  it("normalizes the label in the path, so removal matches how it was added", async () => {
    await addOk({ label: "Anna Maria" });
    expect((await call("/_api/v1/users/Anna%20Maria", { method: "DELETE" })).status).toBe(204);
  });

  it("refuses to remove the admin label", async () => {
    expect(await errorOf(await call("/_api/v1/users/admin", { method: "DELETE" }))).toEqual({
      status: 400,
      code: "INVALID_INPUT",
    });
  });

  it("answers NOT_FOUND for a label nobody holds", async () => {
    expect(await errorOf(await call("/_api/v1/users/nobody", { method: "DELETE" }))).toEqual({
      status: 404,
      code: "NOT_FOUND",
    });
  });

  it("finishes an interrupted removal on the rerun", async () => {
    const result = await addOk({ label: "anna" });
    // A removal that died after the first delete: access is already gone, and
    // the record and the label claim are still there.
    await bucket.delete(keyHashKey(await hashKey(result.key)));

    expect((await call("/_api/v1/users/anna", { method: "DELETE" })).status).toBe(204);
    expect(bucket.keys("keys/")).toEqual(["keys/admin.json"]);
    expect(bucket.keys("users/")).toEqual(["users/admin"]);
  });
});
