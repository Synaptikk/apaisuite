import { isTodayRowComplete, mergeTodayRow } from "./today_coverage.js";
import * as homeHistory from "./home_history.js";
import * as dayDetails from "./day_details.js";
import { stampSpread, rowSourceUpdate } from "./store_stamp.js";
export { rowSourceUpdate };

// The snapshot-level stamp is a SUMMARY: the newest of the rows' own stamps.
// Stores publish their current-day numbers on their own clocks, so each row
// carries its own `sourceUpdate` (since 2026-09-15); rows written before that
// have none, and the stamp passed by the writer stands in for them.
function snapshotStamp(rows, passed, previous) {
  return stampSpread(rows).newest ?? passed ?? previous ?? null;
}

// The snapshot about to be overwritten may hold the last reading of an earlier
// day (the first crawl of a morning replaces last night's rows). Filed under
// each row's own stamp, with the OLD snapshot's stamp standing in for rows that
// have none — never the incoming crawl's. Never throws (lib/day_details.js).
function archiveReplaced(today) {
  if (!today?.rows?.length) return Promise.resolve();
  return dayDetails.recordFromRows(today.rows, { sourceUpdate: today.sourceUpdate, capturedAt: today.capturedAt });
}

let writeQueue = Promise.resolve();
function serializeWrite(operation) {
  const run = () => globalThis.navigator?.locks?.request
    ? navigator.locks.request("apaisuite.vizpick.snapshots", operation)
    : operation();
  const result = writeQueue.then(run, run);
  writeQueue = result.catch(() => {});
  return result;
}

// modules/vizpick/lib/snapshots.js
//
// Day-scoped, versioned snapshot store for the VizPick tabs.
//
// WHY THE ROLL IS DRIVEN BY THE SOURCE STAMP, NOT THE CALENDAR
// -------------------------------------------------------------
// The Yesterday view is refreshed once a day by an upstream job. If we rolled
// "yesterday" forward at local midnight we would roll before Tableau has
// published the new day — leaving a Yesterday tab holding data that is
// actually two days old while labelled as one. Instead every snapshot carries
// the workbook's own "Last update" stamp, and the previous snapshot is only
// displaced when a genuinely NEW source stamp arrives. Reopening the module,
// or refreshing against an unchanged upstream, therefore cannot disturb the
// stored history.
//
// Layout under chrome.storage.local["vizpick.snapshots.v2"]:
//   {
//     v: 3,
//     days:  [ { dataDate, sourceKey, sourceUpdate, rows, grandTotal, capturedAt } ],
//            // newest first, capped at MAX_DAYS
//     today: { sourceKey, sourceUpdate, rows, capturedAt, partial, market }
//   }
//
// `dataDate` is the day the numbers DESCRIBE, not the day they were published:
// the summary view is "refreshed daily for the day prior", so it is the source
// stamp minus one day. Keying on it is what makes the history idempotent — a
// second capture of the same day updates that entry instead of appending a
// duplicate.
//
// `sourceKey` is the raw Tableau stamp string; it is the identity of a
// dataset. Two captures with the same sourceKey are the same data.

export const SCHEMA_VERSION = 3;

// How many closed days to keep. Each day is one crosstab of every store in
// every market (~4,600 rows), so seven is a few MB — comfortably inside the
// unlimitedStorage the suite already requests.
export const MAX_DAYS = 7;
export const KEY = `vizpick.snapshots.v${SCHEMA_VERSION}`;

// Legacy flat keys written by v0.1.0 before snapshots existed.
const LEGACY_ROWS = "vizpick.rows";
const LEGACY_GT   = "vizpick.grandTotal";
// The store key embeds the schema version, so bumping the version also changes
// the key — a v2 store is invisible to a v3 read unless we ask for it by name.
const V2_KEY = "vizpick.snapshots.v2";

function emptyStore() {
  return { v: SCHEMA_VERSION, days: [], today: null };
}

/**
 * Enforce the history invariants on the way OUT, not just on the way in:
 * newest first, and never more than MAX_DAYS. Doing it only in
 * recordYesterday() left the cap unenforced for any store written by another
 * path (a migration, a hand-edit, a future importer), so the cap was a
 * convention rather than a guarantee.
 */
function normalise(store) {
  const days = [...(store.days || [])]
    .sort((a, b) => String(b.dataDate ?? "").localeCompare(String(a.dataDate ?? "")))
    .slice(0, MAX_DAYS);
  return { ...store, days };
}

/** YYYY-MM-DD in local time — the calendar day these numbers describe. */
export function deriveDataDate(sourceUpdate, capturedAt) {
  const iso = sourceUpdate?.iso || capturedAt;
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() - 1);   // "refreshed daily for the day prior"
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Read the snapshot store, migrating v0.1.0's flat keys on first use.
 * Any store written by a different schema version is discarded rather than
 * half-read — that is the point of versioning the key.
 */
export async function read() {
  const got = await chrome.storage.local.get([KEY, V2_KEY, LEGACY_ROWS, LEGACY_GT]);
  const store = got[KEY];

  if (store && store.v === SCHEMA_VERSION) return normalise({ ...emptyStore(), ...store });

  // v2 kept exactly two closed days as `yesterday` + `previous`. Carry both
  // forward as the first two entries of the new history rather than dropping
  // them — they are real captures the user has already paid for.
  const v2 = got[V2_KEY];
  if (v2 && v2.v === 2) {
    const days = [v2.yesterday, v2.previous]
      .filter(Boolean)
      .map((d) => ({ ...d, dataDate: d.dataDate || deriveDataDate(d.sourceUpdate, d.capturedAt) }));
    const migrated = normalise({ ...emptyStore(), days, today: v2.today || null });
    // Persist immediately. A purely in-memory migration would be re-derived on
    // every read and, more importantly, would leave the v3 key empty until the
    // next capture — so anything inspecting storage sees no history at all.
    await write(migrated);
    return migrated;
  }

  // Migrate: treat pre-snapshot rows as the current Yesterday, with an
  // unknown source stamp so the very next capture is free to replace it
  // without displacing anything into `previous`.
  const legacyRows = got[LEGACY_ROWS];
  if (Array.isArray(legacyRows) && legacyRows.length) {
    const migrated = {
      ...emptyStore(),
      days: [{
        dataDate:     null,
        sourceKey:    null,
        sourceUpdate: null,
        rows:         legacyRows,
        grandTotal:   got[LEGACY_GT] || null,
        capturedAt:   null,
        migrated:     true,
      }],
    };
    await write(migrated);
    return migrated;
  }
  return emptyStore();
}

async function write(store) {
  await chrome.storage.local.set({ [KEY]: { ...store, v: SCHEMA_VERSION } });
}

/**
 * Record a Yesterday-view capture.
 *
 * Roll rules:
 *   · unchanged sourceKey → refresh the rows in place, leave `previous` alone
 *     (a manual Refresh against an unpublished upstream is a no-op, and
 *     reopening the module never destroys history);
 *   · new sourceKey       → the standing snapshot becomes `previous` and the
 *     new one becomes `yesterday`;
 *   · unknown sourceKey (Last update sheet unreadable) → treated as a plain
 *     in-place refresh, because we cannot prove the data changed.
 *
 * @returns {Promise<{store:object, rolled:boolean, reason:string}>}
 */
export async function recordYesterday(...args) {
  return serializeWrite(() => recordYesterdayImpl(...args));
}

async function recordYesterdayImpl({ rows, grandTotal, sourceUpdate, capturedAt }) {
  const store = await read();
  const sourceKey = sourceUpdate?.raw ?? null;
  const dataDate  = deriveDataDate(sourceUpdate, capturedAt);
  const prev = store.days[0] || null;

  const entry = { dataDate, sourceKey, sourceUpdate: sourceUpdate || null, rows, grandTotal: grandTotal || null, capturedAt };

  // Keyed by the day the data describes, so re-capturing the same day updates
  // it in place. Only a genuinely new day extends the history.
  const existingIdx = dataDate ? store.days.findIndex((d) => d.dataDate === dataDate) : -1;

  let rolled = false;
  let reason;
  if (existingIdx >= 0) {
    store.days[existingIdx] = entry;
    reason = `refreshed the stored day ${dataDate}`;
  } else if (!prev) {
    store.days = [entry];
    reason = "first capture";
  } else {
    store.days = [entry, ...store.days];
    rolled = true;
    reason = `new day ${dataDate} (previous newest was ${prev.dataDate ?? "unknown"})`;
  }

  // normalise() sorts newest-first and applies the cap, so a capture that
  // arrives out of order (an older day fetched late) still lands correctly.
  const trimmed = normalise(store);
  await write(trimmed);
  return { store: trimmed, rolled, reason, dataDate, dayCount: trimmed.days.length };
}

/**
 * Record a Today-view capture. Today has no history to preserve — it is
 * simply replaced, keyed by its own (much finer-grained) source timestamp.
 */
export async function recordToday(...args) {
  return serializeWrite(() => recordTodayImpl(...args));
}

async function recordTodayImpl({ rows, sourceUpdate, capturedAt, partial, market }) {
  // Every Today write path feeds the home-store history. Only home-store rows
  // carry bins, and identical data is deduplicated there. Never throws.
  await homeHistory.recordFromRows(rows, { sourceUpdate, capturedAt });
  const store = await read();
  const old = store.today;
  await archiveReplaced(old);
  await dayDetails.recordFromRows(rows, { sourceUpdate, capturedAt });
  const sameSource = !!sourceUpdate?.raw && old?.sourceKey === sourceUpdate.raw
    && String(old?.market) === String(market);
  if (sameSource && partial) {
    const merged = new Map((old.rows || []).map((r) => [String(r.store), r]));
    for (const row of rows) {
      const oldRow = merged.get(String(row.store));
      merged.set(String(row.store), mergeTodayRow(oldRow, row));
    }
    rows = [...merged.values()];
    partial = old.partial;
    capturedAt = old.capturedAt;
  }
  const stamp = snapshotStamp(rows, sourceUpdate, null);
  store.today = {
    sourceKey:    stamp?.raw ?? null,
    sourceUpdate: stamp,
    rows,
    capturedAt,
    partial: !!partial,
    market: market ?? null,
  };
  await write(store);
  return store;
}

/**
 * Would a Today capture at this source stamp be redundant? Lets the UI skip
 * a multi-minute per-store crawl when Tableau has not published anything new.
 */
export function todayIsCurrent(store, sourceKey, market) {
  const t = store?.today;
  if (!t || !t.sourceKey || !sourceKey) return false;
  if (market != null && t.market != null && String(t.market) !== String(market)) return false;
  return t.sourceKey === sourceKey;
}

/** Stores held by the current Today snapshot, for this market only. */
export function todayCoveredStores(store, market) {
  const t = store?.today;
  if (!t?.rows?.length) return [];
  if (market != null && t.market != null && String(t.market) !== String(market)) return [];
  return t.rows.filter(isTodayRowComplete).map((r) => String(r.store));
}

/**
 * Merge a crawl's rows into the existing Today snapshot for the same market.
 * Replacing outright would discard the stores the crawl did not re-read —
 * and since 2026-09-15 that is the normal case: a store whose own Updated
 * stamp has not moved is confirmed, not exported, so its row must survive.
 *
 * Only a different MARKET empties the snapshot: its rows are other stores'.
 * A changed crawl-level stamp does not — stores publish on their own clocks,
 * and each row keeps its own stamp.
 */
export async function mergeToday(...args) {
  return serializeWrite(() => mergeTodayImpl(...args));
}

async function mergeTodayImpl({ rows, sourceUpdate, capturedAt, partial, market }) {
  await homeHistory.recordFromRows(rows, { sourceUpdate, capturedAt });
  const store = await read();
  const sameMarket = !!store.today && String(store.today?.market) === String(market);
  const byStore = new Map((sameMarket ? store.today?.rows || [] : []).map((r) => [String(r.store), r]));
  for (const r of rows) {
    const oldRow = byStore.get(String(r.store));
    byStore.set(String(r.store), mergeTodayRow(oldRow, r));
  }
  if (sameMarket && partial && store.today?.partial === false) {
    partial = false;
    capturedAt = store.today.capturedAt;
  }

  const merged = [...byStore.values()];
  // Replaced rows first: a store's previous row may be an earlier day's last reading.
  // (merged rows that did not change fold to a no-op.)
  await archiveReplaced(store.today);
  await dayDetails.recordFromRows(merged, { sourceUpdate, capturedAt });
  const stamp = snapshotStamp(merged, sourceUpdate, sameMarket ? store.today?.sourceUpdate : null);
  store.today = {
    sourceKey:    stamp?.raw ?? null,
    sourceUpdate: stamp,
    rows:         merged,
    capturedAt,
    partial:      !!partial,
    market:       market ?? store.today?.market ?? null,
  };
  await write(store);
  return store;
}

/**
 * Note that a store's own Updated stamp was read again and had not moved:
 * its stored row stands. Only `confirmedAt` advances — `capturedAt` stays
 * the moment the numbers were actually exported, so the per-store age
 * ceiling (MAX_TODAY_AGE_MS in the Today source) still forces a real
 * re-read eventually. A row that predates per-store stamps takes the stamp
 * it was just confirmed at. No row for the store: nothing to confirm.
 */
export async function confirmTodayRow(...args) {
  return serializeWrite(() => confirmTodayRowImpl(...args));
}

async function confirmTodayRowImpl({ store: storeNo, confirmedAt, sourceUpdate = null, market = null }) {
  const store = await read();
  const t = store.today;
  if (!t?.rows?.length) return store;
  if (market != null && t.market != null && String(t.market) !== String(market)) return store;
  let touched = false;
  const rows = t.rows.map((r) => {
    if (String(r.store) !== String(storeNo)) return r;
    touched = true;
    return {
      ...r,
      confirmedAt: confirmedAt ?? new Date().toISOString(),
      sourceUpdate: r.sourceUpdate?.raw ? r.sourceUpdate : (sourceUpdate ?? r.sourceUpdate ?? null),
    };
  });
  if (!touched) return store;
  store.today = { ...t, rows };
  await write(store);
  return store;
}

/**
 * Refresh ONE store inside the existing Today snapshot.
 *
 * Distinct from mergeToday() on purpose. That merges a top-up crawl — extra
 * stores captured in the same run, at the same source stamp — so giving the
 * whole snapshot one `capturedAt` is honest there. This is for a single store
 * re-captured on its own, potentially hours later (metricshot's schedule fires
 * and finds the stored row stale). Advancing the snapshot-level `capturedAt`
 * in that case would tell the market rollup every store had just been
 * refreshed when only one had, and the rollup's own staleness checks would
 * then skip the crawl the other stores actually needed.
 *
 * So the freshness lands on the ROW. Readers should prefer
 * `row.capturedAt ?? today.capturedAt` — the fallback covers rows written
 * before this existed, and by any path that still writes whole crawls.
 *
 * The snapshot-level fields are only initialised when there is no Today
 * snapshot at all; otherwise they are left exactly as they were.
 */
export async function upsertTodayRow(...args) {
  return serializeWrite(() => upsertTodayRowImpl(...args));
}

async function upsertTodayRowImpl({ row, capturedAt, sourceUpdate, market = null }) {
  if (!row?.store) throw new Error("upsertTodayRow: row.store is required");
  // metricshot's 10/14/20 schedule lands here — an update the crawl may miss.
  await homeHistory.recordFromRows([{ ...row, capturedAt }], { sourceUpdate, capturedAt });
  const store = await read();
  const existing = store.today;
  const stamped = { ...row, capturedAt };
  await archiveReplaced(existing);
  await dayDetails.recordFromRows([stamped], { sourceUpdate, capturedAt });

  const byStore = new Map((existing?.rows || []).map((r) => [String(r.store), r]));
  byStore.set(String(row.store), stamped);

  store.today = existing
    ? { ...existing, rows: [...byStore.values()] }
    : {
        sourceKey:    sourceUpdate?.raw ?? null,
        sourceUpdate: sourceUpdate || null,
        rows:         [stamped],
        capturedAt,
        // One store is not a market. Saying so keeps the rollup from treating
        // this as a crawl that covered everything.
        partial:      true,
        market:       market ?? null,
      };

  await write(store);
  return store;
}

/** When was this specific row captured? Falls back to the snapshot's stamp. */
export function rowCapturedAt(row, today) {
  return row?.capturedAt ?? today?.capturedAt ?? null;
}

export async function clearAll(...args) {
  return serializeWrite(() => clearAllImpl(...args));
}

async function clearAllImpl() {
  await chrome.storage.local.remove([KEY, LEGACY_ROWS, LEGACY_GT]);
}
