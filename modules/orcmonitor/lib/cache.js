// modules/orcmonitor/lib/cache.js
//
// Local copy of what we have already pulled from Auror, so a run only fetches
// what is new. IndexedDB (same extension origin for the SW and the view).
//
//   events   { id, persons:[pid], occurredAt, siteNum, region, fetchedAt }
//            One EventProfile call each. Re-fetched while the event is young
//            (people get linked to an event days after it is filed).
//   persons  { id, profile, feed, eventIds:[eid], fetchedAt, lastUsedAt }
//            PersonProfile + ProfileFeed, slimmed to the fields the module
//            reads. Re-fetched when the person has an event the saved feed
//            does not know, or the copy is older than PERSON_TTL.
//   results  { key:"<store>|<days>", savedAt, result }
//            The last analysis per store+lookback, for instant display.
//   reports  { key:"latest", savedAt, data }
//            The PDF brief payload (view → report.html).
//
// Records nobody has used for PRUNE_DAYS are dropped at the end of each run.

const DB_NAME = "apaisuite-orcmonitor";
const DB_VERSION = 2;       // v2: + reports

export const EVENT_YOUNG_DAYS   = 7;           // re-check persons on events this recent…
export const EVENT_RECHECK_MS   = 86400000;    // …at most once a day
export const PERSON_TTL_MS      = 7 * 86400000;
const PRUNE_DAYS = 180;

let _db = null;
function db() {
  if (_db) return _db;
  _db = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains("events"))  d.createObjectStore("events",  { keyPath: "id" });
      if (!d.objectStoreNames.contains("persons")) d.createObjectStore("persons", { keyPath: "id" });
      if (!d.objectStoreNames.contains("results")) d.createObjectStore("results", { keyPath: "key" });
      if (!d.objectStoreNames.contains("reports")) d.createObjectStore("reports", { keyPath: "key" });
    };
    req.onsuccess = () => {
      const d = req.result;
      // Let a newer version (after an extension update) take over instead of blocking it.
      d.onversionchange = () => { d.close(); _db = null; };
      resolve(d);
    };
    req.onerror = () => { _db = null; reject(new Error(`orcmonitor IndexedDB: ${req.error?.message ?? "open failed"}`)); };
    req.onblocked = () => console.warn("[orcmonitor] IndexedDB upgrade waiting for another suite tab to close its old connection");
  });
  return _db;
}

const done = req => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

async function getMany(store, ids) {
  const d = await db();
  const tx = d.transaction(store, "readonly");
  const os = tx.objectStore(store);
  const out = new Map();
  await Promise.all(ids.map(id => done(os.get(String(id))).then(v => { if (v) out.set(String(id), v); })));
  return out;
}
async function putMany(store, rows) {
  if (!rows.length) return;
  const d = await db();
  const tx = d.transaction(store, "readwrite");
  const os = tx.objectStore(store);
  for (const r of rows) os.put(r);
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
}
async function count(store) {
  const d = await db();
  return done(d.transaction(store, "readonly").objectStore(store).count());
}

export const getEvents  = ids => getMany("events", ids);
export const putEvents  = rows => putMany("events", rows);
export const getPersons = ids => getMany("persons", ids);
export const putPersons = rows => putMany("persons", rows);
export async function stats() {
  return { events: await count("events").catch(() => 0), persons: await count("persons").catch(() => 0) };
}

export async function saveResult(store, days, result) {
  await putMany("results", [{ key: `${Number(store)}|${days}`, savedAt: Date.now(), result }]);
}
/** Last saved result for this store: the same lookback if we have it, else any. */
export async function loadResult(store, days) {
  const d = await db();
  const os = d.transaction("results", "readonly").objectStore("results");
  const exact = await done(os.get(`${Number(store)}|${days}`));
  if (exact) return exact;
  const all = await done(os.getAll());
  return all.filter(r => r.key.startsWith(`${Number(store)}|`)).sort((a, b) => b.savedAt - a.savedAt)[0] ?? null;
}

// The PDF brief's payload, handed from the view to report.html. It used to go
// through chrome.storage.session, whose 10 MB quota a map image plus a dozen
// photos can exceed — the write failed and the report never opened.
export async function saveReport(data) {
  await putMany("reports", [{ key: "latest", savedAt: Date.now(), data }]);
}
export async function loadReport() {
  const d = await db();
  return (await done(d.transaction("reports", "readonly").objectStore("reports").get("latest")))?.data ?? null;
}

/** Wipe everything (the view's "Full refresh" does not need this; it re-fetches over the top). */
export async function clearAll() {
  const d = await db();
  const tx = d.transaction(["events", "persons", "results"], "readwrite");
  for (const s of ["events", "persons", "results"]) tx.objectStore(s).clear();
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
}

/** Drop events that occurred, and persons last used, more than PRUNE_DAYS ago. */
export async function prune() {
  const cutoff = Date.now() - PRUNE_DAYS * 86400000;
  const d = await db();
  const tx = d.transaction(["events", "persons"], "readwrite");
  let removed = 0;
  const sweep = (name, isOld) => new Promise(res => {
    const req = tx.objectStore(name).openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return res();
      if (isOld(c.value)) { c.delete(); removed++; }
      c.continue();
    };
    req.onerror = () => res();
  });
  await sweep("events",  e => Date.parse(e.occurredAt ?? 0) < cutoff && (e.fetchedAt ?? 0) < cutoff);
  await sweep("persons", p => (p.lastUsedAt ?? p.fetchedAt ?? 0) < cutoff);
  await new Promise(res => { tx.oncomplete = res; tx.onerror = res; });
  return removed;
}

// ── Slimming: keep only what trajectory.js / the service read ────────────────

const PROFILE_KEYS = ["heroCardView", "personDetailsCardView", "appearanceCardView", "personLocationCardView",
  "locationCount", "trespasses", "heatmapData", "eventTypeCount", "productCount",
  "associatedVehicles", "associatedPersons"];

export function slimProfile(p) {
  const out = {};
  for (const k of PROFILE_KEYS) if (p?.[k] !== undefined) out[k] = p[k];
  return out;
}

const FEED_PROPS = ["SiteName", "LocalOccurredAt", "OccurredAt", "EventType", "TotalValue"];
export function slimFeed(f) {
  const items = [];
  for (const g of f?.groups ?? []) for (const it of g.items ?? []) {
    if (it.activityType !== "EventCreated") continue;
    const pb = {};
    for (const k of FEED_PROPS) if (it.propsBag?.[k] !== undefined) pb[k] = it.propsBag[k];
    items.push({ activityType: it.activityType, objectId: it.objectId, propsBag: pb });
  }
  return { groups: [{ items }] };
}

export function feedEventIds(slim) {
  return (slim?.groups ?? []).flatMap(g => (g.items ?? []).map(i => String(i.objectId ?? "").replace(/^e/, ""))).filter(Boolean);
}
