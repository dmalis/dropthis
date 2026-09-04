import { describe, expect, it } from "vitest";
import { BASE_URL } from "./base-url.js";
import { addUser, adminKey, api, apiJson, errorOf } from "./client.js";

/**
 * Keys, scopes and people, replayed against the deployed dev Worker with real
 * R2 behind it.
 *
 * Everything here is a claim about the CONTRACT: which refusal an agent sees,
 * that a new key works on the next call, that a removed key stops working on
 * the next call, and that a label means one person however it was spelled.
 * The conditional write that makes the last one true only behaves this way on
 * remote R2, which is why this runs over HTTP and not in an emulator.
 */
const UNAUTHENTICATED = { status: 401, code: "UNAUTHENTICATED" };
const FORBIDDEN = { status: 403, code: "FORBIDDEN_SCOPE" };

/** A label unique to this test run, so tests never collide with each other. */
const label = (name: string) => `ct-${name}-${Math.random().toString(36).slice(2, 8)}`;

const publish = (body: unknown, key?: string) =>
  apiJson("/_api/v1/drops", "POST", body, key);

describe("bearer auth", () => {
  it("lets the admin key through", async () => {
    const response = await api("/_api/v1/users");
    expect(response.status, await response.clone().text()).toBe(200);
  });

  it("refuses a request with no key", async () => {
    expect(await errorOf(await api("/_api/v1/users", {}, ""))).toMatchObject(UNAUTHENTICATED);
  });

  it("refuses a key that resolves to nothing", async () => {
    expect(await errorOf(await api("/_api/v1/users", {}, "f".repeat(64)))).toMatchObject(
      UNAUTHENTICATED,
    );
  });

  it("refuses another authorization scheme", async () => {
    const response = await fetch(`${BASE_URL}/_api/v1/users`, {
      cache: "no-store",
      headers: { authorization: `Basic ${adminKey()}` },
    });
    expect(await errorOf(response)).toMatchObject(UNAUTHENTICATED);
  });

  it("sends the frozen error object, remediation included", async () => {
    const { body } = await errorOf(await api("/_api/v1/users", {}, ""));
    expect(body).toEqual({
      error: {
        code: "UNAUTHENTICATED",
        message: expect.any(String),
        remediation: "Send the instance key as `Authorization: Bearer <key>`.",
        retryable: false,
      },
    });
  });

  it("leaves health open", async () => {
    const response = await fetch(`${BASE_URL}/_api/v1/health`, { cache: "no-store" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("refuses an unauthenticated publish before it reads the body", async () => {
    expect(await errorOf(await publish({ files: [{ path: "a.txt", text: "x" }] }, ""))).toMatchObject(
      UNAUTHENTICATED,
    );
  });
});

describe("scopes", () => {
  it("gives a user key the drop operations and refuses the admin ones", async () => {
    const anna = await addUser(label("anna"));

    const published = await publish({ files: [{ path: "a.txt", text: "hi" }] }, anna.key);
    expect(published.status, await published.clone().text()).toBe(201);

    for (const path of ["/_api/v1/users", "/_api/v1/config", "/_api/v1/doctor", "/_api/v1/usage"]) {
      expect(await errorOf(await api(path, {}, anna.key)), path).toMatchObject(FORBIDDEN);
    }
  });

  it("attributes the drop to the key that published it", async () => {
    const anna = await addUser(label("anna"));
    const response = await publish({ files: [{ path: "a.txt", text: "hi" }] }, anna.key);
    const drop = (await response.json()) as { created_by: unknown; slug: string };

    expect(drop.created_by).toEqual({ id: anna.id, label: expect.any(String) });
  });

  it("lets a colleague read and reach a drop another key published", async () => {
    const anna = await addUser(label("anna"));
    const bob = await addUser(label("bob"));

    const published = await publish({ files: [{ path: "a.txt", text: "shared" }] }, anna.key);
    const drop = (await published.json()) as { slug: string };

    const read = await api(`/_api/v1/drops/${drop.slug}`, {}, bob.key);
    expect(read.status).toBe(200);
  });

  it("lets the admin key reach the drop operations too", async () => {
    const response = await publish({ files: [{ path: "a.txt", text: "admin" }] });
    expect(response.status).toBe(201);
  });
});

describe("user add", () => {
  it("returns the key once with a connect object and a message", async () => {
    const name = label("carol");
    const response = await apiJson("/_api/v1/users", "POST", { label: name });
    expect(response.status, await response.clone().text()).toBe(201);

    const result = (await response.json()) as {
      user: { id: string; label: string; scope: string; created: string };
      key: string;
      connect: { mcp_url: string; clients: Record<string, unknown> };
      message: string;
    };

    expect(result.key).toMatch(/^[0-9a-f]{64}$/);
    expect(result.user.label).toBe(name);
    expect(result.user.scope).toBe("user");
    expect(result.connect.mcp_url).toBe(`${BASE_URL}/_api/mcp`);
    expect(Object.keys(result.connect.clients)).toEqual([
      "claude_code",
      "cursor",
      "codex",
      "claude_ai",
    ]);
    expect(JSON.stringify(result.connect)).not.toContain(result.key);
    expect(result.message).toContain(name);
  });

  it("refuses a label that normalizes onto one already taken", async () => {
    const name = label("dave");
    await addUser(name);

    expect(await errorOf(await apiJson("/_api/v1/users", "POST", { label: `  ${name.toUpperCase()}  ` }))).toMatchObject({
      status: 409,
      code: "LABEL_TAKEN",
    });
  });

  it("refuses a label the normalization cannot make legal", async () => {
    expect(await errorOf(await apiJson("/_api/v1/users", "POST", { label: "-nope" }))).toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
    });
  });

  it("returns the same key to an identical retry", async () => {
    const name = label("erin");
    const key = `ct-idem-${name}`;

    const first = await apiJson("/_api/v1/users", "POST", { label: name, idempotency_key: key });
    const second = await apiJson("/_api/v1/users", "POST", { label: name, idempotency_key: key });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const one = (await first.json()) as { key: string; user: { id: string } };
    const two = (await second.json()) as { key: string; user: { id: string } };
    expect(two.key).toBe(one.key);
    expect(two.user.id).toBe(one.user.id);
  });

  it("refuses a different label under the same idempotency key", async () => {
    const key = `ct-idem-${label("clash")}`;
    await apiJson("/_api/v1/users", "POST", { label: label("frank"), idempotency_key: key });

    expect(
      await errorOf(
        await apiJson("/_api/v1/users", "POST", { label: label("grace"), idempotency_key: key }),
      ),
    ).toMatchObject({ status: 409, code: "IDEMPOTENCY_MISMATCH" });
  });

  it("converges after a crash between its write steps", async () => {
    const name = label("heidi");
    const idem = `ct-fault-${name}`;

    for (const point of ["record", "keyhash", "label"]) {
      const crashed = await api("/_api/v1/users", {
        method: "POST",
        headers: { "content-type": "application/json", "DEV-Fault": point },
        body: JSON.stringify({ label: name, idempotency_key: idem }),
      });
      expect(crashed.status, `fault at ${point}`).toBe(500);
    }

    const finished = await apiJson("/_api/v1/users", "POST", { label: name, idempotency_key: idem });
    expect(finished.status, await finished.clone().text()).toBe(201);

    const result = (await finished.json()) as { key: string; user: { id: string } };
    const published = await apiJson(
      "/_api/v1/drops",
      "POST",
      { files: [{ path: "a.txt", text: "converged" }] },
      result.key,
    );
    expect(published.status).toBe(201);
  });
});

describe("user list", () => {
  it("shows the team and never a key or a hash", async () => {
    const name = label("ivan");
    const ivan = await addUser(name);

    const body = (await (await api("/_api/v1/users")).json()) as {
      users: Array<{ id: string; label: string; scope: string; created: string }>;
    };

    expect(body.users.some((user) => user.label === name)).toBe(true);
    expect(body.users.some((user) => user.label === "admin" && user.scope === "admin")).toBe(true);
    expect(JSON.stringify(body)).not.toContain(ivan.key);
    expect(JSON.stringify(body)).not.toMatch(/"hash"/);
  });
});

describe("user remove", () => {
  it("ends access on the next call and frees the label", async () => {
    const name = label("judy");
    const first = await addUser(name);

    const removed = await api(`/_api/v1/users/${name}`, { method: "DELETE" });
    expect(removed.status, await removed.clone().text()).toBe(204);

    expect(
      await errorOf(await publish({ files: [{ path: "a.txt", text: "x" }] }, first.key)),
    ).toMatchObject(UNAUTHENTICATED);

    const second = await addUser(name);
    expect(second.id).not.toBe(first.id);
    expect(second.key).not.toBe(first.key);
  });

  it("is safe to repeat: the second call is 204 too", async () => {
    // Issue #24, finding 16: the tool text promises "succeeds when the label is
    // already gone", and DELETE is idempotent everywhere else here.
    const name = label("ken");
    await addUser(name);

    expect((await api(`/_api/v1/users/${name}`, { method: "DELETE" })).status).toBe(204);
    expect((await api(`/_api/v1/users/${name}`, { method: "DELETE" })).status).toBe(204);
    expect((await api(`/_api/v1/users/${label("never-added")}`, { method: "DELETE" })).status).toBe(
      204,
    );
  });

  it("refuses to remove the admin key", async () => {
    expect(await errorOf(await api("/_api/v1/users/admin", { method: "DELETE" }))).toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
    });

    // Proof it is still there: the very next admin call still works.
    expect((await api("/_api/v1/users")).status).toBe(200);
  });
});
