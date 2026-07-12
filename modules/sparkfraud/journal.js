// modules/sparkfraud/journal.js
//
// Investigation journal — persistent record of each search the investigator runs.
//
// Migrated from donor extension/journal.js. The ONLY change is the storage
// key namespace: "investigations" → "sparkfraud.investigations" to avoid
// collision with any other module's storage and with the standalone donor
// if both happen to be loaded.
//
// JOURNAL-01 (2026-05-22): operational memory for "did we already investigate
// this register event last week?" use case. Each completed search/lookup
// auto-saves a summary record to chrome.storage.local.sparkfraud.investigations.
//
// Data-safety choice: v0 stores SUMMARY ONLY — search inputs + result counts
// + confidence breakdown. Never persists driver/customer names, order IDs,
// item lists. If the investigator wants the full evidence again, they re-run
// the search with the saved inputs (idempotent against live data; viable
// candidates may differ if a shopper hadn't dispatched yet at original time).
//
// Inspection via DevTools console:
//   import("./journal.js").then(m => m.readInvestigations().then(j => console.table(j.slice(-20))));

const STORAGE_KEY = "sparkfraud.investigations";
const MAX_INVESTIGATIONS = 500;

// Tracks whether a save is in flight to avoid two concurrent searches
// racing (UI button disables prevent this currently, but defensive).
let saveInFlight = null;

function uuid() {
  // Cheap RFC4122-shaped id. Not cryptographic.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// Build an investigation record from search lifecycle data. Caller passes
// pre-extracted fields (no raw trip/order data → no PII reaches this layer).
export function toInvestigationRecord({
  input,                  // {store, date, eventTime, windowMin, services, serviceTypes, lookupMode, replay}
  result,                 // {tripsReturned, totalCompleted, viableCount, dispatcherWindowMin, fetchedBy}
  confidence,             // {verified, likely, possible, unknown, conflicting} counts — optional
  durationMs,             // total search duration
  success,                // bool
} = {}) {
  return {
    id: uuid(),
    savedAtMs: Date.now(),
    input: input || {},
    result: result || {},
    confidence: confidence || null,
    durationMs: durationMs || 0,
    success: !!success,
    outcome: "auto-saved",  // user-editable later via JOURNAL-02 UI
    notes: "",              // user-editable later
  };
}

export async function saveInvestigation(record) {
  // Serialize concurrent saves (defensive — UI button disable already
  // prevents this in practice).
  if (saveInFlight) {
    try { await saveInFlight; } catch (_) {}
  }
  saveInFlight = (async () => {
    try {
      const cur = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] || [];
      cur.push(record);
      if (cur.length > MAX_INVESTIGATIONS) {
        cur.splice(0, cur.length - MAX_INVESTIGATIONS);
      }
      await chrome.storage.local.set({ [STORAGE_KEY]: cur });
    } catch (e) {
      console.warn("[SparkFraud journal] save failed:", e);
    }
  })();
  return saveInFlight;
}

export async function readInvestigations() {
  if (saveInFlight) {
    try { await saveInFlight; } catch (_) {}
  }
  return (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] || [];
}

export async function clearInvestigations() {
  if (saveInFlight) {
    try { await saveInFlight; } catch (_) {}
  }
  await chrome.storage.local.remove(STORAGE_KEY);
}

// Convenience for future JOURNAL-02 — annotate a saved investigation with
// notes/outcome by id. Loads the record, mutates, writes back. Last-writer-
// wins on concurrent mutations.
export async function annotateInvestigation(id, patch = {}) {
  if (saveInFlight) {
    try { await saveInFlight; } catch (_) {}
  }
  const cur = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] || [];
  const idx = cur.findIndex(r => r.id === id);
  if (idx === -1) return false;
  const allowed = ["notes", "outcome"];  // restrict mutable fields
  for (const k of allowed) {
    if (k in patch) cur[idx][k] = patch[k];
  }
  cur[idx].annotatedAtMs = Date.now();
  await chrome.storage.local.set({ [STORAGE_KEY]: cur });
  return true;
}
