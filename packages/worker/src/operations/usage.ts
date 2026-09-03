/**
 * `usage` and `prune` — one scan, one result shape (AGENTS.md, "Pruning").
 *
 * Both answer the same question: what is in this bucket, and how much of it is
 * garbage. So they share a report — counts and bytes per state — and `prune`
 * adds what it deleted. An operator reading `usage` and then running `prune`
 * sees the same numbers move.
 *
 * The scan is `list()` over `drops/`, which gives every object's size without
 * reading one, plus one `GET` of each `meta.json` — the only place a drop's
 * expiry lives, and the only truth about its state. Those GETs are what the
 * budget counts: at `cron_ops_budget` the scan stops, reports `incomplete` and
 * hands back a cursor, so a big instance is swept over several calls instead
 * of one call that the platform kills.
 *
 * Issue #6 owns the hourly cron and the weekly reconcile; this module is the
 * engine both will call, and the manual lever an operator has meanwhile.
 */
import type { Bucket } from "../bindings.js";
import { dropState } from "../domain/expiry.js";
import type { DropMeta } from "../domain/meta.js";
import { expiringKeyOf, listKeyOf } from "./projections.js";
import { DROPS_PREFIX, UPLOADS_PREFIX, slugKey } from "../storage/keys.js";

export type Bucketed = { count: number; bytes: number };

/** The five states an object in the bucket can be in. */
export type UsageState = "live" | "expired_grace" | "expired_final" | "staging" | "orphan";

export type UsageReport = {
  states: Record<UsageState, Bucketed>;
  total: Bucketed;
  /** True when the ops budget ran out before the scan finished. */
  incomplete: boolean;
  cursor?: string;
};

export type PruneReport = UsageReport & {
  dry_run: boolean;
  deleted: { drops: number; objects: number; bytes: number };
};

export type ScanOptions = {
  bucket: Bucket;
  now: Date;
  /** R2 operations this call may spend; `usage` and the cron share it. */
  budget: number;
  /**
   * Where to resume: the id of the last drop a previous call finished. It is
   * NOT an R2 cursor — an R2 cursor points at a page boundary, and the budget
   * runs out in the middle of a page. A drop id is a place both this scan and
   * the cron can start again from exactly once.
   */
  cursor?: string | undefined;
};

const EMPTY = (): Bucketed => ({ count: 0, bytes: 0 });

function emptyStates(): Record<UsageState, Bucketed> {
  return {
    live: EMPTY(),
    expired_grace: EMPTY(),
    expired_final: EMPTY(),
    staging: EMPTY(),
    orphan: EMPTY(),
  };
}

/** One drop's objects, gathered from the `drops/` listing. */
type DropObjects = { id: string; bytes: number; objects: string[]; hasMeta: boolean };

export async function usage(options: ScanOptions): Promise<UsageReport> {
  const report = await scan(options);
  return report.view;
}

/**
 * Delete every drop the scan found in `expired_final` — past its grace window,
 * so `get` and `update` already refuse it and the viewer already answers 410.
 * Nothing else is touched: abandoned uploads are removed by the bucket's own
 * lifecycle rules, and unreferenced blobs by the reconcile (issue #6).
 */
export async function prune(options: ScanOptions & { dryRun: boolean }): Promise<PruneReport> {
  const { view, expired } = await scan(options);
  const deleted = { drops: 0, objects: 0, bytes: 0 };

  if (!options.dryRun) {
    for (const drop of expired) {
      // The two projection keys come from the one place that computes them, so
      // a change to the listing key's shape cannot leave `prune` deleting a key
      // that no longer exists (it did — the key's ms moved from `created` to
      // the drop id in issue #5, and this file kept the old form).
      const keys = [...drop.objects, slugKey(drop.meta.slug), listKeyOf(drop.meta)];
      const marker = expiringKeyOf(drop.meta);
      if (marker !== null) keys.push(marker);
      await options.bucket.delete(keys);
      deleted.drops += 1;
      deleted.objects += keys.length;
      deleted.bytes += drop.bytes;
    }
  }

  return { ...view, dry_run: options.dryRun, deleted };
}

type Expired = { meta: DropMeta; bytes: number; objects: string[] };

/**
 * The scan itself. One `list()` page at a time over `drops/`, grouping objects
 * by drop id — R2 lists in key order, so a drop's objects arrive together and
 * a page boundary is the only place a group can split, which is why the cursor
 * is taken at a drop boundary and never inside one.
 */
async function scan(
  options: ScanOptions,
): Promise<{ view: UsageReport; expired: Expired[] }> {
  const { bucket, now: _now } = options;
  const states = emptyStates();
  const expired: Expired[] = [];

  let spent = 0;
  let incomplete = false;
  let nextCursor: string | undefined;
  let lastDone: string | undefined = options.cursor;
  let pending: DropObjects | null = null;

  /**
   * `startAfter` is exclusive, and `0` is the byte just after `/`, so
   * `drops/<id>0` sits after every `drops/<id>/…` key and before the next
   * drop's. That is how a resumed scan skips a finished drop without listing
   * its objects again.
   */
  const startAfter =
    options.cursor === undefined ? undefined : `${DROPS_PREFIX}${options.cursor}0`;
  let listCursor: string | undefined;

  scanning: for (;;) {
    const listOptions: { prefix: string; cursor?: string; startAfter?: string } = {
      prefix: DROPS_PREFIX,
    };
    if (listCursor !== undefined) listOptions.cursor = listCursor;
    else if (startAfter !== undefined) listOptions.startAfter = startAfter;

    const listing = await bucket.list(listOptions);
    spent += 1;

    for (const object of listing.objects) {
      const id = dropIdOf(object.key);
      if (id === null) continue;

      if (pending !== null && pending.id !== id) {
        if (spent >= options.budget) {
          incomplete = true;
          nextCursor = lastDone;
          break scanning;
        }
        spent += await classify(pending, options, states, expired);
        lastDone = pending.id;
        pending = null;
      }
      if (pending === null) pending = { id, bytes: 0, objects: [], hasMeta: false };

      pending.bytes += object.size ?? 0;
      pending.objects.push(object.key);
      if (object.key.endsWith("/meta.json")) pending.hasMeta = true;
    }

    listCursor = listing.truncated ? listing.cursor : undefined;
    if (listCursor === undefined) break;
  }

  if (pending !== null && !incomplete) {
    if (spent >= options.budget) {
      incomplete = true;
      nextCursor = lastDone;
    } else {
      await classify(pending, options, states, expired);
      lastDone = pending.id;
    }
  }

  // Staged uploads are counted, never classified: they live at most a day and
  // the bucket's own lifecycle rule removes them. An incomplete scan skips
  // them, so the number is never a half-count.
  if (!incomplete) {
    let uploadsCursor: string | undefined;
    do {
      const listing = await bucket.list(
        uploadsCursor === undefined
          ? { prefix: UPLOADS_PREFIX }
          : { prefix: UPLOADS_PREFIX, cursor: uploadsCursor },
      );
      for (const object of listing.objects) {
        states.staging.count += 1;
        states.staging.bytes += object.size ?? 0;
      }
      uploadsCursor = listing.truncated ? listing.cursor : undefined;
    } while (uploadsCursor !== undefined);
  }

  const total = Object.values(states).reduce<Bucketed>(
    (sum, entry) => ({ count: sum.count + entry.count, bytes: sum.bytes + entry.bytes }),
    EMPTY(),
  );

  return {
    view: {
      states,
      total,
      incomplete,
      ...(nextCursor === undefined ? {} : { cursor: nextCursor }),
    },
    expired,
  };
}

/** Reads one `meta.json` and books the drop into a state. Returns ops spent. */
async function classify(
  drop: DropObjects,
  options: ScanOptions,
  states: Record<UsageState, Bucketed>,
  expired: Expired[],
): Promise<number> {
  // Blobs with no `meta.json` are unreachable by construction: nothing can
  // name them, because the manifest that would is inside the file that is
  // missing.
  if (!drop.hasMeta) {
    states.orphan.count += 1;
    states.orphan.bytes += drop.bytes;
    return 0;
  }

  const object = await options.bucket.get(`${DROPS_PREFIX}${drop.id}/meta.json`);
  if (object === null) {
    states.orphan.count += 1;
    states.orphan.bytes += drop.bytes;
    return 1;
  }

  let meta: DropMeta;
  try {
    meta = JSON.parse(await object.text()) as DropMeta;
  } catch {
    states.orphan.count += 1;
    states.orphan.bytes += drop.bytes;
    return 1;
  }

  const state = dropState(meta.expires_at, options.now);
  states[state].count += 1;
  states[state].bytes += drop.bytes;
  if (state === "expired_final") {
    expired.push({ meta, bytes: drop.bytes, objects: drop.objects });
  }
  return 1;
}

/** `drops/<id>/…` → `<id>`. */
function dropIdOf(key: string): string | null {
  const rest = key.slice(DROPS_PREFIX.length);
  const slash = rest.indexOf("/");
  return slash <= 0 ? null : rest.slice(0, slash);
}
