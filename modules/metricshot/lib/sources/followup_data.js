// modules/metricshot/lib/sources/followup_data.js
//
// One way to get the two detail sheets behind the follow-up post — Location
// Details and Department Breakout — preferring the copy vizpick's market
// rollup already captured over exporting them again ourselves.
//
// WHY THIS IS ONE FUNCTION AND NOT FOUR
// -------------------------------------
// Before this, capture.js and three separate handlers in service.js each
// called getVizPickFollowUpData() directly. Every one of them opened or reused
// a Tableau tab and replayed the same two crosstab exports — sheets vizpick's
// Today crawl had usually already exported for that very store minutes
// earlier. Four call sites meant four chances for the fallback rules to drift
// apart, which is exactly what happened to the ring data before it was
// centralised in vizpick_snapshot.js.
//
// The order is: vizpick's snapshot (re-capturing that one store if it is past
// the age ceiling, and writing it back so the rollup gains from this
// module's schedule) → the headless replay → whatever the caller had.
// The fallback is PER SHEET: one missing export must not blank the other.

import { getVizpickTodayRowForStore, mapRowToDetailSheets } from "./vizpick_snapshot.js";
import { getVizPickFollowUpData } from "./vizpick_export.js";
import { getUserHomeStore } from "../../../../shared/userStore.js";

// Matches MAX_TODAY_AGE_MS in vizpick's Today source. The current-day data
// republishes every ~2-3 h, so a row younger than this holds the same numbers
// a fresh crawl would return — and paying for a tab to confirm that is the
// duplication this module exists to remove.
export const SNAPSHOT_MAX_AGE_MS = 90 * 60_000;

/**
 * @param {object}  [opts]
 * @param {string|number|null} [opts.store]  Defaults to the user's home store.
 * @param {number}  [opts.tabId]     Passed to the headless replay if it runs.
 * @param {number}  [opts.maxAgeMs]
 * @param {boolean} [opts.allowCapture=true]  false = never open a tab for the
 *   snapshot refresh. The headless fallback may still open one.
 * @returns {Promise<{
 *   ok: boolean, locationDetails: Array, departmentBreakout: Array,
 *   source: {locations: string, departments: string},
 *   snapshot: object|null, replayed: boolean,
 *   errorClass?: string, error?: string,
 * }>}
 */
export async function getFollowUpSheets(opts = {}) {
  const {
    tabId = undefined,
    maxAgeMs = SNAPSHOT_MAX_AGE_MS,
    allowCapture = true,
  } = opts;

  const store = opts.store ?? (await getUserHomeStore().catch(() => null));

  let snapshot = null;
  let sheets = null;
  if (store) {
    snapshot = await getVizpickTodayRowForStore(store, { maxAgeMs, allowCapture }).catch(() => null);
    if (snapshot?.row) sheets = mapRowToDetailSheets(snapshot.row);
  }

  const haveLoc  = !!sheets?.locationDetails?.length;
  const haveDept = !!sheets?.departmentBreakout?.length;

  // Both present — nothing left for the replay to contribute.
  if (haveLoc && haveDept) {
    return {
      ok: true,
      locationDetails: sheets.locationDetails,
      departmentBreakout: sheets.departmentBreakout,
      source: { locations: "vizpick-snapshot", departments: "vizpick-snapshot" },
      snapshot, replayed: false,
      // The replay never ran, so it has no rings to offer. Callers fall back
      // to vizpick's snapshot rings (mapRowToRingData) or render_card's own
      // legacy derivation — both of which are better than these ever were.
      health: null, metrics: [], deptRings: [],
    };
  }

  const replay = await getVizPickFollowUpData(tabId != null ? { tabId } : undefined)
    .catch((e) => ({ ok: false, error: String(e?.message ?? e), errorClass: "THREW" }));

  const locationDetails    = haveLoc  ? sheets.locationDetails    : (replay.locationDetails ?? []);
  const departmentBreakout = haveDept ? sheets.departmentBreakout : (replay.departmentBreakout ?? []);

  // Only a total blank is a failure. A snapshot that supplied one sheet is a
  // usable result even when the replay for the other one failed outright.
  if (!locationDetails.length && !departmentBreakout.length) {
    return {
      ok: false,
      locationDetails: [], departmentBreakout: [],
      source: { locations: "none", departments: "none" },
      snapshot, replayed: true,
      health: null, metrics: [], deptRings: [],
      errorClass: replay.errorClass || "NO_DATA",
      error: replay.error || "no rows from either the vizpick snapshot or the headless export",
    };
  }

  return {
    ok: true,
    locationDetails, departmentBreakout,
    source: {
      locations:   haveLoc  ? "vizpick-snapshot" : "headless-export",
      departments: haveDept ? "vizpick-snapshot" : "headless-export",
    },
    snapshot, replayed: true,
    // Passed through rather than dropped: the replay has never actually
    // resolved these sheets (see vizpick_export.js::_resolveSheetIds), but if
    // it ever starts working the caller should get them without a second call.
    health: replay.health ?? null,
    metrics: replay.metrics ?? [],
    deptRings: replay.deptRings ?? [],
  };
}
