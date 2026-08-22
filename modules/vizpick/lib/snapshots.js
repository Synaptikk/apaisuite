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
export async function recordYesterday({ rows, grandTotal, sourceUpdate, capturedAt }) {
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
export async function recordToday({ rows, sourceUpdate, capturedAt, partial, market }) {
  const store = await read();
  store.today = {
    sourceKey:    sourceUpdate?.raw ?? null,
    sourceUpdate: sourceUpdate || null,
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
  return t.rows.map((r) => String(r.store));
}

/**
 * Merge a top-up crawl into the existing Today snapshot: same stamp, extra
 * stores. Replacing outright would discard the stores already captured, which
 * is the entire point of only visiting the gaps.
 */
export async function mergeToday({ rows, sourceUpdate, capturedAt, partial, market }) {
  const store = await read();
  const byStore = new Map((store.today?.rows || []).map((r) => [String(r.store), r]));
  for (const r of rows) byStore.set(String(r.store), r);

  store.today = {
    sourceKey:    sourceUpdate?.raw ?? store.today?.sourceKey ?? null,
    sourceUpdate: sourceUpdate || store.today?.sourceUpdate || null,
    rows:         [...byStore.values()],
    capturedAt,
    partial:      !!partial,
    market:       market ?? store.today?.market ?? null,
  };
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
export async function upsertTodayRow({ row, capturedAt, sourceUpdate, market = null }) {
  if (!row?.store) throw new Error("upsertTodayRow: row.store is required");
  const store = await read();
  const existing = store.today;
  const stamped = { ...row, capturedAt };

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

export async function clearAll() {
  await chrome.storage.local.remove([KEY, LEGACY_ROWS, LEGACY_GT]);
}
