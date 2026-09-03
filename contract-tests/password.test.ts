import { describe, expect, it } from "vitest";
import { BASE_URL } from "./base-url.js";
import { api, apiJson, errorOf } from "./client.js";
import type { Json } from "./client.js";

/**
 * Passwords and the browser unlock, replayed against the deployed dev Worker.
 *
 * The visitor half of this file speaks plain HTTP with no key at all — that is
 * the point: the unlock form is the only surface a human ever touches, and it
 * has to work for a browser that has never heard of a bearer token.
 */

const GENERATED = /^[A-Za-z0-9]{16}$/;

async function publishOk(body: unknown): Promise<Json> {
  const response = await apiJson("/_api/v1/drops", "POST", body);
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as Json;
}

/** A visitor: no key, no redirect following, so every hop is asserted. */
const visit = (path: string, init: RequestInit = {}) =>
  fetch(`${BASE_URL}${path}`, { cache: "no-store", redirect: "manual", ...init });

const unlock = (path: string, password: string, init: RequestInit = {}) =>
  visit(path, {
    ...init,
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(init.headers ?? {}) },
    body: new URLSearchParams({ password }).toString(),
  });

const secret = "s3cr3t-and-long-enough";
const page = (text: string) => [{ path: "index.html", text }];

describe("setting a password", () => {
  it("generates one, returns it once, and never returns it again", async () => {
    const drop = await publishOk({
      files: page("<h1>generated</h1>"),
      title: "generated password",
      password: "generate",
    });

    expect(drop.password).toMatch(GENERATED);
    expect(drop.has_password).toBe(true);

    const read = (await (await api(`/_api/v1/drops/${drop.slug}`)).json()) as Json;
    expect(read.has_password).toBe(true);
    expect(read).not.toHaveProperty("password");
  });

  it("takes a chosen password and echoes it in the response that set it", async () => {
    const drop = await publishOk({ files: page("<h1>chosen</h1>"), password: secret });
    expect(drop.password).toBe(secret);
    expect(drop.has_password).toBe(true);
  });

  it("refuses a chosen password under eight characters", async () => {
    const response = await apiJson("/_api/v1/drops", "POST", {
      files: page("<h1>short</h1>"),
      password: "short7!",
    });
    expect(await errorOf(response)).toMatchObject({ status: 400, code: "INVALID_INPUT" });
  });

  it("leaves a drop open when the call says nothing", async () => {
    const drop = await publishOk({ files: page("<h1>open</h1>") });
    expect(drop.has_password).toBe(false);
    expect(drop).not.toHaveProperty("password");
  });

  it("returns the same generated password to an idempotent retry", async () => {
    const body = {
      files: page("<h1>retried</h1>"),
      password: "generate",
      idempotency_key: `password-replay-${Date.now()}`,
    };
    const first = await publishOk(body);
    const again = await apiJson("/_api/v1/drops", "POST", body);
    expect(again.status).toBe(200);
    const replay = (await again.json()) as Json;

    expect(replay.slug).toBe(first.slug);
    expect(replay.password).toBe(first.password);
  });
});

describe("a visitor opening a protected drop", () => {
  it("is shown one unlock form and none of the drop's content", async () => {
    const drop = await publishOk({
      files: page("<h1>the secret content</h1>"),
      title: "locked report",
      password: secret,
    });

    const response = await visit(`/${drop.slug}/`);
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toMatch(/^text\/html/);
    expect(response.headers.get("set-cookie")).toBeNull();

    const html = await response.text();
    expect(html).toContain('name="password"');
    expect(html).toContain("locked report");
    expect(html).not.toContain("the secret content");
  });

  it("is shown the form again, with an error, after a wrong password", async () => {
    const drop = await publishOk({ files: page("<h1>the secret content</h1>"), password: secret });

    const response = await unlock(`/${drop.slug}/`, "not-the-password");
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();

    const html = await response.text();
    expect(html).toContain('name="password"');
    expect(html.toLowerCase()).toContain("password");
    expect(html).not.toContain("the secret content");
  });

  it("gets a cookie with the frozen attributes and then the content", async () => {
    const drop = await publishOk({ files: page("<h1>the secret content</h1>"), password: secret });

    const opened = await unlock(`/${drop.slug}/`, secret);
    expect(opened.status).toBe(303);
    expect(opened.headers.get("location")).toBe(`/${drop.slug}/`);

    const cookie = opened.headers.get("set-cookie");
    expect(cookie).toBeTruthy();
    expect(cookie).toContain("dropthis_unlock=");
    expect(cookie).toContain(`Path=/${drop.slug}/`);
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toContain("Domain");

    const value = cookie!.slice(0, cookie!.indexOf(";"));
    const served = await visit(`/${drop.slug}/`, { headers: { cookie: value } });
    expect(served.status).toBe(200);
    expect(await served.text()).toContain("the secret content");
  });

  it("cannot open another drop with the cookie it was given", async () => {
    const mine = await publishOk({ files: page("<h1>mine</h1>"), password: secret });
    const theirs = await publishOk({ files: page("<h1>theirs</h1>"), password: secret });

    const opened = await unlock(`/${mine.slug}/`, secret);
    const value = opened.headers.get("set-cookie")!.split(";")[0]!;

    const stolen = await visit(`/${theirs.slug}/`, { headers: { cookie: value } });
    expect(stolen.status).toBe(401);
    expect(await stolen.text()).not.toContain("theirs");
  });

  it("is refused by a tampered cookie", async () => {
    const drop = await publishOk({ files: page("<h1>the secret content</h1>"), password: secret });
    const opened = await unlock(`/${drop.slug}/`, secret);
    const value = opened.headers.get("set-cookie")!.split(";")[0]!;
    const tampered = `${value.slice(0, -1)}${value.endsWith("0") ? "1" : "0"}`;

    const served = await visit(`/${drop.slug}/`, { headers: { cookie: tampered } });
    expect(served.status).toBe(401);
  });

  it("still gets the noindex header on the unlock form", async () => {
    const drop = await publishOk({ files: page("<h1>x</h1>"), password: secret });
    const response = await visit(`/${drop.slug}/`);
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("must unlock every path of the drop, not only its root", async () => {
    const drop = await publishOk({
      files: [
        { path: "index.html", text: "<h1>front</h1>" },
        { path: "deep/notes.txt", text: "the deep secret" },
      ],
      password: secret,
    });

    const deep = await visit(`/${drop.slug}/deep/notes.txt`);
    expect(deep.status).toBe(401);
    expect(await deep.text()).not.toContain("the deep secret");

    const opened = await unlock(`/${drop.slug}/deep/notes.txt`, secret);
    expect(opened.status).toBe(303);
    expect(opened.headers.get("location")).toBe(`/${drop.slug}/deep/notes.txt`);
    const value = opened.headers.get("set-cookie")!.split(";")[0]!;

    const served = await visit(`/${drop.slug}/deep/notes.txt`, { headers: { cookie: value } });
    expect(await served.text()).toBe("the deep secret");
  });
});

describe("the agent's own read", () => {
  it("never needs the password: get with files returns content behind a bearer key", async () => {
    const drop = await publishOk({
      files: [{ path: "report.md", text: "# behind a password" }],
      password: secret,
    });

    const read = (await (await api(`/_api/v1/drops/${drop.slug}?files=true`)).json()) as Json;
    const files = read.files as Array<{ path: string; content?: string }>;
    expect(files[0]!.content).toBe("# behind a password");
    expect(read).not.toHaveProperty("password");
  });
});

async function updateOk(slug: string, body: unknown): Promise<Json> {
  const response = await apiJson(`/_api/v1/drops/${slug}`, "PATCH", body);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Json;
}

/** Unlock the drop root and hand back the cookie the browser would keep. */
async function cookieFor(slug: string, password: string): Promise<string> {
  const opened = await unlock(`/${slug}/`, password);
  expect(opened.status).toBe(303);
  return opened.headers.get("set-cookie")!.split(";")[0]!;
}

describe("changing the password with update", () => {
  const content = "<h1>the secret content</h1>";

  it("re-sending the password the drop already has changes nothing: the cookie still opens it", async () => {
    const drop = await publishOk({ files: page(content), password: secret });
    const cookie = await cookieFor(drop.slug as string, secret);

    const same = await updateOk(drop.slug as string, { password: secret });
    expect(same.has_password).toBe(true);
    // Nothing was set, so nothing is echoed — the no-op rule, cookie included.
    expect(same).not.toHaveProperty("password");

    const served = await visit(`/${drop.slug}/`, { headers: { cookie } });
    expect(served.status).toBe(200);
    expect(await served.text()).toBe(content);
  });

  it("a different chosen password revokes every cookie and is echoed once", async () => {
    const drop = await publishOk({ files: page(content), password: secret });
    const cookie = await cookieFor(drop.slug as string, secret);

    const changed = await updateOk(drop.slug as string, { password: "another-secret-1" });
    expect(changed.password).toBe("another-secret-1");
    expect(changed.has_password).toBe(true);

    const stale = await visit(`/${drop.slug}/`, { headers: { cookie } });
    expect(stale.status).toBe(401);
    expect(await stale.text()).not.toContain("the secret content");

    expect((await unlock(`/${drop.slug}/`, secret)).status).toBe(401);
    const fresh = await cookieFor(drop.slug as string, "another-secret-1");
    const served = await visit(`/${drop.slug}/`, { headers: { cookie: fresh } });
    expect(await served.text()).toBe(content);

    const read = (await (await api(`/_api/v1/drops/${drop.slug}`)).json()) as Json;
    expect(read).not.toHaveProperty("password");
  });

  it("generate on update returns a fresh password once, and the old one no longer unlocks", async () => {
    const drop = await publishOk({ files: page(content), password: secret });
    const cookie = await cookieFor(drop.slug as string, secret);

    const rotated = await updateOk(drop.slug as string, { password: "generate" });
    const generated = rotated.password as string;
    expect(generated).toMatch(GENERATED);
    expect(generated).not.toBe(secret);

    expect((await visit(`/${drop.slug}/`, { headers: { cookie } })).status).toBe(401);
    expect((await unlock(`/${drop.slug}/`, secret)).status).toBe(401);
    expect((await unlock(`/${drop.slug}/`, generated)).status).toBe(303);
  });

  it("null removes it: the drop opens with no cookie, and the drop says so", async () => {
    const drop = await publishOk({ files: page(content), password: secret });
    expect((await visit(`/${drop.slug}/`)).status).toBe(401);

    const opened = await updateOk(drop.slug as string, { password: null });
    expect(opened.has_password).toBe(false);
    expect(opened).not.toHaveProperty("password");

    const served = await visit(`/${drop.slug}/`);
    expect(served.status).toBe(200);
    expect(await served.text()).toBe(content);
    // Nothing to unlock any more: the POST is a 404, not a 405.
    expect((await unlock(`/${drop.slug}/`, secret)).status).toBe(404);
  });

  it("adds a password to an open drop, and an update that says nothing keeps it", async () => {
    const drop = await publishOk({ files: page(content) });
    expect(drop.has_password).toBe(false);

    const locked = await updateOk(drop.slug as string, { password: secret });
    expect(locked.password).toBe(secret);
    expect(locked.has_password).toBe(true);
    expect((await visit(`/${drop.slug}/`)).status).toBe(401);

    const retitled = await updateOk(drop.slug as string, { title: "still locked" });
    expect(retitled.has_password).toBe(true);
    expect(retitled).not.toHaveProperty("password");
    expect((await visit(`/${drop.slug}/`)).status).toBe(401);
  });

  it("replays the same generated password to an idempotent retry of the update", async () => {
    const drop = await publishOk({ files: page(content) });
    const key = `rotate-${crypto.randomUUID()}`;

    const first = await updateOk(drop.slug as string, { password: "generate", idempotency_key: key });
    const again = await updateOk(drop.slug as string, { password: "generate", idempotency_key: key });
    expect(first.password).toMatch(GENERATED);
    expect(again.password).toBe(first.password);
    expect(again.updated).toBe(first.updated);

    const read = (await (await api(`/_api/v1/drops/${drop.slug}`)).json()) as Json;
    expect(read).not.toHaveProperty("password");
    expect(read.has_password).toBe(true);
  });
});

describe("has_password on the listing", () => {
  const rowOf = async (slug: string): Promise<Json> => {
    const page = (await (await api("/_api/v1/drops?limit=1000")).json()) as { drops: Json[] };
    const row = page.drops.find((d) => d.slug === slug);
    expect(row).toBeDefined();
    return row!;
  };

  it("is read off the pointer publish wrote, and follows an update", async () => {
    const locked = await publishOk({ files: page("<p>a</p>"), password: secret });
    const open = await publishOk({ files: page("<p>b</p>") });

    expect((await rowOf(locked.slug as string)).has_password).toBe(true);
    expect((await rowOf(open.slug as string)).has_password).toBe(false);
    expect(await rowOf(locked.slug as string)).not.toHaveProperty("password");

    await updateOk(locked.slug as string, { password: null });
    await updateOk(open.slug as string, { password: "generate" });
    expect((await rowOf(locked.slug as string)).has_password).toBe(false);
    expect((await rowOf(open.slug as string)).has_password).toBe(true);
  });
});
