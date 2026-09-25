// modules/cx/lib/store.js
//
// Comment history for one store, in chrome.storage.local.
//
// A 52-week window is about 8,000 records for a single store. Stored in the
// compact shape lib/medallia.js::normalizeRecord produces, that is a few MB —
// fine given the suite's top-level manifest holds `unlimitedStorage`, but only
// if the fat is dropped rather than the API response being kept verbatim (the
// raw 52-week payload is 5.7 MB of JSON before any of it is needed).
//
// Records are held as one array under one key. That is a deliberate trade: a
// per-day sharding scheme would make writes cheaper but every read here wants
// the whole window anyway (the movement comparison spans two months, the weekly
// bars span the year), so sharding would only add a fan-in.
//
// NOTE: no host.storage in this file. It is imported by service.js and so runs
// in the service worker, where `host` does not exist — see
// docs/AI_CONTEXT_BRIEF.md section 2.

const KEY = {
  comments: "cx.comments.v1",     // { storeNbr, records[], from, to, pulledAt, total }
  scores:   "cx.scores.v1",       // { storeNbr, nps, subscores, genAi, pulledAt }
  prefs:    "cx.prefs.v1",        // chip selection + view state
  settings: "cx.settings.v1",     // gateway token, model, window length
  narrative:"cx.narrative.v1",    // last AI read, keyed by the filters it described
  lastRun:  "cx.lastRun.v1",      // outcome of the last pull, including failures
};

export const STORAGE_KEYS = KEY;

/** Schema version of the stored record shape. A bump forces a full re-pull. */
export const RECORD_SCHEMA = 1;

export const DEFAULT_SETTINGS = Object.freeze({
  // 52 weeks. Chosen so the year-over-year comparison Hoops shows on NPS has a
  // matching year of comments underneath it.
  windowWeeks: 52,
  // Walmart AI gateway. Empty until the user pastes their Code Puppy token in
  // Settings — the extension cannot read ~/.code_puppy/puppy.cfg.
  gatewayToken: "",
  gatewayModel: "claude-sonnet-5",
  narrativeEnabled: true,
});

export const DEFAULT_PREFS = Object.freeze({
  journeys: [],       // empty = all
  channels: [],       // empty = all
  windowDays: 28,     // movement comparison span
  openThemes: [],
});

// ── Comments ────────────────────────────────────────────────────────────

export async function readComments() {
  const got = await chrome.storage.local.get(KEY.comments);
  const box = got[KEY.comments];
  if (!box || box.schema !== RECORD_SCHEMA) return null;
  return box;
}

/**
 * Merge a pull into the stored history.
 *
 * Merge rather than replace because an incremental refresh only fetches the
 * newest records; and de-dupe by id because the boundary page of an incremental
 * pull overlaps what is already held by design.
 *
 * `from`/`to` widen monotonically so the panel can state the real coverage of
 * what it is showing rather than the last request's window.
 */
export async function mergeComments(storeNbr, records, { from, to, total = null } = {}) {
  const existing = await readComments();
  const sameStore = existing && String(existing.storeNbr) === String(storeNbr);

  const byId = new Map();
  if (sameStore) for (const r of existing.records) byId.set(r.id, r);
  // New wins on a collision: Medallia can re-tag a comment after the fact
  // (sentiment and topics are applied asynchronously), so the later read is
  // the better one.
  for (const r of records) byId.set(r.id, r);

  const merged = [...byId.values()].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));

  const box = {
    schema:   RECORD_SCHEMA,
    storeNbr: String(storeNbr),
    records:  merged,
    from:     sameStore && existing.from && existing.from < from ? existing.from : from,
    to:       sameStore && existing.to   && existing.to   > to   ? existing.to   : to,
    total,
    pulledAt: Date.now(),
    added:    merged.length - (sameStore ? existing.records.length : 0),
  };
  await chrome.storage.local.set({ [KEY.comments]: box });
  return box;
}

/** Ids already held, for the incremental pull's early stop. */
export async function storedIds() {
  const box = await readComments();
  return new Set(box ? box.records.map((r) => r.id) : []);
}

/** Drop the history — used when the home store changes or the schema bumps. */
export async function clearComments() {
  await chrome.storage.local.remove(KEY.comments);
}

// ── Hoops scores ────────────────────────────────────────────────────────

export async function readScores() {
  const got = await chrome.storage.local.get(KEY.scores);
  return got[KEY.scores] ?? null;
}

export async function writeScores(storeNbr, payload) {
  const box = { storeNbr: String(storeNbr), ...payload, pulledAt: Date.now() };
  await chrome.storage.local.set({ [KEY.scores]: box });
  return box;
}

// ── Settings and prefs ──────────────────────────────────────────────────

export async function readSettings() {
  const got = await chrome.storage.local.get(KEY.settings);
  return { ...DEFAULT_SETTINGS, ...(got[KEY.settings] ?? {}) };
}

export async function writeSettings(patch) {
  const next = { ...(await readSettings()), ...patch };
  await chrome.storage.local.set({ [KEY.settings]: next });
  return next;
}

export async function readPrefs() {
  const got = await chrome.storage.local.get(KEY.prefs);
  return { ...DEFAULT_PREFS, ...(got[KEY.prefs] ?? {}) };
}

export async function writePrefs(patch) {
  const next = { ...(await readPrefs()), ...patch };
  await chrome.storage.local.set({ [KEY.prefs]: next });
  return next;
}

// ── Narrative cache ─────────────────────────────────────────────────────

/**
 * The AI read is cached against a fingerprint of what it described (store,
 * filters, record count, last day). A chip change therefore invalidates it
 * rather than leaving prose about delivery sitting above an in-store-only view.
 */
export async function readNarrative(fingerprint) {
  const got = await chrome.storage.local.get(KEY.narrative);
  const box = got[KEY.narrative];
  if (!box || box.fingerprint !== fingerprint) return null;
  return box;
}

export async function writeNarrative(fingerprint, payload) {
  const box = { fingerprint, ...payload, generatedAt: Date.now() };
  await chrome.storage.local.set({ [KEY.narrative]: box });
  return box;
}

// ── Last-run diagnostics ────────────────────────────────────────────────

export async function readLastRun() {
  const got = await chrome.storage.local.get(KEY.lastRun);
  return got[KEY.lastRun] ?? null;
}

export async function writeLastRun(entry) {
  await chrome.storage.local.set({ [KEY.lastRun]: { ...entry, at: Date.now() } });
}
