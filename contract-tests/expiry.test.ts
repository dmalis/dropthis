import { describe, expect, it } from "vitest";
import { BASE_URL } from "./base-url.js";
import { api, apiJson, errorOf } from "./client.js";
import type { Json } from "./client.js";

/**
 * The four expiry states, driven by the dev build's clock override.
 *
 * Waiting seven days is not a test, so the dev deployment answers a
 * `DEV-Clock` header as "now" — a header rather than a variable, because one
 * run has to publish, expire, revive and then walk the cron a day at a time,
 * and a Worker variable cannot change without a redeploy. The production
 * bundle contains neither the header name nor the variable
 * (`test/build-guard.test.ts`).
 */

const DAY = 24 * 60 * 60 * 1000;
const at = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const clock = (ms: number) => ({ "DEV-Clock": at(ms) });

/** A fixed, far-future start, so this file never collides with the real clock. */
const T0 = Date.parse("2031-03-01T00:00:00Z");

async function publishAt(nowMs: number, body: unknown): Promise<Json> {
  const response = await api("/_api/v1/drops", {
    method: "POST",
    headers: { "content-type": "application/json", ...clock(nowMs) },
    body: JSON.stringify(body),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as Json;
}

const getAt = (nowMs: number, slug: string) =>
  api(`/_api/v1/drops/${slug}`, { headers: clock(nowMs) });

const visitAt = (nowMs: number, path: string) =>
  fetch(`${BASE_URL}${path}`, { cache: "no-store", redirect: "manual", headers: clock(nowMs) });

const devKeys = async (prefix: string): Promise<string[]> => {
  const response = await apiJson("/_dev/r2/list", "POST", { prefix });
  return ((await response.json()) as { keys: string[] }).keys;
};

const page = (text: string) => [{ path: "index.html", text }];

describe("expires resolves against the clock the call is made at", () => {
  it("stores expires_at as the instant seven days after that call", async () => {
    const drop = await publishAt(T0, { files: page("<h1>a</h1>"), expires: "7d" });
    expect(drop.expires_at).toBe(at(T0 + 7 * DAY));
    expect(drop.state).toBe("live");
  });

  it("takes a bare date as midnight UTC", async () => {
    const drop = await publishAt(T0, { files: page("<h1>a</h1>"), expires: "2031-12-31" });
    expect(drop.expires_at).toBe("2031-12-31T00:00:00Z");
  });

  it("refuses an expiry that has already passed", async () => {
    const response = await api("/_api/v1/drops", {
      method: "POST",
      headers: { "content-type": "application/json", ...clock(T0) },
      body: JSON.stringify({ files: page("<h1>a</h1>"), expires: "2030-01-01" }),
    });
    expect(await errorOf(response)).toMatchObject({ status: 400, code: "POLICY_VIOLATION" });
  });

  it("writes the expiring marker on the day the grace window ends", async () => {
    const drop = await publishAt(T0, { files: page("<h1>a</h1>"), expires: "7d" });
    const markerDay = at(T0 + 14 * DAY).slice(0, 10);
    const keys = await devKeys(`expiring/${markerDay}/`);
    expect(keys.length).toBeGreaterThan(0);
  });
});

describe("live", () => {
  it("serves, and get says so", async () => {
    const drop = await publishAt(T0, { files: page("<h1>still here</h1>"), expires: "7d" });

    const served = await visitAt(T0 + DAY, `/${drop.slug}/`);
    expect(served.status).toBe(200);
    expect(await served.text()).toContain("still here");

    const read = (await (await getAt(T0 + DAY, drop.slug as string)).json()) as Json;
    expect(read.state).toBe("live");
  });
});

describe("expired_grace", () => {
  it("is 410 to a visitor the very second after expires_at", async () => {
    const drop = await publishAt(T0, { files: page("<h1>the content</h1>"), expires: "7d" });

    const gone = await visitAt(T0 + 7 * DAY + 1000, `/${drop.slug}/`);
    expect(gone.status).toBe(410);
    expect(gone.headers.get("content-type")).toMatch(/^text\/html/);
  });

  it("shows the visitor none of the drop: no content, no file names, no title", async () => {
    const drop = await publishAt(T0, {
      files: [
        { path: "index.html", text: "<h1>the secret content</h1>" },
        { path: "private-plan.txt", text: "do not leak" },
      ],
      title: "the confidential title",
      expires: "7d",
    });

    const gone = await visitAt(T0 + 8 * DAY, `/${drop.slug}/`);
    const html = await gone.text();
    expect(html).not.toContain("the secret content");
    expect(html).not.toContain("private-plan.txt");
    expect(html).not.toContain("the confidential title");
    expect(html).not.toContain("do not leak");
  });

  it("hides a named path too, not only the drop root", async () => {
    const drop = await publishAt(T0, {
      files: [{ path: "notes.txt", text: "do not leak" }],
      expires: "7d",
    });
    const gone = await visitAt(T0 + 8 * DAY, `/${drop.slug}/notes.txt`);
    expect(gone.status).toBe(410);
    expect(await gone.text()).not.toContain("do not leak");
  });

  it("answers the owning agent 200 with state, so the drop can still be revived", async () => {
    const drop = await publishAt(T0, { files: page("<h1>revivable</h1>"), expires: "7d" });

    const read = await getAt(T0 + 8 * DAY, drop.slug as string);
    expect(read.status).toBe(200);
    const body = (await read.json()) as Json;
    expect(body.state).toBe("expired_grace");
    expect(body.expires_at).toBe(at(T0 + 7 * DAY));
  });

  it("still returns file content to the agent, so it can be pulled back out", async () => {
    const drop = await publishAt(T0, {
      files: [{ path: "report.md", text: "# still readable" }],
      expires: "7d",
    });

    const read = await api(`/_api/v1/drops/${drop.slug}?files=true`, {
      headers: clock(T0 + 8 * DAY),
    });
    const body = (await read.json()) as Json;
    const files = body.files as Array<{ content?: string }>;
    expect(files[0]!.content).toBe("# still readable");
  });

  it("lasts exactly seven days: still grace one second before the window closes", async () => {
    const drop = await publishAt(T0, { files: page("<h1>edge</h1>"), expires: "7d" });
    const read = (await (await getAt(T0 + 14 * DAY - 1000, drop.slug as string)).json()) as Json;
    expect(read.state).toBe("expired_grace");
  });
});

describe("expired_final", () => {
  it("is 410 EXPIRED_FINAL to the agent once the grace window closes", async () => {
    const drop = await publishAt(T0, { files: page("<h1>past recovery</h1>"), expires: "7d" });

    const read = await getAt(T0 + 14 * DAY, drop.slug as string);
    expect(await errorOf(read)).toMatchObject({ status: 410, code: "EXPIRED_FINAL" });
  });

  it("is still 410 to a visitor, and still shows nothing", async () => {
    const drop = await publishAt(T0, { files: page("<h1>the content</h1>"), expires: "7d" });

    const gone = await visitAt(T0 + 20 * DAY, `/${drop.slug}/`);
    expect(gone.status).toBe(410);
    expect(await gone.text()).not.toContain("the content");
  });
});

describe("a drop that never expires", () => {
  it("is live whenever it is asked", async () => {
    const drop = await publishAt(T0, { files: page("<h1>forever</h1>"), expires: "never" });
    expect(drop.expires_at).toBeNull();

    const read = (await (await getAt(T0 + 3650 * DAY, drop.slug as string)).json()) as Json;
    expect(read.state).toBe("live");

    const served = await visitAt(T0 + 3650 * DAY, `/${drop.slug}/`);
    expect(served.status).toBe(200);
  });

  it("gets no expiring marker, because there is no day to sweep it on", async () => {
    const drop = await publishAt(T0, { files: page("<h1>forever</h1>"), expires: "never" });
    const markers = await devKeys("expiring/");
    expect(markers.some((key) => key.endsWith(`/${drop.slug}`))).toBe(false);
  });
});

describe("an expired protected drop", () => {
  it("answers 410, not the unlock form: expiry is checked first", async () => {
    const drop = await publishAt(T0, {
      files: page("<h1>locked and gone</h1>"),
      password: "a-long-enough-password",
      expires: "7d",
    });

    const gone = await visitAt(T0 + 8 * DAY, `/${drop.slug}/`);
    expect(gone.status).toBe(410);
    expect(await gone.text()).not.toContain('name="password"');
  });
});
