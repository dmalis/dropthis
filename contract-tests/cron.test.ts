import { beforeEach, describe, expect, it } from "vitest";
import { BASE_URL } from "./base-url.js";
import { api, apiJson } from "./client.js";
import type { Json } from "./client.js";

/**
 * The hourly cron, against the deployed dev Worker and its real bucket.
 *
 * `POST /_dev/cron` calls the SAME function the scheduled handler calls, with
 * this request's `DEV-Clock` as "now" and an optional budget override. A test
 * cannot wait an hour, and asserting the cron against a copy of its logic
 * would assert nothing about the deployed Worker.
 *
 * The budget override is a dev parameter rather than a `config set`, because
 * policy is instance-wide and every other contract file shares this instance.
 */

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const GRACE = 7 * DAY;
const at = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const clock = (ms: number) => ({ "DEV-Clock": at(ms) });

/** Far enough ahead that no other contract file's drops share a marker day. */
const T0 = Date.parse("2032-06-01T00:00:00Z");

type CronReport = {
  ran: "sweep" | "reconcile";
  ops: number;
  incomplete: boolean;
  state_writes: number;
  deleted: { drops: number; markers: number; blobs: number; pointers: number; objects: number };
  repaired: { list: number; expiring: number };
  errors: string[];
  state: { oldest_pending_date: string; day_cursor: string | null; reconcile_cursor: string | null };
};

async function publishAt(nowMs: number, body: unknown, init: RequestInit = {}): Promise<Response> {
  return api("/_api/v1/drops", {
    ...init,
    method: "POST",
    headers: { "content-type": "application/json", ...clock(nowMs), ...(init.headers ?? {}) },
    body: JSON.stringify(body),
  });
}

async function dropAt(nowMs: number, expires: string): Promise<Json> {
  const response = await publishAt(nowMs, {
    files: [{ path: "index.html", text: "<h1>sweep me</h1>" }],
    expires,
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as Json;
}

async function cron(nowMs: number, body: Record<string, unknown> = {}): Promise<CronReport> {
  const response = await api("/_dev/cron", {
    method: "POST",
    headers: { "content-type": "application/json", ...clock(nowMs) },
    body: JSON.stringify(body),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as CronReport;
}

const devKeys = async (prefix: string): Promise<string[]> => {
  const response = await apiJson("/_dev/r2/list", "POST", { prefix });
  return ((await response.json()) as { keys: string[] }).keys;
};

/**
 * Every test starts with no checkpoint, so none of them inherits another's.
 * The cron then bootstraps from the bucket's own oldest marker, which is the
 * path a brand-new instance takes anyway.
 */
beforeEach(async () => {
  await apiJson("/_dev/r2/delete", "POST", { keys: ["system/prune-state.json"] });
});

const statusOf = (slug: string, nowMs: number) =>
  api(`/_api/v1/drops/${slug}`, { headers: clock(nowMs) }).then((r) => r.status);

/** Sweep until nothing is left to sweep, so one test's leftovers are not another's. */
async function sweepClean(nowMs: number): Promise<void> {
  for (let run = 0; run < 40; run += 1) {
    if (!(await cron(nowMs, { budget: 45 })).incomplete) return;
  }
  throw new Error("the cron did not settle in 40 runs");
}

describe("what one cron run does", () => {
  it("deletes a drop past its grace window, with its pointer and its blobs", async () => {
    const drop = await dropAt(T0, "7d");
    const slug = drop.slug as string;
    expect(await devKeys(`slugs/${slug}`)).toEqual([`slugs/${slug}`]);

    await sweepClean(T0 + 7 * DAY + GRACE + HOUR);

    expect(await devKeys(`slugs/${slug}`)).toEqual([]);
    expect(await statusOf(slug, T0 + 7 * DAY + GRACE + HOUR)).toBe(404);
    expect(await fetch(`${BASE_URL}/${slug}/`, { cache: "no-store" }).then((r) => r.status)).toBe(
      404,
    );
  });

  it("leaves a drop that is still inside its grace window", async () => {
    const drop = await dropAt(T0, "7d");
    const slug = drop.slug as string;

    const report = await cron(T0 + 7 * DAY + DAY);

    expect(report.ran).toBe("sweep");
    expect(await devKeys(`slugs/${slug}`)).toEqual([`slugs/${slug}`]);
    expect(await statusOf(slug, T0 + 7 * DAY + DAY)).toBe(200);
  });

  it("writes its checkpoint exactly once, whatever it did", async () => {
    await dropAt(T0, "7d");
    const report = await cron(T0 + 7 * DAY + GRACE + HOUR, { budget: 45 });
    expect(report.state_writes).toBe(1);
    await sweepClean(T0 + 7 * DAY + GRACE + HOUR);
  });

  /**
   * A drop expiring at 23:00 must not be skipped because the 09:00 run found
   * nothing due yet, so the checkpoint stops at today and never past it — even
   * on a run that walked the whole bucket with budget to spare.
   */
  it("never records today as finished", async () => {
    const noonMs = Date.parse("2032-08-01T12:00:00Z");
    await sweepClean(noonMs);

    const report = await cron(noonMs, { budget: 45 });

    expect(report.incomplete).toBe(false);
    expect(report.state.oldest_pending_date).toBe("2032-08-01");
    expect(report.state.day_cursor).toBeNull();
  });
});

describe("catching up", () => {
  /**
   * The markers of three different days are three different `expiring/<date>/`
   * prefixes. Walking them a day at a time would cost a list() per day and an
   * instance quiet for a year would never reach its work, so the sweep walks
   * the marker keys themselves — R2's key order IS date order — and empty days
   * cost nothing. One run, three days.
   */
  it("sweeps three days that were missed, in one walk", async () => {
    // Clear whatever earlier files left due before this file's timeline, so
    // the single run below is spending its budget on this test's drops.
    await sweepClean(T0);

    const slugs: string[] = [];
    for (let day = 0; day < 3; day += 1) {
      slugs.push((await dropAt(T0, `${7 + day}d`)).slug as string);
    }

    // Two days after the last grace window closed: three days are overdue.
    // `force` pins the branch: the sweepClean above set the reconcile clock,
    // and eighteen days later the run would otherwise be a reconcile — correct
    // behaviour, but not what this test is about.
    const report = await cron(T0 + 9 * DAY + GRACE + 2 * DAY, { budget: 45, force: "sweep" });

    expect(report.incomplete).toBe(false);
    expect(report.deleted.drops).toBeGreaterThanOrEqual(3);
    for (const slug of slugs) expect(await devKeys(`slugs/${slug}`)).toEqual([]);
  });

  it("replays harmlessly: a second run over the same work deletes nothing", async () => {
    const now = T0 + 9 * DAY + GRACE + 3 * DAY;
    await dropAt(T0, "7d");
    await sweepClean(now);

    const again = await cron(now, { budget: 45 });

    expect(again.deleted.drops).toBe(0);
    expect(again.errors).toEqual([]);
  });
});

describe("the ops budget", () => {
  it("stops inside it, records where it stopped, and the next run continues", async () => {
    const slugs: string[] = [];
    for (let i = 0; i < 6; i += 1) slugs.push((await dropAt(T0, "7d")).slug as string);
    const now = T0 + 7 * DAY + GRACE + HOUR;

    // Deleting one drop costs three calls — read its `meta.json`, list what it
    // owns, delete the lot — on top of the checkpoint, the state read and the
    // first listing. Eight is therefore enough for one drop and not for six.
    const first = await cron(now, { budget: 8 });
    expect(first.ops).toBeLessThanOrEqual(8);
    expect(first.incomplete).toBe(true);
    expect(first.deleted.drops).toBeGreaterThan(0);
    expect(first.deleted.drops).toBeLessThan(6);

    const left = await devKeys("slugs/");
    expect(left.length).toBeGreaterThan(0);

    await sweepClean(now);

    for (const slug of slugs) expect(await devKeys(`slugs/${slug}`)).toEqual([]);
  });
});

describe("the weekly reconcile", () => {
  /**
   * A publish aborted right after it claimed its slug leaves a pointer with no
   * `meta.json` behind it — the exact garbage the reconcile exists for. The
   * dev fault seam is the only way to produce one on purpose.
   */
  it("removes a slug pointer whose publish never finished", async () => {
    const before = new Set(await devKeys("slugs/"));
    const failed = await publishAt(
      T0,
      { files: [{ path: "index.html", text: "<h1>never landed</h1>" }], expires: "30d" },
      { headers: { "DEV-Fault": "slug" } },
    );
    expect(failed.status).toBe(500);

    const orphans = (await devKeys("slugs/")).filter((key) => !before.has(key));
    expect(orphans).toHaveLength(1);

    for (let run = 0; run < 40; run += 1) {
      const report = await cron(T0 + 30 * DAY, { budget: 45, force: "reconcile" });
      expect(report.ran).toBe("reconcile");
      if (report.state.reconcile_cursor === null) break;
    }

    expect(await devKeys(orphans[0]!)).toEqual([]);
  });

  /**
   * Decision #100a: `list` verifies no row against the truth, so an orphan row
   * is the reconcile's alone. This is the test that makes that safe to say.
   */
  it("removes a listing row whose drop is gone", async () => {
    const drop = await dropAt(T0, "300d");
    const slug = drop.slug as string;
    expect((await devKeys("list/")).filter((key) => key.endsWith(`-${slug}`))).toHaveLength(1);

    // Manufacture the orphan: the record only, leaving every pointer behind.
    const pointer = await apiJson("/_dev/r2/get", "POST", { key: `slugs/${slug}` });
    const id = ((await pointer.json()) as { body: string }).body.trim();
    await apiJson("/_dev/r2/delete", "POST", { keys: [`drops/${id}/meta.json`] });

    for (let run = 0; run < 40; run += 1) {
      const report = await cron(T0 + 30 * DAY, { budget: 45, force: "reconcile" });
      if (report.state.reconcile_cursor === null) break;
    }

    expect((await devKeys("list/")).filter((key) => key.endsWith(`-${slug}`))).toEqual([]);
    expect(await devKeys(`slugs/${slug}`)).toEqual([]);
  });

  it("rewrites a listing entry that went missing", async () => {
    const drop = await dropAt(T0, "300d");
    const slug = drop.slug as string;
    const listKeys = await devKeys("list/");
    const mine = listKeys.filter((key) => key.endsWith(`-${slug}`));
    expect(mine).toHaveLength(1);

    await apiJson("/_dev/r2/delete", "POST", { keys: mine });
    expect((await devKeys("list/")).filter((key) => key.endsWith(`-${slug}`))).toEqual([]);

    for (let run = 0; run < 40; run += 1) {
      const report = await cron(T0 + 30 * DAY, { budget: 45, force: "reconcile" });
      if (report.state.reconcile_cursor === null) break;
    }

    expect((await devKeys("list/")).filter((key) => key.endsWith(`-${slug}`))).toEqual(mine);
  });
});
