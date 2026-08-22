// modules/metricshot/lib/sources/vizpick_snapshot.js
//
// Read a single store's current-day VizPick numbers out of the vizpick
// module's OWN storage, instead of capturing them ourselves. vizpick's Today
// capture (../../vizpick/lib/sources/vizpick_today_tableau.js) drives the
// real Download UI and reliably gets the "VizPick Donut Health" sheet;
// MetricShot's own headless replay (./vizpick_export.js) has never been able
// to resolve that sheet's id (see its _resolveSheetIds() note) and so always
// rendered the health ring and the four goal rings blank. Reusing the market
// rollup's own capture sidesteps that — at the cost of the numbers being only
// as fresh as VizPick's last Today crawl for this store.
//
// Fresh/F&C/GM (the department-group rings) are NOT captured from Tableau at
// all — there is no reliable sheetdocId for "Department Groups Donuts
// Health" either (same _resolveSheetIds() problem), and adding a third
// UI-driven export to VizPick's Today crawl was tried and reverted: it cost
// every store an extra ~5-8s of Tableau round-trip for data this file can
// derive for free from the per-department breakout VizPick's Today crawl
// ALREADY captures (row.depts). So Fresh/F&C/GM are computed locally here by
// bucketing that same department list — see computeDeptGroupRings() below.
//
// NOT read-only any more (changed 2026-08-22). getVizpickTodayRowForStore()
// now goes through vizpick's ensureTodayRowForStore(), which re-captures the
// ONE store when the stored row is past its age ceiling and writes it back.
// That is the point: metricshot used to open its own Tableau tab and re-export
// Location Details + Department Breakout — the same two sheets vizpick's Today
// crawl already exports for every store in the market — so the same rows were
// pulled twice by two sessions that could disagree about what "now" meant.
// Pass { allowCapture: false } for the old read-only behaviour.
//
// If nothing is stored and the capture fails, the caller still falls back to
// whatever it already had.

import { ensureTodayRowForStore } from "../../../vizpick/lib/ensure_today_store.js";

/**
 * @param {string|number} store
 * @returns {Promise<{row:object, capturedAt:string|null, sourceUpdate:object|null}|null>}
 *   null when VizPick has no Today row on file for this store.
 */
export async function getVizpickTodayRowForStore(store, opts = {}) {
  const wanted = String(store ?? "").trim();
  if (!wanted) return null;

  // Ask vizpick for a CURRENT row rather than whatever it last happened to
  // store. When the stored one is recent enough this is a storage read and no
  // tab is opened at all; when it is stale, one store is re-captured and
  // written back, so the rollup gets the benefit of metricshot's schedule
  // instead of the two modules crawling the same store independently.
  //
  // allowCapture:false is the old read-only behaviour, for callers that must
  // never open a tab.
  const res = await ensureTodayRowForStore(wanted, opts);
  if (!res?.row) return null;
  return {
    row: res.row,
    capturedAt: res.capturedAt ?? null,
    sourceUpdate: res.sourceUpdate ?? null,
    refreshed: !!res.refreshed,
    ageMs: res.ageMs,
    reason: res.reason,
  };
}

// Same goal thresholds as parse_vizpick_export.js::mapDonutHealth — the
// dashboard doesn't carry goals in the export, so they're hard-coded there
// too. Duplicated rather than imported: that file's copy is private to its
// own (headless-export) sourcing path, and the two are allowed to diverge if
// the dashboard's goals ever change per-source.
const DONUT_GOALS = { cases: 95, locations: 95, picks: 90, overstock: 90 };

// ── Department → group mapping ──────────────────────────────────────────
//
// Walmart's own merchandising department numbers, confirmed 2026-08-22.
// Fresh = the perishable/prepared-food departments; F&C = the
// consumables/health-and-beauty departments Tableau's own dashboard groups
// separately from Fresh; everything else is GM (General Merchandise) —
// intentionally a catch-all, not a guess, since that's what GM means in
// Walmart's own taxonomy. Numbers are compared as strings (row.depts[].dept
// is a bare numeric string, e.g. "80", never zero-padded).
const FRESH_DEPTS = new Set(["80", "81", "83", "93", "94", "97", "98"]);
const FC_DEPTS    = new Set(["2", "4", "8", "13", "40", "46", "79", "90", "91", "92", "95"]);

function classifyDept(deptNum) {
  const d = String(deptNum ?? "").trim();
  if (FRESH_DEPTS.has(d)) return "Fresh";
  if (FC_DEPTS.has(d)) return "F&C";
  return "GM";
}

/**
 * Fresh/F&C/GM scores, computed from the per-department breakout rows
 * VizPick's Today capture already stores (row.depts). Tableau's own group
 * score blends four metrics (Cases, Location, Pick, Overstock %); the
 * breakout only carries two of those per department (Cases Seen %, Pick %),
 * so the group score here is those two only — real numerator/denominator
 * sums across each group's departments, not an average of the already-
 * rounded per-department percentages, then averaged into one score per
 * group. Not Tableau's own number, but built from the same underlying data
 * and the closest approximation available without a third Tableau export.
 *
 * @param {Array<object>} depts  row.depts from vizpick_today_tableau.js
 * @returns {Array<{label:string,value:number|null}>|null}
 *   null when there's no department data to bucket at all (e.g. an older
 *   stored row captured before `depts` was added to the snapshot).
 */
function computeDeptGroupRings(depts) {
  if (!Array.isArray(depts) || !depts.length) return null;

  const totals = {
    Fresh: { casesSeen: 0, casesExpected: 0, picksDone: 0, picksTotal: 0 },
    "F&C": { casesSeen: 0, casesExpected: 0, picksDone: 0, picksTotal: 0 },
    GM:    { casesSeen: 0, casesExpected: 0, picksDone: 0, picksTotal: 0 },
  };
  for (const d of depts) {
    const t = totals[classifyDept(d?.dept)];
    if (Number.isFinite(d?.casesSeen))               t.casesSeen     += d.casesSeen;
    if (Number.isFinite(d?.casesExpected))            t.casesExpected += d.casesExpected;
    if (Number.isFinite(d?.suggestedPicksCompleted))  t.picksDone     += d.suggestedPicksCompleted;
    if (Number.isFinite(d?.suggestedPicks))           t.picksTotal    += d.suggestedPicks;
  }

  return ["Fresh", "F&C", "GM"].map((label) => {
    const t = totals[label];
    const casesPct = t.casesExpected > 0 ? (t.casesSeen / t.casesExpected) * 100 : null;
    const pickPct  = t.picksTotal > 0 ? (t.picksDone / t.picksTotal) * 100 : null;
    const parts = [casesPct, pickPct].filter(Number.isFinite);
    const value = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null;
    return { label, value };
  });
}

/**
 * Reshape a vizpick Today row into the two detail sheets format_message.js
 * wants — the sheets metricshot used to open its own Tableau tab to re-export.
 *
 * Returns `null` per field when that export was not captured, so the caller
 * can fall back per sheet rather than one gap blanking both.
 *
 * @param {object} row
 * @param {number} [now]  Injected for tests; staleness is relative to NOW, not
 *   to capture time — a snapshot two hours old makes every bin two hours
 *   staler, and computing hours at capture time would freeze them.
 * @returns {{locationDetails:Array|null, departmentBreakout:Array|null}}
 */
export function mapRowToDetailSheets(row, now = Date.now()) {
  const out = { locationDetails: null, departmentBreakout: null };
  if (!row) return out;

  // ── Department breakout ──
  // `dept` and `pickPct` are what _buildDeptsSection reads; the rest is
  // carried so render_card's legacy derivation still resolves if the rings
  // are ever missing.
  if (Array.isArray(row.depts) && row.depts.length) {
    out.departmentBreakout = row.depts.map((d) => ({
      dept: String(d?.dept ?? "").trim(),
      pickPct: Number.isFinite(d?.pickPct) ? d.pickPct : null,
      totalPicked: Number.isFinite(d?.suggestedPicksCompleted) ? d.suggestedPicksCompleted : null,
      casesSeen: Number.isFinite(d?.casesSeen) ? d.casesSeen : null,
      casesExpected: Number.isFinite(d?.casesExpected) ? d.casesExpected : null,
    })).filter((d) => d.dept);
  }

  // ── Location details ──
  // Two sources, and the difference matters. `scans` is every scanned bin,
  // which is what the "Un-scanned locations" section has always ranked; it is
  // kept only for the user's own store (see parse_vizpick_stores_csv.js
  // ::parseLocationDetails). `gaps` is the narrower set — bins that still have
  // picks outstanding — captured for every store. Preferring scans keeps the
  // post identical for the home store while any other store still gets a
  // usable, slightly narrower list instead of nothing.
  const scans = Array.isArray(row.locations?.scans) ? row.locations.scans : null;
  const gaps  = Array.isArray(row.locations?.gaps)  ? row.locations.gaps  : null;
  const src = scans?.length ? scans : gaps;
  if (src?.length) {
    out.locationDetails = src.map((g) => ({
      location: String(g?.location ?? "").trim(),
      hoursSinceLastScan: _hoursSince(g?.lastSeenAt, now),
      // Not captured per location by vizpick's parse — the department rollup
      // covers Cases Seen %, so it was never worth a column. null rather than
      // 0: _buildBinsSection ignores it, and a fake zero would read as real.
      casesSeenPct: null,
      pickedTotal: Number.isFinite(g?.picksDone) ? g.picksDone : null,
      status: null,
    })).filter((r) => r.location);
  }

  return out;
}

/**
 * "8/22/2026 6:12:55 AM" → hours before `now`, or null.
 *
 * Tableau writes these in the viewer's own locale with no zone, so they are
 * parsed as local time — which is right, because the browser reading them is
 * in the store's timezone. A value that will not parse yields null rather
 * than a guess: _buildBinsSection drops non-finite hours, so an unparseable
 * timestamp quietly omits that bin instead of ranking it wrongly.
 */
function _hoursSince(ts, now) {
  if (!ts) return null;
  const t = new Date(String(ts).trim()).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (now - t) / 3_600_000);
}

/**
 * Reshape a vizpick Today row (see vizpick/lib/sources/vizpick_today_tableau.js
 * ::captureStore) into the { health, metrics, deptRings } shape
 * lib/render_card.js wants.
 *
 * health/metrics and deptRings come from independent sources — health/metrics
 * from the donut-health export (`row.hasHealth` gates it; that export can
 * fail on its own), deptRings computed locally from `row.depts` (see
 * computeDeptGroupRings above). Each piece is `null` (not an empty
 * array/number) when unavailable, letting the caller fall back to its own
 * source PER FIELD rather than one missing piece blanking the others.
 *
 * @param {object} row
 * @returns {{health:number|null, metrics:Array|null, deptRings:Array|null}}
 */
export function mapRowToRingData(row) {
  const out = { health: null, metrics: null, deptRings: null };
  if (!row) return out;
  const n = (v) => (Number.isFinite(v) ? v : null);

  if (row.hasHealth) {
    out.health = n(row.vizpick);
    out.metrics = [
      { label: "Cases",     value: n(row.casesSeenPct), goal: DONUT_GOALS.cases },
      { label: "Locations", value: n(row.locationPct),  goal: DONUT_GOALS.locations },
      { label: "Picks",     value: n(row.pickPct),      goal: DONUT_GOALS.picks },
      { label: "Overstock", value: n(row.overstockPct), goal: DONUT_GOALS.overstock },
    ];
  }
  // Prefer Tableau's OWN group scores when the capture got them.
  //
  // computeDeptGroupRings() is a two-metric proxy: the department breakout has
  // no Location or Overstock per department, and Tableau weights those at 30%
  // of the score. On store 1, same moment, the proxy read 57.9/8.2/0.05 where
  // Tableau showed 66/28/20 — low enough to read as a failing store rather
  // than a different formula.
  //
  // Kept as the fallback rather than deleted: the third export is soft, so a
  // store whose group sheet failed still gets approximate wheels instead of
  // blank ones. `deptGroups` is null (not []) when it was not captured, which
  // is what makes the two cases distinguishable.
  out.deptRings = Array.isArray(row.deptGroups) && row.deptGroups.length
    ? row.deptGroups.map((g) => ({ label: g.label, value: Number.isFinite(g.value) ? g.value : null }))
    : computeDeptGroupRings(row.depts);
  return out;
}
