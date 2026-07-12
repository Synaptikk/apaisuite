// modules/digitallocks/lib/db.js
//
// IndexedDB wrapper for the per-import event store.
//
// Why IndexedDB and not chrome.storage.local: a single Power BI export can
// reach tens of thousands of rows over a multi-day pull. chrome.storage.local
// serializes the entire value on every read/write, so every status edit
// would rewrite the whole import blob. IndexedDB lets us keep imports
// immutable + load only the active one on demand. Same pattern as
// claimsdisposition/lib/db.js.
//
// Schema (v1):
//   Object store "imports" — keyPath "importId"
//     {
//       importId:        string ("imp-<epochMs>")
//       importedAt:      number (epoch ms)
//       sourceFileName:  string
//       summary: {
//         rowCount, dateRange: { min, max }, stores: string[],
//         scoreBands: { Normal, Watch, High, Critical }
//       },
//       events:          DigitalLockEvent[]  (frozen at import time)
//     }
//   Index "importedAt" — sort newest-first via openCursor(null, "prev")
//
// Active-vs-history concept lives on TOP of this store as a single
// `activeImportId` value persisted via host.storage.local (see view.js).
// The store itself is just a sorted log; nothing here knows "active".

const DB_NAME    = "apaisuite-digitallocks";
const DB_VERSION = 2;
const STORE      = "imports";
const MAP_STORE  = "caseItemMappings";
const INDEX_AT   = "importedAt";

let _dbPromise = null;
function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      // v1 store (unchanged)
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: "importId" });
        os.createIndex(INDEX_AT, "importedAt", { unique: false });
      }
      // v2 store — case-item mappings
      if (!db.objectStoreNames.contains(MAP_STORE)) {
        const ms = db.createObjectStore(MAP_STORE, { keyPath: "mappingId" });
        ms.createIndex(INDEX_AT, "importedAt", { unique: false });
      }
    };
    req.onerror   = () => reject(new Error(`IndexedDB open failed: ${req.error?.message ?? "unknown"}`));
    req.onsuccess = () => resolve(req.result);
    req.onblocked = () => console.warn("[digitallocks db] open blocked — another tab has an older DB version open");
  });
  return _dbPromise;
}

function reqAsPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(new Error(req.error?.message ?? "IDBRequest failed"));
  });
}

async function tx(mode = "readonly") {
  const db = await openDb();
  return db.transaction(STORE, mode).objectStore(STORE);
}

async function mapTx(mode = "readonly") {
  const db = await openDb();
  return db.transaction(MAP_STORE, mode).objectStore(MAP_STORE);
}

// ── Case-item mapping CRUD ──────────────────────────────────────────

export function newMappingId() {
  return `casemap-${Date.now()}`;
}

export async function putMapping(record) {
  if (!record?.mappingId) throw new Error("putMapping: record.mappingId required");
  const store = await mapTx("readwrite");
  await reqAsPromise(store.put(record));
  return record.mappingId;
}

export async function getMapping(mappingId) {
  const store = await mapTx("readonly");
  return (await reqAsPromise(store.get(mappingId))) ?? null;
}

export async function listMappings() {
  const store = await mapTx("readonly");
  return new Promise((resolve, reject) => {
    const out = [];
    const req = store.index(INDEX_AT).openCursor(null, "prev");
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) { resolve(out); return; }
      const v = cursor.value;
      out.push({
        mappingId:      v.mappingId,
        importedAt:     v.importedAt,
        sourceFileName: v.sourceFileName,
        summary:        v.summary,
      });
      cursor.continue();
    };
    req.onerror = () => reject(new Error(req.error?.message ?? "listMappings cursor failed"));
  });
}

export async function deleteMapping(mappingId) {
  const store = await mapTx("readwrite");
  await reqAsPromise(store.delete(mappingId));
}


// ── Public API ──────────────────────────────────────────────────────

export function newImportId() {
  return `imp-${Date.now()}`;
}

export async function putImport(record) {
  if (!record?.importId) throw new Error("putImport: record.importId required");
  if (!record?.importedAt) throw new Error("putImport: record.importedAt required");
  const store = await tx("readwrite");
  await reqAsPromise(store.put(record));
  return record.importId;
}

export async function getImport(importId) {
  const store = await tx("readonly");
  return (await reqAsPromise(store.get(importId))) ?? null;
}

/**
 * List import summaries newest-first. Strips the heavy `events` array off
 * each record so the source-picker dropdown stays cheap even when a few
 * dozen imports are saved.
 */
export async function listImports() {
  const store = await tx("readonly");
  return new Promise((resolve, reject) => {
    const out = [];
    const req = store.index(INDEX_AT).openCursor(null, "prev");
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) { resolve(out); return; }
      const v = cursor.value;
      out.push({
        importId:       v.importId,
        importedAt:     v.importedAt,
        sourceFileName: v.sourceFileName,
        summary:        v.summary,
      });
      cursor.continue();
    };
    req.onerror = () => reject(new Error(req.error?.message ?? "openCursor failed"));
  });
}

export async function deleteImport(importId) {
  const store = await tx("readwrite");
  await reqAsPromise(store.delete(importId));
}

export async function clearAllImports() {
  const store = await tx("readwrite");
  await reqAsPromise(store.clear());
}

/**
 * Delete all imports whose importedAt timestamp is older than cutoffMs.
 * Called on mount to enforce the 72-hour retention window.
 * @param {number} cutoffMs  epoch ms — imports before this are deleted
 * @returns {Promise<number>} count of deleted imports
 */
export async function deleteImportsBefore(cutoffMs) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, "readwrite");
    const os = t.objectStore(STORE);
    const idx = os.index(INDEX_AT);
    // IDBKeyRange.upperBound(cutoffMs, true) = all keys strictly < cutoffMs.
    const range = IDBKeyRange.upperBound(cutoffMs, true);
    const req = idx.openCursor(range);
    let deleted = 0;
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) { resolve(deleted); return; }
      cursor.delete();
      deleted++;
      cursor.continue();
    };
    req.onerror = () => reject(new Error(req.error?.message ?? "deleteImportsBefore cursor failed"));
  });
}
