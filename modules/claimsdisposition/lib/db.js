// modules/claimsdisposition/lib/db.js
//
// IndexedDB wrapper for the claims-pull history. One DB, one object store,
// keyed by pullId (string). The dashboard reads the latest pull on mount;
// the SW's pull handler writes a new record on every successful pull.
//
// Why IndexedDB and not chrome.storage.local? A full 10-store/30-day pull
// is ~50MB of rows (180k records). chrome.storage.local handles it under
// the `unlimitedStorage` permission but serializes the entire value on
// every read AND write — opening the source-picker dropdown to list 30
// pulls would deserialize 1.5GB. IndexedDB lets us keep per-pull row arrays
// nested inside one record but only load them on demand.
//
// Record shape:
//   {
//     pullId:           "pull-1717123456789",
//     pulledAt:         1717123456789,
//     days:             30,
//     startDate:        20260429,        // YYYYMMDD int
//     endDate:          20260528,
//     totalRows:        186581,
//     storesByNumber:   { "669": [rawRow, ...], "1089": [...], ... },
//     perStoreSummary:  [{store, ok, totalCount, ms, error, warning}, ...]
//   }
//
// `storesByNumber` rows are the raw 16-column objects from
// looker.js::decodeRows (CSV-header-keyed). The view side runs them through
// load.js::loadDatasetFromPull to materialize canonical records on demand —
// keeps the DB cheap to scan when listing pulls.

const DB_NAME    = "apaisuite-claimsdisposition";
const DB_VERSION = 1;
const STORE_NAME = "pulls";
const INDEX_PULLED_AT = "pulledAt";

// Open (and on first run, upgrade) the database. Returns a Promise<IDBDatabase>.
// Cached after first open so subsequent operations don't pay the open cost.
let _dbPromise = null;
function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      // First-time setup. If the schema ever changes, bump DB_VERSION and
      // add a migration branch here keyed off ev.oldVersion.
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "pullId" });
        store.createIndex(INDEX_PULLED_AT, "pulledAt", { unique: false });
      }
    };
    req.onerror   = () => reject(new Error(`IndexedDB open failed: ${req.error?.message ?? "unknown"}`));
    req.onsuccess = () => resolve(req.result);
    // onblocked fires when another tab has the DB open with an older version.
    // For our single-DB-version-so-far scenario this won't trigger; logging
    // it would help on future migrations.
    req.onblocked = () => console.warn("[claimsdisposition db] open blocked — another tab has an older DB version open");
  });
  return _dbPromise;
}

// Wrap a single IDBRequest in a Promise. The transaction lifecycle is
// implicit — the request completes when its parent transaction does.
function reqAsPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(new Error(req.error?.message ?? "IDBRequest failed"));
  });
}

// Open a transaction on the pulls store. Used as a helper to keep the
// boilerplate out of each public method.
async function tx(mode = "readonly") {
  const db = await openDb();
  const t = db.transaction(STORE_NAME, mode);
  return t.objectStore(STORE_NAME);
}

// ── Public API ──────────────────────────────────────────────────────

// Insert or replace a pull record. Returns the pullId for chaining.
export async function putPull(pull) {
  if (!pull?.pullId) throw new Error("putPull: pull.pullId required");
  if (!pull?.pulledAt) throw new Error("putPull: pull.pulledAt required");
  const store = await tx("readwrite");
  await reqAsPromise(store.put(pull));
  return pull.pullId;
}

// Get the most recent pull (entire record including rows). Returns null if
// the DB is empty. Used by view.js on mount to decide whether to auto-pull.
export async function getLatestPull() {
  const store = await tx("readonly");
  // openCursor on the pulledAt index in "prev" direction gives us the
  // newest record first; we only need the first one.
  return new Promise((resolve, reject) => {
    const req = store.index(INDEX_PULLED_AT).openCursor(null, "prev");
    req.onsuccess = () => {
      const cursor = req.result;
      resolve(cursor ? cursor.value : null);
    };
    req.onerror = () => reject(new Error(req.error?.message ?? "openCursor failed"));
  });
}

// Get one pull by ID. Returns null if not found.
export async function getPullById(pullId) {
  const store = await tx("readonly");
  const got = await reqAsPromise(store.get(pullId));
  return got ?? null;
}

// List all pulls as summaries (no row arrays) — sorted newest-first. Used
// for the source-picker dropdown. Strips storesByNumber from each record
// so the UI doesn't pay the deserialization cost.
export async function listPulls() {
  const store = await tx("readonly");
  return new Promise((resolve, reject) => {
    const out = [];
    const req = store.index(INDEX_PULLED_AT).openCursor(null, "prev");
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) { resolve(out); return; }
      const full = cursor.value;
      out.push({
        pullId:           full.pullId,
        pulledAt:         full.pulledAt,
        days:             full.days,
        startDate:        full.startDate,
        endDate:          full.endDate,
        totalRows:        full.totalRows ?? 0,
        perStoreSummary:  full.perStoreSummary ?? [],
      });
      cursor.continue();
    };
    req.onerror = () => reject(new Error(req.error?.message ?? "openCursor failed"));
  });
}

// Delete one pull by ID.
export async function deletePull(pullId) {
  const store = await tx("readwrite");
  await reqAsPromise(store.delete(pullId));
}

// Keep only the most recent `keepN` pulls — delete everything older.
// Called by the SW after each putPull so the DB doesn't grow unbounded.
export async function pruneOldPulls(keepN = 30) {
  const store = await tx("readwrite");
  // Walk newest-first; once we've seen keepN records, delete the rest.
  let seen = 0;
  const deleted = [];
  await new Promise((resolve, reject) => {
    const req = store.index(INDEX_PULLED_AT).openCursor(null, "prev");
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) { resolve(); return; }
      if (seen >= keepN) {
        deleted.push(cursor.primaryKey);
        cursor.delete();
      } else {
        seen += 1;
      }
      cursor.continue();
    };
    req.onerror = () => reject(new Error(req.error?.message ?? "openCursor failed"));
  });
  return { kept: seen, deleted };
}

// Wipe the whole store. Exposed for the source-picker's "clear history"
// affordance (added later if the UI needs it) and for tests.
export async function clearAll() {
  const store = await tx("readwrite");
  await reqAsPromise(store.clear());
}
