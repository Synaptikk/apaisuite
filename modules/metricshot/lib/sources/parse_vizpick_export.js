// modules/metricshot/lib/sources/parse_vizpick_export.js
//
// Turn the crosstab-export rows (from vizpick_export.js) into the row shapes
// format_message.js expects. Unlike the old parse_vizpick.js — which guessed
// at Tableau's server-rendered bootstrap JSON (that carries NO row data) —
// this maps real spreadsheet columns BY HEADER NAME. That makes it robust to
// column reordering: if Tableau shuffles/adds columns, we still find ours.
//
// Column layout confirmed from a live export (2026-07):
//   Location Details sheet (25 cols):
//     "Location "               → bin, e.g. "001/002"
//     "Status "                 → e.g. "In Use"
//     "Max. last_seen_timestamp"→ last scan time, e.g. "7/28/2026 10:41:14 AM"
//     "Cases Seen %"            → e.g. "6%"
//     "Total Picked"            → integer
//   Department Breakout sheet (11 cols):
//     "Dept"                    → dept number or "Total"
//     "Pick %"                  → fraction 0..1
//     "Total Picked"            → integer
//     "Cases Seen "             → integer
//     "Cases Expected "         → integer
//
// Pure: no chrome.*/DOM. `now` is injectable for testability.

/**
 * @param {string[][]} rows   Location Details export rows (row 0 = headers).
 * @param {number} [now=Date.now()]
 * @returns {Array<{ location:string, hoursSinceLastScan:number|null,
 *                   casesSeenPct:number|null, pickedTotal:number|null,
 *                   status:string|null }>}
 */
export function mapLocationDetails(rows, now = Date.now()) {
  if (!Array.isArray(rows) || rows.length < 2) return [];
  const H = _headerIndex(rows[0]);

  const cLoc    = H.exact("Location") ?? H.contains("location", { notContains: ["123", "copy", "combined"] });
  const cStatus = H.exact("Status")   ?? H.contains("status", { notContains: ["copy", "combined"] });
  const cSeen   = H.contains("last_seen_timestamp");
  const cPct    = H.exact("Cases Seen %");
  const cPicked = H.exact("Total Picked");

  if (cLoc == null) return [];

  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const location = _str(row[cLoc]);
    if (!location) continue;
    out.push({
      location,
      hoursSinceLastScan: cSeen != null ? _hoursSince(row[cSeen], now) : null,
      casesSeenPct: cPct != null ? _toNumber(row[cPct]) : null,
      pickedTotal:  cPicked != null ? _toNumber(row[cPicked]) : null,
      status:       cStatus != null ? (_str(row[cStatus]) || null) : null,
    });
  }
  return out;
}

/**
 * @param {string[][]} rows   Department Breakout export rows (row 0 = headers).
 * @returns {Array<{ dept:string, pickPct:number|null, totalPicked:number|null,
 *                   casesSeen:number|null, casesExpected:number|null }>}
 */
export function mapDepartmentBreakout(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return [];
  const H = _headerIndex(rows[0]);

  const cDept   = H.exact("Dept") ?? H.contains("dept");
  const cPick   = H.exact("Pick %");
  const cPicked = H.exact("Total Picked");
  const cSeen   = H.contains("cases seen", { notContains: ["%"] });
  const cExp    = H.contains("cases expected");

  if (cDept == null) return [];

  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const dept = _str(row[cDept]);
    if (!dept) continue;
    out.push({
      dept,
      pickPct:       cPick != null ? _toNumber(row[cPick]) : null,
      totalPicked:   cPicked != null ? _toNumber(row[cPicked]) : null,
      casesSeen:     cSeen != null ? _toNumber(row[cSeen]) : null,
      casesExpected: cExp != null ? _toNumber(row[cExp]) : null,
    });
  }
  return out;
}

// ── header lookup ──────────────────────────────────────────────────────────

function _headerIndex(headerRow) {
  const norm = (headerRow || []).map((h) => _str(h).toLowerCase());
  return {
    // First column whose trimmed header equals the target (case-insensitive).
    exact(name) {
      const t = name.toLowerCase();
      const i = norm.indexOf(t);
      return i >= 0 ? i : null;
    },
    // First column whose header contains `sub` and none of `notContains`.
    contains(sub, { notContains = [] } = {}) {
      const s = sub.toLowerCase();
      for (let i = 0; i < norm.length; i++) {
        const h = norm[i];
        if (h.includes(s) && !notContains.some((n) => h.includes(n.toLowerCase()))) return i;
      }
      return null;
    },
  };
}

// ── value coercion ───────────────────────────────────────────────────────

function _str(v) {
  return v == null ? "" : String(v).trim();
}

function _toNumber(v) {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).trim().replace(/,/g, "").replace(/%$/, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Hours between a Tableau timestamp string ("M/d/yyyy h:mm:ss AM") and `now`.
// Clamps tiny negatives (clock skew) to 0. Returns null on unparseable input.
function _hoursSince(v, now) {
  const s = _str(v);
  if (!s) return null;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  const hrs = (now - t) / 3_600_000;
  if (hrs < 0) return hrs > -0.5 ? 0 : null; // small skew → 0; wild future → null
  return hrs;
}


// ── Donut health sheets ──────────────────────────────────────────────────────
//
// Parsing lives in modules/vizpick/lib/parse_vizpick_stores_csv.js, which owns
// these worksheets and already drives them for VizPick's own Today capture.
// This file only reshapes the result into what the card wants. Two parsers of
// one Tableau sheet is a drift waiting to happen, and this one was the copy.

import { parseDonutHealthRows, parseDepartmentGroupRows }
  from "../../../vizpick/lib/parse_vizpick_stores_csv.js";

// Goals are shown on the dashboard, not carried in the export.
const DONUT_GOALS = { cases: 95, locations: 95, picks: 90, overstock: 90 };

/**
 * @param {string[][]} rows  "VizPick Donut Health" export rows.
 * @returns {{health:number|null,
 *            metrics:Array<{label:string,value:number|null,goal:number|null}>}}
 */
export function mapDonutHealth(rows) {
  const r = parseDonutHealthRows(rows);
  if (!r.ok) return { health: null, metrics: [] };
  const h = r.health;
  return {
    health: h.vizpick,
    metrics: [
      { label: "Cases",     value: h.casesSeenPct, goal: DONUT_GOALS.cases },
      { label: "Locations", value: h.locationPct,  goal: DONUT_GOALS.locations },
      { label: "Picks",     value: h.pickPct,      goal: DONUT_GOALS.picks },
      { label: "Overstock", value: h.overstockPct, goal: DONUT_GOALS.overstock },
    ],
  };
}

/**
 * @param {string[][]} rows  "Department Groups Donuts Health" export rows.
 * @returns {Array<{label:string,value:number|null}>}
 */
export function mapDepartmentGroups(rows) {
  return parseDepartmentGroupRows(rows).map((g) => ({ label: g.group, value: g.vizpick }));
}
