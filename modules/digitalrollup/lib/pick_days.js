// modules/digitalrollup/lib/pick_days.js
//
// The per-day archive behind Digital Metrics' "Pick Hours" tab: one record per
// store per board day, holding what lib/pick_history.js::hourlyBars derived
// from that day's samples — items picked in each clock hour, the day total,
// the average — so the picks-per-hour graph survives the day it was drawn on.
//
// Why a separate archive rather than keeping the samples: the rolling series
// (`digitalrollup.pickHistory.v1`) is deliberately one day deep. It restarts
// when the board's report day changes and per store when the running total
// drops, because the rolling hour would go negative across a reset. Neither
// event should take yesterday's graph with it. The hourly bars are also two
// orders of magnitude smaller than the samples behind them: 24 entries a day
// instead of ~300, so four months of days is still under 100 KB.
//
// Every pull upserts today's record from the whole day's samples, so the last
// write of a day is its final shape and nothing has to notice midnight. The
// merge below is what makes a mid-day reset harmless: hours already measured
// are kept, and a "before recording" stretch never overwrites them.
//
// Home store only (the series only tracks that store). Pure: no chrome.*, so
// it runs under node --test. Stored raw under PICK_DAYS_KEY in
// chrome.storage.local; Digital Metrics reads that key through its own SW
// handler (service.js::get_pick_days), the one cross-module read.

export const PICK_DAYS_KEY = "digitalrollup.pickDays.v1";

// Days kept per store, newest first. Four months covers a quarter's
// comparisons; older days are dropped on write.
export const MAX_DAYS_PER_STORE = 120;

const pad = (n) => String(n).padStart(2, "0");

/**
 * The board day a moment belongs to, as a local "YYYY-MM-DD". Keyed on the
 * day START (5 AM local per dayStartFrom), not the calendar date of the
 * reading — a 2 AM reading belongs to the previous day's board.
 */
export function dayKeyFor(dayStartMs) {
  const d = new Date(dayStartMs);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Numeric store string ("01458" → "1458"), or null when it is not a store. */
export function storeKey(store) {
  const n = Number(store);
  return Number.isFinite(n) && n > 0 ? String(n) : null;
}

/**
 * Fold a fresh day computation into the record already stored for that day.
 *
 *  · Hours are keyed by their start. A measured hour ("hour") beats a partial
 *    one ("now"); two partials keep the later reading.
 *  · The "before recording" block is kept from the first record that had
 *    hours. A later computation whose series restarted mid-day (source reset)
 *    would otherwise present the already-measured morning as one averaged
 *    block — the shape the muted bar exists to avoid inventing.
 *  · Totals and the day average come from whichever reading is later, since
 *    the running total only climbs within a day.
 */
export function mergeDay(prev, next) {
  if (!next) return prev ?? null;
  if (!prev) return { ...next, hours: (next.hours || []).slice() };
  const later = (next.asOf ?? 0) >= (prev.asOf ?? 0) ? next : prev;

  const byStart = new Map();
  for (const h of prev.hours || []) byStart.set(h.start, h);
  for (const h of next.hours || []) {
    const cur = byStart.get(h.start);
    if (!cur) { byStart.set(h.start, h); continue; }
    if (cur.kind === "hour" && h.kind !== "hour") continue;
    if (cur.kind === h.kind && (cur.end ?? 0) > (h.end ?? 0)) continue;
    byStart.set(h.start, h);
  }
  const hours = [...byStart.values()].sort((a, b) => a.start - b.start);

  const prevHadHours = (prev.hours || []).length > 0;
  const before = prevHadHours ? (prev.before ?? null) : (next.before ?? prev.before ?? null);

  return {
    ...prev,
    ...later,
    dayStart: prev.dayStart ?? next.dayStart,
    before,
    hours,
    asOf: Math.max(prev.asOf ?? 0, next.asOf ?? 0),
    total: Math.max(prev.total ?? 0, next.total ?? 0),
    samples: Math.max(prev.samples ?? 0, next.samples ?? 0),
  };
}

/**
 * Upsert one store-day. Returns a NEW archive.
 *
 * Archive shape: { v:1, days: { [store]: { [dayKey]: record } } }
 * Record: { dayStart, asOf, total, dayAvgPerHour, before, hours,
 *           market, reportDate, samples, updatedAt }
 *
 * @param {object|null} archive   the stored archive (or null on first write)
 * @param {object} o
 * @param {string|number} o.store
 * @param {ReturnType<import("./pick_history.js").hourlyBars>} o.day
 * @param {string} [o.market]      the board market the store was read under
 * @param {string} [o.reportDate]  the board's own report_date, for the record
 * @param {number} [o.samples]     readings behind the computation (diagnostic)
 * @param {number} [o.now]         write stamp; defaults to Date.now()
 */
export function upsertDay(archive, { store, day, market = "", reportDate = null, samples = 0, now = Date.now() }) {
  const s = storeKey(store);
  if (!s || !day || !Number.isFinite(day.dayStart)) return archive ?? { v: 1, days: {} };
  if (!(day.hours?.length) && !day.before) return archive ?? { v: 1, days: {} };

  const key = dayKeyFor(day.dayStart);
  const base = archive && archive.v === 1 && archive.days ? archive : { v: 1, days: {} };
  const forStore = { ...(base.days[s] || {}) };
  const next = {
    dayStart: day.dayStart,
    asOf: day.asOf,
    total: day.total,
    dayAvgPerHour: day.dayAvgPerHour,
    before: day.before ?? null,
    hours: (day.hours || []).map((h) => ({ start: h.start, end: h.end, picked: h.picked, kind: h.kind })),
    market: String(market ?? ""),
    reportDate: reportDate ?? null,
    samples,
  };
  forStore[key] = { ...mergeDay(forStore[key] ?? null, next), updatedAt: now };

  // Prune oldest beyond the cap. Keys are ISO dates, so string order is time order.
  const keys = Object.keys(forStore).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_DAYS_PER_STORE))) delete forStore[k];

  return { v: 1, days: { ...base.days, [s]: forStore } };
}

/**
 * The archived days for one store, newest first, each with its key and a
 * `closed` flag: true once a later day has been recorded for that store, or
 * when `today` (a day key) is past it. An open day is still being written.
 */
export function listDays(archive, store, { today = null } = {}) {
  const s = storeKey(store);
  const forStore = (s && archive?.v === 1 && archive.days?.[s]) || {};
  const keys = Object.keys(forStore).sort().reverse();
  const newest = keys[0] ?? null;
  return keys.map((key) => ({
    key,
    ...forStore[key],
    closed: key !== newest || (today != null && key < today),
  }));
}

/**
 * Per-hour view of one record for a table: Map(hourOfDay → picked) over the
 * measured hours only. The "before recording" stretch is not spread over its
 * hours (that would be the invented shape again); the caller shows it as a
 * span with its average.
 */
export function hoursByClock(record) {
  const out = new Map();
  for (const h of record?.hours || []) out.set(new Date(h.start).getHours(), h);
  return out;
}

/** The hour with the most picks in a record, or null. Partial hours count too. */
export function peakHour(record) {
  let best = null;
  for (const h of record?.hours || []) if (!best || h.picked > best.picked) best = h;
  return best;
}
