// modules/vizpick/lib/day_details.js
//
// Each store's department and associate detail as it stood at the LAST
// current-day capture of a day, so the closed-day tabs can show it.
//
// WHY THIS EXISTS
// ---------------
// A closed day is the "Download Summary by Store" crosstab, which has no
// department or location dimension. The Today snapshot does, but it is
// replaced on every capture, so once the day rolled its breakdown was gone and
// the day tabs could only say "current-day only". This keeps one slim detail
// record per store per day; a later capture of the same day replaces it, so
// what survives is the day's last reading.
//
// A row is filed under the local day of its OWN Tableau stamp (stores publish
// on their own clocks), not the day it was read: a 1 AM check that still reads
// an 8:02 PM stamp belongs to the day before.
//
// Storage: one key per day, so a Today write rewrites one day, not the archive.
//   chrome.storage.local["vizpick.dayDetails.v1.index"] = ["YYYY-MM-DD", ...]
//   chrome.storage.local["vizpick.dayDetails.v1.<day>"]  = { [store]: detail }
//   detail = { store, sourceUpdate, stampVia, capturedAt, depts, deptCount,
//              deptGroups, locations: { gaps, byLocGroup, locationCount } }
// The home store's per-bin list is NOT copied here; lib/home_history.js keeps
// it per update. Days older than MAX_DAYS are dropped.

import * as homeHistory from "./home_history.js";
import { withholdDuplicateLocations } from "./today_coverage.js";

export const PREFIX = "vizpick.dayDetails.v1";
export const INDEX_KEY = `${PREFIX}.index`;
export const MAX_DAYS = 14;
export const dayKeyOf = (day) => `${PREFIX}.${day}`;

const stampTime = (d) => {
  const t = Date.parse(d?.sourceUpdate?.iso || d?.capturedAt || "");
  return Number.isFinite(t) ? t : 0;
};
const hasDepts = (d) => Array.isArray(d?.depts) && d.depts.length > 0;
const hasGaps = (d) => Array.isArray(d?.locations?.gaps);
const score = (d) => (hasDepts(d) ? 1 : 0) + (hasGaps(d) ? 1 : 0);

/**
 * Slim detail record for one Today row, or null when the row carries neither
 * a department breakout nor location detail. `meta.sourceUpdate` stands in for
 * rows written before per-store stamps (2026-09-15).
 */
export function detailFromRow(row, meta = {}) {
  if (!row?.store) return null;
  const stamp = row.sourceUpdate?.raw ? row.sourceUpdate : (meta.sourceUpdate ?? null);
  const loc = row.locations;
  const detail = {
    store: String(row.store),
    sourceUpdate: stamp || null,
    stampVia: row.sourceUpdate?.raw ? (row.stampVia || "row") : (stamp?.raw ? "crawl" : null),
    capturedAt: row.capturedAt || meta.capturedAt || null,
    depts: Array.isArray(row.depts) ? row.depts : null,
    deptCount: row.deptCount ?? null,
    deptGroups: Array.isArray(row.deptGroups) ? row.deptGroups : null,
    locations: Array.isArray(loc?.gaps)
      ? { gaps: loc.gaps, byLocGroup: loc.byLocGroup ?? null, locationCount: loc.locationCount ?? null }
      : null,
  };
  return score(detail) ? detail : null;
}

/** Local day a detail describes: its Tableau stamp's, else the capture's. */
export function dayOfDetail(detail) {
  return homeHistory.localDayKey(detail?.sourceUpdate?.iso || detail?.capturedAt);
}

/**
 * Pure: which of two details of one store and day stands. A later stamp wins
 * unless it lost a section the kept one has (a failed export must not erase
 * the day's associate list); the same stamp merges section by section.
 */
export function pickDetail(old, next) {
  if (!old) return next;
  if (!next) return old;
  const a = stampTime(old), b = stampTime(next);
  if (a === b) {
    // The crawl re-writes unchanged rows several times a run; the same reading
    // again must not cost a storage write.
    const merged = {
      ...old, ...next,
      depts: hasDepts(next) ? next.depts : old.depts,
      deptCount: hasDepts(next) ? next.deptCount : old.deptCount,
      deptGroups: next.deptGroups ?? old.deptGroups,
      locations: hasGaps(next) ? next.locations : old.locations,
    };
    const sig = (d) => JSON.stringify([d.depts ?? null, d.locations?.gaps ?? null]);
    return sig(merged) === sig(old) ? old : merged;
  }
  const [older, newer] = a < b ? [old, next] : [next, old];
  return score(newer) >= score(older) ? newer : older;
}

/**
 * Pure: fold Today rows into `{ [day]: { [store]: detail } }`. Rows whose
 * location detail duplicates another row's are a wrong-store capture
 * (today_coverage.js) and keep their departments only.
 */
export function foldRows(days, rows, meta = {}) {
  const out = { ...(days || {}) };
  const touched = new Set();
  for (const row of withholdDuplicateLocations(rows || [])) {
    const detail = detailFromRow(row, meta);
    const day = detail && dayOfDetail(detail);
    if (!day) continue;
    const kept = out[day]?.[detail.store];
    const picked = pickDetail(kept, detail);
    if (picked === kept) continue;
    out[day] = { ...(out[day] || {}), [detail.store]: picked };
    touched.add(day);
  }
  return { days: out, touched: [...touched] };
}

/**
 * Pure: a detail record from a home-history entry — covers the home store for
 * days kept before this archive existed. Picks and cases are rebuilt from the
 * entry's bins and department rows; percentages are computed, not Tableau's.
 */
export function detailFromHistoryEntry(entry) {
  if (!entry?.store) return null;
  const pct = (n, d) => (d > 0 ? (n / d) * 100 : null);
  const depts = Array.isArray(entry.depts)
    ? entry.depts.map((d) => ({
        dept: d.dept,
        suggestedPicks: d.suggested, suggestedPicksCompleted: d.done, pickPct: pct(d.done, d.suggested),
        casesSeen: d.casesSeen, casesExpected: d.casesExpected, casesSeenPct: pct(d.casesSeen, d.casesExpected),
      }))
    : null;
  const gaps = (entry.bins || [])
    .filter((b) => (b.seen || 0) > (b.done || 0))
    .map((b) => ({
      locGroup: String(parseInt(String(b.location).split("/")[0], 10)),
      location: b.location, picksSeen: b.seen, picksDone: b.done, skipped: b.seen - b.done,
      win: b.win || null, lastSeenAt: b.lastSeenAt || null,
    }));
  return {
    store: String(entry.store),
    sourceUpdate: entry.sourceIso || entry.sourceKey
      ? { raw: entry.sourceKey ?? null, iso: entry.sourceIso ?? null, hasTime: true } : null,
    stampVia: entry.stampVia ?? null,
    capturedAt: entry.capturedAt || null,
    depts, deptCount: depts?.length ?? null, deptGroups: null,
    locations: { gaps, byLocGroup: null, locationCount: (entry.bins || []).length },
    fromHistory: true,
  };
}

/**
 * Pure: `{ [day]: { [store]: detail } }` from a home history — per day, each
 * store's last trustworthy entry (cleanDay drops foreign captures and orders
 * by Tableau data time). History days are keyed by CAPTURE day; entries are
 * regrouped by their stamp's day to match the archive.
 */
export function lastHistoryDetails(history) {
  const byDay = {};
  for (const list of Object.values(history?.days || {})) {
    for (const e of list || []) {
      const day = homeHistory.localDayKey(e.sourceIso || e.capturedAt);
      // Per store as well: cleanDay judges "foreign" against one bin list.
      if (day) ((byDay[day] ??= {})[String(e.store)] ??= []).push(e);
    }
  }
  const out = {};
  for (const [day, stores] of Object.entries(byDay)) {
    for (const [store, entries] of Object.entries(stores)) {
      const last = homeHistory.cleanDay(entries).entries.at(-1);
      if (last) (out[day] ??= {})[store] = detailFromHistoryEntry(last);
    }
  }
  return out;
}

let queue = Promise.resolve();

/** Fold Today rows into the archive. Never throws: it is a side record. */
export function recordFromRows(rows, meta) {
  const run = async () => {
    try {
      const details = (rows || []).map((r) => detailFromRow(r, meta)).filter(Boolean);
      const wanted = [...new Set(details.map(dayOfDetail).filter(Boolean))];
      if (!wanted.length) return { touched: [] };
      const got = await chrome.storage.local.get([INDEX_KEY, ...wanted.map(dayKeyOf)]);
      const stored = Object.fromEntries(wanted.map((d) => [d, got[dayKeyOf(d)] || {}]));
      const { days, touched } = foldRows(stored, rows, meta);
      if (!touched.length) return { touched };
      const index = [...new Set([...(got[INDEX_KEY] || []), ...touched])].sort().reverse();
      const drop = index.slice(MAX_DAYS);
      await chrome.storage.local.set({
        [INDEX_KEY]: index.slice(0, MAX_DAYS),
        ...Object.fromEntries(touched.filter((d) => !drop.includes(d)).map((d) => [dayKeyOf(d), days[d]])),
      });
      if (drop.length) await chrome.storage.local.remove(drop.map(dayKeyOf));
      return { touched };
    } catch (e) {
      return { touched: [], error: String(e?.message ?? e) };
    }
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

/**
 * `{ [day]: { [store]: detail } }` for the asked days. A store the archive
 * lacks for a day falls back to the home-store history's last entry.
 */
export async function read(dayList) {
  const wanted = [...new Set((dayList || []).filter(Boolean))];
  if (!wanted.length) return {};
  const [got, history] = await Promise.all([
    chrome.storage.local.get(wanted.map(dayKeyOf)),
    homeHistory.read().catch(() => null),
  ]);
  const fromHistory = lastHistoryDetails(history);
  const out = {};
  for (const day of wanted) {
    const merged = { ...(fromHistory[day] || {}), ...(got[dayKeyOf(day)] || {}) };
    if (Object.keys(merged).length) out[day] = merged;
  }
  return out;
}
