/**
 * The hourly cron: expire, then prune (AGENTS.md, "Pruning").
 *
 * Three properties are the whole design, and each one is a thing that has gone
 * wrong in other people's cleanup jobs:
 *
 *   **The markers are hints, never truth.** `expiring/<date>/<id>` says "look
 *   at this drop on this day". Every step re-reads `meta.json` before it
 *   deletes anything, so a drop whose expiry moved is never deleted by the
 *   marker it left behind — the marker is deleted instead.
 *
 *   **One checkpoint, at the end.** `system/prune-state.json` is written once
 *   per invocation. A crash before that write replays the same work next hour
 *   and every step of it is idempotent: a deleted drop simply reads as 404.
 *
 *   **Today is never finished.** `oldest_pending_date` is only ever advanced
 *   past a day that is over in UTC. A drop expiring at 23:00 must not be
 *   skipped because a 09:00 run found nothing due yet.
 *
 * The budget is counted in R2 CALLS, deletes included. AGENTS.md notes that a
 * delete costs no money, but the Free plan's ceiling is 50 subrequests per
 * invocation and a delete is one of them — so the number that has to stay
 * under `cron_ops_budget` is the number of round trips, not the bill.
 */
import type { Bucket } from "../bindings.js";
import { GRACE_MS, dropState, expiringMarkerDate } from "../domain/expiry.js";
import type { DropMeta } from "../domain/meta.js";
import {
  DROPS_PREFIX,
  EXPIRING_PREFIX,
  LIST_PREFIX,
  PRUNE_STATE_KEY,
  SLUGS_PREFIX,
  expiringKey,
  listKey,
  metaKey,
  slugKey,
} from "../storage/keys.js";

export { PRUNE_STATE_KEY };

/** How often the reconcile runs, in days (AGENTS.md, "every 7th day"). */
export const RECONCILE_EVERY_DAYS = 7;

export type CronState = {
  /** The oldest `expiring/<date>/` day that may still hold unfinished work. */
  oldest_pending_date: string;
  /** The last drop id finished inside that day; the next run resumes after it. */
  day_cursor: string | null;
  /** Where the weekly reconcile stopped: `<phase>:<key>`, or null between runs. */
  reconcile_cursor: string | null;
  /** The UTC day the last reconcile FINISHED, so "every 7th day" is by date. */
  last_reconcile_date: string | null;
  updated: string;
};

export type CronDeleted = {
  drops: number;
  /** `expiring/` markers removed because they disagreed with `meta.json`. */
  markers: number;
  /** Blobs no manifest references any more. */
  blobs: number;
  /** `slugs/`, `list/` and `expiring/` entries with no drop behind them. */
  pointers: number;
  /** Every key removed, whatever kind. */
  objects: number;
};

export type CronReport = {
  ran: "sweep" | "reconcile";
  /** R2 calls spent. Never above the budget. */
  ops: number;
  /** True when the budget ran out with work left; the next run continues. */
  incomplete: boolean;
  /** Always 1. Asserted, because "written once at the end" is the contract. */
  state_writes: number;
  deleted: CronDeleted;
  repaired: { list: number; expiring: number };
  /** Anything the run stepped over rather than crashed on. */
  errors: string[];
  state: CronState;
};

export type CronOptions = {
  bucket: Bucket;
  now: Date;
  /** `cron_ops_budget`: R2 calls this invocation may spend. */
  budget: number;
  /**
   * Force the branch, for a test that wants one of them. Left alone, the run
   * reconciles when a week has passed and sweeps otherwise.
   */
  force?: "sweep" | "reconcile";
};

const utcDate = (at: Date): string => at.toISOString().slice(0, 10);

function nextDate(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / (24 * 60 * 60 * 1000),
  );
}

const emptyDeleted = (): CronDeleted => ({
  drops: 0,
  markers: 0,
  blobs: 0,
  pointers: 0,
  objects: 0,
});

/**
 * The state as stored, tolerantly read. A missing or unreadable file is not an
 * error: the cron works out where to start from the bucket itself.
 */
export async function readCronState(bucket: Bucket): Promise<CronState> {
  const object = await bucket.get(PRUNE_STATE_KEY);
  const fallback: CronState = {
    oldest_pending_date: "",
    day_cursor: null,
    reconcile_cursor: null,
    last_reconcile_date: null,
    updated: "",
  };
  if (object === null) return fallback;
  try {
    const stored = JSON.parse(await object.text()) as Partial<CronState>;
    return {
      oldest_pending_date:
        typeof stored.oldest_pending_date === "string" ? stored.oldest_pending_date : "",
      day_cursor: typeof stored.day_cursor === "string" ? stored.day_cursor : null,
      reconcile_cursor: typeof stored.reconcile_cursor === "string" ? stored.reconcile_cursor : null,
      last_reconcile_date:
        typeof stored.last_reconcile_date === "string" ? stored.last_reconcile_date : null,
      updated: typeof stored.updated === "string" ? stored.updated : "",
    };
  } catch {
    return fallback;
  }
}

/** A counter that refuses to let a run exceed its budget. */
class Budget {
  spent = 0;
  exhausted = false;

  constructor(private readonly limit: number) {}

  /** True when there is room for one more call; records it if so. */
  take(): boolean {
    if (this.spent + 1 > this.limit) {
      this.exhausted = true;
      return false;
    }
    this.spent += 1;
    return true;
  }

  /** Records a call that happens whatever the budget says: the checkpoint. */
  charge(): void {
    this.spent += 1;
  }
}

export async function runCron(options: CronOptions): Promise<CronReport> {
  const { bucket, now } = options;
  const today = utcDate(now);
  // One call is held back for the checkpoint, which is not optional: a run
  // that spent its whole budget on work and could not record where it got to
  // would repeat that work every hour forever.
  const budget = new Budget(Math.max(1, options.budget - 1));

  budget.take();
  const state = await readCronState(bucket);

  // The very first run has no state, so the bucket tells it where to start:
  // `expiring/` sorts by date, so its first key is the oldest pending day.
  if (state.oldest_pending_date === "") {
    state.oldest_pending_date = budget.take() ? await oldestExpiringDay(bucket, today) : today;
  }

  const reconciling =
    options.force === "reconcile" ||
    (options.force !== "sweep" && reconcileDue(state, today));

  const report: CronReport = {
    ran: reconciling ? "reconcile" : "sweep",
    ops: 0,
    incomplete: false,
    state_writes: 0,
    deleted: emptyDeleted(),
    repaired: { list: 0, expiring: 0 },
    errors: [],
    state,
  };

  if (reconciling) await reconcile(bucket, now, budget, state, report);
  else await sweepDays(bucket, now, today, budget, state, report);

  report.incomplete = budget.exhausted;
  state.updated = `${now.toISOString().slice(0, 19)}Z`;

  // (n) The one write. Unconditional: this is the only writer of the key, and
  // a CAS here would turn a lost race into work replayed forever.
  await bucket.put(PRUNE_STATE_KEY, JSON.stringify(state), {
    httpMetadata: { contentType: "application/json" },
  });
  budget.charge();
  report.state_writes = 1;
  report.ops = budget.spent;
  return report;
}

/** `expiring/<date>/<id>` sorts by date, so one short list finds the oldest. */
async function oldestExpiringDay(bucket: Bucket, today: string): Promise<string> {
  const listing = await bucket.list({ prefix: EXPIRING_PREFIX, limit: 1 });
  const first = listing.objects[0];
  if (first === undefined) return today;
  const date = first.key.slice(EXPIRING_PREFIX.length, EXPIRING_PREFIX.length + 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : today;
}

function reconcileDue(state: CronState, today: string): boolean {
  // A reconcile already under way finishes before anything else runs.
  if (state.reconcile_cursor !== null) return true;
  if (state.last_reconcile_date === null) return false;
  return daysBetween(state.last_reconcile_date, today) >= RECONCILE_EVERY_DAYS;
}

/**
 * One ordered walk over `expiring/`, from the oldest pending day up to today.
 *
 * The keys are `expiring/<yyyy-mm-dd>/<id>`, so R2's own key order IS date
 * order and one `list()` returns markers spanning many days at once. Walking
 * day by day instead would cost one `list()` per day, and an instance that was
 * quiet for two years would spend every invocation listing empty days rather
 * than reaching the work — the whole budget, forever.
 *
 * Nothing is ever written for a past day: `resolveExpiry` refuses an expiry in
 * the past, so every new marker lands at least a grace window in the future.
 * That is what makes "everything before today is finished" safe to record.
 */
async function sweepDays(
  bucket: Bucket,
  now: Date,
  today: string,
  budget: Budget,
  state: CronState,
  report: CronReport,
): Promise<void> {
  // A first-ever reconcile is scheduled a week out from the first sweep, so a
  // brand-new instance does not spend its first invocation on an empty bucket.
  if (state.last_reconcile_date === null) state.last_reconcile_date = today;

  const from = state.oldest_pending_date > today ? today : state.oldest_pending_date;
  // `startAfter` is exclusive. `expiring/<date>` sorts before every
  // `expiring/<date>/<id>`, so with no cursor the whole day is still included.
  let after =
    state.day_cursor === null ? from : `${from}/${state.day_cursor}`;

  let stoppedAt: { date: string; id: string } | null = null;
  let reachedEnd = true;

  walking: for (;;) {
    if (!budget.take()) {
      reachedEnd = false;
      break;
    }
    const listing = await bucket.list({
      prefix: EXPIRING_PREFIX,
      startAfter: `${EXPIRING_PREFIX}${after}`,
    });

    for (const object of listing.objects) {
      const rest = object.key.slice(EXPIRING_PREFIX.length);
      const slash = rest.indexOf("/");
      if (slash !== 10) continue;
      const date = rest.slice(0, 10);
      const dropId = rest.slice(11);
      if (dropId.length === 0) continue;

      // A day that has not arrived holds nothing that can be due.
      if (date > today) break walking;

      if (!(await sweepMarker(bucket, now, object.key, date, dropId, budget, report))) {
        reachedEnd = false;
        break walking;
      }
      stoppedAt = { date, id: dropId };
      after = rest;
    }

    if (!listing.truncated) break;
  }

  if (reachedEnd) {
    // Everything up to and including today has been looked at. Today is never
    // recorded as FINISHED — its cursor is cleared, so the next invocation
    // re-examines the markers this one left in place as not yet due.
    state.oldest_pending_date = today;
    state.day_cursor = null;
    return;
  }

  // The budget ran out. Resume exactly after the last marker finished.
  if (stoppedAt === null) {
    state.oldest_pending_date = from;
    return;
  }
  state.oldest_pending_date = stoppedAt.date;
  state.day_cursor = stoppedAt.id;
}

/**
 * One marker. Returns false when the budget ran out before it could be
 * finished — the caller then stops WITHOUT moving the cursor past it, so the
 * next run starts here.
 */
async function sweepMarker(
  bucket: Bucket,
  now: Date,
  markerKey: string,
  date: string,
  dropId: string,
  budget: Budget,
  report: CronReport,
): Promise<boolean> {
  if (!budget.take()) return false;
  const object = await bucket.get(metaKey(dropId));

  // No `meta.json`: the drop is already gone and the marker is litter.
  if (object === null) return dropMarker(bucket, markerKey, budget, report);

  let meta: DropMeta;
  try {
    meta = JSON.parse(await object.text()) as DropMeta;
  } catch {
    report.errors.push(`${metaKey(dropId)} is not readable JSON; left in place.`);
    return true;
  }

  // The marker disagrees with the truth — the expiry moved, or was removed.
  // A stale marker is deleted rather than obeyed, so it can never pin the
  // cursor and never delete a drop that was revived.
  const current = meta.expires_at === null ? null : expiringMarkerDate(meta.expires_at);
  if (current !== date) return dropMarker(bucket, markerKey, budget, report);

  // Still inside its grace window: leave the marker exactly where it is.
  if (dropState(meta.expires_at, now) !== "expired_final") return true;

  return deleteDrop(bucket, meta, markerKey, budget, report);
}

async function dropMarker(
  bucket: Bucket,
  markerKey: string,
  budget: Budget,
  report: CronReport,
): Promise<boolean> {
  if (!budget.take()) return false;
  await bucket.delete(markerKey);
  report.deleted.markers += 1;
  report.deleted.objects += 1;
  return true;
}

/**
 * Delete a drop and everything that points at it. The drop's own prefix is
 * listed rather than read off the manifest, so blobs from generations the
 * current manifest no longer names go with it instead of waiting a week for
 * the reconcile.
 */
async function deleteDrop(
  bucket: Bucket,
  meta: DropMeta,
  markerKey: string,
  budget: Budget,
  report: CronReport,
): Promise<boolean> {
  if (!budget.take()) return false;
  const owned: string[] = [];
  let cursor: string | undefined;
  do {
    const listing = await bucket.list(
      cursor === undefined
        ? { prefix: `${DROPS_PREFIX}${meta.id}/` }
        : { prefix: `${DROPS_PREFIX}${meta.id}/`, cursor },
    );
    for (const object of listing.objects) owned.push(object.key);
    cursor = listing.truncated ? listing.cursor : undefined;
    if (cursor !== undefined && !budget.take()) return false;
  } while (cursor !== undefined);

  if (!budget.take()) return false;
  const keys = [
    ...owned,
    slugKey(meta.slug),
    listKey(Date.parse(meta.created), meta.slug),
    markerKey,
  ];
  await bucket.delete(keys);

  report.deleted.drops += 1;
  report.deleted.blobs += owned.filter((key) => key.includes("/blobs/")).length;
  report.deleted.objects += keys.length;
  return true;
}

/**
 * The weekly reconcile, in four phases so one invocation can stop anywhere and
 * the next resumes at the same place. The cursor is `<phase>:<key>`.
 *
 *   drops     unreferenced blobs older than a day; a missing or stale `list/`
 *             or `expiring/` entry rewritten from `meta.json`
 *   slugs     pointers whose `meta.json` never appeared
 *   list      listing entries whose drop is gone
 *   expiring  markers whose drop is gone
 *
 * A blob is only removed once it is a day old. A publish writes its blobs
 * BEFORE the `meta.json` that names them, so a blob written seconds ago may
 * belong to a call that is still running.
 */
const PHASES = ["drops", "slugs", "list", "expiring"] as const;
type Phase = (typeof PHASES)[number];

/** How old an unreferenced blob must be before the reconcile may remove it. */
export const UNREFERENCED_BLOB_AGE_MS = 24 * 60 * 60 * 1000;

async function reconcile(
  bucket: Bucket,
  now: Date,
  budget: Budget,
  state: CronState,
  report: CronReport,
): Promise<void> {
  const [startPhase, startKey] = splitCursor(state.reconcile_cursor);

  for (let i = PHASES.indexOf(startPhase); i < PHASES.length; i += 1) {
    const phase = PHASES[i]!;
    const after = phase === startPhase ? startKey : null;
    const stoppedAt = await reconcilePhase(bucket, now, phase, after, budget, report);
    if (stoppedAt !== null) {
      state.reconcile_cursor = `${phase}:${stoppedAt}`;
      return;
    }
  }

  // Every phase finished: the reconcile is done for this week.
  state.reconcile_cursor = null;
  state.last_reconcile_date = utcDate(now);
}

function splitCursor(cursor: string | null): [Phase, string | null] {
  if (cursor === null) return ["drops", null];
  const colon = cursor.indexOf(":");
  const phase = colon < 0 ? cursor : cursor.slice(0, colon);
  const key = colon < 0 ? null : cursor.slice(colon + 1);
  return [
    (PHASES as readonly string[]).includes(phase) ? (phase as Phase) : "drops",
    key === null || key.length === 0 ? null : key,
  ];
}

const PREFIX_OF: Record<Phase, string> = {
  drops: DROPS_PREFIX,
  slugs: SLUGS_PREFIX,
  list: LIST_PREFIX,
  expiring: EXPIRING_PREFIX,
};

/**
 * One phase. Returns where it stopped, or null when the phase is finished.
 *
 * The `drops` phase groups by drop id, and R2 lists in key order, so a drop's
 * objects arrive together and only a page boundary can split one. Continuation
 * INSIDE an invocation uses R2's own cursor; the cursor that survives BETWEEN
 * invocations is a drop boundary (`<id>0` — `0` is the byte just after `/`),
 * because the budget runs out in the middle of a page and an R2 cursor points
 * at a page.
 */
async function reconcilePhase(
  bucket: Bucket,
  now: Date,
  phase: Phase,
  startAfter: string | null,
  budget: Budget,
  report: CronReport,
): Promise<string | null> {
  const prefix = PREFIX_OF[phase];
  let after = startAfter;
  let listCursor: string | undefined;
  let pending: DropGroup | null = null;

  for (;;) {
    if (!budget.take()) return after;
    const listing = await bucket.list({
      prefix,
      ...(listCursor !== undefined
        ? { cursor: listCursor }
        : after === null
          ? {}
          : { startAfter: `${prefix}${after}` }),
    });

    if (phase === "drops") {
      for (const object of listing.objects) {
        const rest = object.key.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash <= 0) continue;
        const id = rest.slice(0, slash);

        if (pending !== null && pending.id !== id) {
          if (!(await reconcileDrop(bucket, now, pending, budget, report))) return after;
          after = `${pending.id}0`;
          pending = null;
        }
        if (pending === null) pending = { id, objects: [] };
        pending.objects.push(object);
      }
    } else {
      for (const object of listing.objects) {
        const name = object.key.slice(prefix.length);
        if (!(await reconcilePointer(bucket, phase, object.key, name, budget, report))) {
          return after;
        }
        after = name;
      }
    }

    listCursor = listing.truncated ? listing.cursor : undefined;
    if (listCursor === undefined) break;
  }

  if (pending !== null) {
    if (!(await reconcileDrop(bucket, now, pending, budget, report))) return after;
  }
  return null;
}

type DropGroup = { id: string; objects: Array<{ key: string; uploaded?: Date }> };

async function reconcileDrop(
  bucket: Bucket,
  now: Date,
  group: DropGroup,
  budget: Budget,
  report: CronReport,
): Promise<boolean> {
  const metaObject = group.objects.find((object) => object.key === metaKey(group.id));
  const blobs = group.objects.filter((object) => object.key.includes("/blobs/"));

  const old = (object: { uploaded?: Date }): boolean =>
    object.uploaded === undefined ||
    now.getTime() - object.uploaded.getTime() >= UNREFERENCED_BLOB_AGE_MS;

  // No `meta.json`: nothing can reference these blobs, because the manifest
  // that would is inside the file that is missing.
  if (metaObject === undefined) {
    const stale = blobs.filter(old).map((object) => object.key);
    if (stale.length > 0) {
      if (!budget.take()) return false;
      await bucket.delete(stale);
      report.deleted.blobs += stale.length;
      report.deleted.objects += stale.length;
    }
    return true;
  }

  if (!budget.take()) return false;
  const object = await bucket.get(metaKey(group.id));
  if (object === null) return true;

  let meta: DropMeta;
  try {
    meta = JSON.parse(await object.text()) as DropMeta;
  } catch {
    report.errors.push(`${metaKey(group.id)} is not readable JSON; left in place.`);
    return true;
  }

  const referenced = new Set(
    Object.values(meta.manifest).map((entry) => `${DROPS_PREFIX}${meta.id}/blobs/${entry.sha256}`),
  );
  const unreferenced = blobs
    .filter((blob) => !referenced.has(blob.key) && old(blob))
    .map((blob) => blob.key);
  if (unreferenced.length > 0) {
    if (!budget.take()) return false;
    await bucket.delete(unreferenced);
    report.deleted.blobs += unreferenced.length;
    report.deleted.objects += unreferenced.length;
  }

  return repairProjections(bucket, meta, budget, report);
}

/** Rewrite a `list/` or `expiring/` entry that is missing or out of date. */
async function repairProjections(
  bucket: Bucket,
  meta: DropMeta,
  budget: Budget,
  report: CronReport,
): Promise<boolean> {
  const key = listKey(Date.parse(meta.created), meta.slug);
  if (!budget.take()) return false;
  const entry = await bucket.head(key);
  if (entry === null || entry.customMetadata?.updated !== meta.updated) {
    if (!budget.take()) return false;
    const customMetadata: Record<string, string> = {
      id: meta.id,
      updated: meta.updated,
      created_by_id: meta.created_by.id,
      created_by_label: meta.created_by.label,
    };
    if (meta.expires_at !== null) customMetadata.expires_at = meta.expires_at;
    if (meta.title !== null) customMetadata.title = meta.title;
    await bucket.put(key, "", { customMetadata });
    report.repaired.list += 1;
  }

  if (meta.expires_at === null) return true;
  const markerKey = expiringKey(expiringMarkerDate(meta.expires_at), meta.id);
  if (!budget.take()) return false;
  if ((await bucket.head(markerKey)) === null) {
    if (!budget.take()) return false;
    await bucket.put(markerKey, "");
    report.repaired.expiring += 1;
  }
  return true;
}

/**
 * A pointer with nothing behind it. `slugs/` holds a drop id; `list/` and
 * `expiring/` hold one in their name or their metadata. In every case the
 * question is the same: is there still a `meta.json`?
 */
async function reconcilePointer(
  bucket: Bucket,
  phase: Phase,
  key: string,
  name: string,
  budget: Budget,
  report: CronReport,
): Promise<boolean> {
  let dropId: string | null = null;

  if (phase === "slugs") {
    if (!budget.take()) return false;
    const pointer = await bucket.get(key);
    if (pointer === null) return true;
    // A slug claimed by a staged upload that is still running owns its name:
    // its `meta.json` does not exist yet, and removing it would strand it.
    if (pointer.customMetadata?.pending_upload !== undefined) return true;
    dropId = (await pointer.text()).trim();
  } else if (phase === "expiring") {
    const slash = name.indexOf("/");
    dropId = slash < 0 ? null : name.slice(slash + 1);
  } else {
    if (!budget.take()) return false;
    const entry = await bucket.head(key);
    dropId = entry?.customMetadata?.id ?? null;
  }

  if (dropId === null || dropId.length === 0) return true;

  if (!budget.take()) return false;
  if ((await bucket.head(metaKey(dropId))) !== null) return true;

  if (!budget.take()) return false;
  await bucket.delete(key);
  report.deleted.pointers += 1;
  report.deleted.objects += 1;
  return true;
}
