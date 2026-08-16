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
//     v: 2,
//     yesterday: { sourceKey, sourceUpdate, rows, grandTotal, capturedAt },
//     previous:  { ...same shape, the snapshot yesterday displaced },
//     today:     { sourceKey, sourceUpdate, rows, capturedAt, partial, market }
//   }
//
// `sourceKey` is the raw Tableau stamp string; it is the identity of a
// dataset. Two captures with the same sourceKey are the same data.

export const SCHEMA_VERSION = 2;
export const KEY = `vizpick.snapshots.v${SCHEMA_VERSION}`;

// Legacy flat keys written by v0.1.0 before snapshots existed.
const LEGACY_ROWS = "vizpick.rows";
const LEGACY_GT   = "vizpick.grandTotal";

function emptyStore() {
  return { v: SCHEMA_VERSION, yesterday: null, previous: null, today: null };
}

/**
 * Read the snapshot store, migrating v0.1.0's flat keys on first use.
 * Any store written by a different schema version is discarded rather than
 * half-read — that is the point of versioning the key.
 */
export async function read() {
  const got = await chrome.storage.local.get([KEY, LEGACY_ROWS, LEGACY_GT]);
  const store = got[KEY];

  if (store && store.v === SCHEMA_VERSION) return { ...emptyStore(), ...store };

  // Migrate: treat pre-snapshot rows as the current Yesterday, with an
  // unknown source stamp so the very next capture is free to replace it
  // without displacing anything into `previous`.
  const legacyRows = got[LEGACY_ROWS];
  if (Array.isArray(legacyRows) && legacyRows.length) {
    return {
      ...emptyStore(),
      yesterday: {
        sourceKey:    null,
        sourceUpdate: null,
        rows:         legacyRows,
        grandTotal:   got[LEGACY_GT] || null,
        capturedAt:   null,
        migrated:     true,
      },
    };
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
  const prev = store.yesterday;

  const snapshot = { sourceKey, sourceUpdate: sourceUpdate || null, rows, grandTotal: grandTotal || null, capturedAt };

  let rolled = false;
  let reason;
  if (!prev) {
    reason = "first capture";
  } else if (sourceKey && prev.sourceKey && sourceKey !== prev.sourceKey) {
    store.previous = prev;
    rolled = true;
    reason = `source stamp advanced ${prev.sourceKey} → ${sourceKey}`;
  } else if (sourceKey && !prev.sourceKey) {
    // Previous snapshot predates stamp capture (or was migrated) — adopt the
    // stamp without claiming the data rolled.
    reason = "adopted first known source stamp";
  } else {
    reason = "source stamp unchanged — refreshed in place";
  }

  store.yesterday = snapshot;
  await write(store);
  return { store, rolled, reason };
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

export async function clearAll() {
  await chrome.storage.local.remove([KEY, LEGACY_ROWS, LEGACY_GT]);
}
