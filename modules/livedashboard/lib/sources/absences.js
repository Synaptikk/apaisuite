// modules/livedashboard/lib/sources/absences.js
//
// Cross-module bridge to closinglist's existing IVR scraper. Rather than
// duplicating the multi-page WebForms scraping logic, the livedashboard
// reuses closinglist's pipeline.
//
// Two operations:
//   - peek():    returns the most-recent cached IVR result without
//                triggering a fresh scrape.
//   - collect(): triggers a fresh IVR collection (3-page flow + retries).
//
// Both delegate to closinglist's handlers directly (same SW process,
// cross-module static import is fine — service_worker.js's dispatcher
// also does this).

import { handlers as closinglistHandlers } from "../../../closinglist/service.js";

// Mirror of closinglist's contract — see modules/closinglist/service.js.
const CLOSINGLIST_RESULT_KEY = "closinglist.ivrLastResult";

// Cache TTL for peek() — if closinglist's last result is fresher than this,
// peek returns it; otherwise we fall through to nothing (caller decides
// whether to collect()). 15 min matches the dashboard's absences poll
// interval.
const PEEK_FRESHNESS_MS = 15 * 60 * 1000;

export async function peek() {
  const got = await chrome.storage.local.get(CLOSINGLIST_RESULT_KEY);
  const last = got[CLOSINGLIST_RESULT_KEY] || null;
  if (!last) return { ok: false, rows: [], errorClass: "NEVER", error: "No IVR data yet." };
  const ageMs = Date.now() - new Date(last.fetchedAt ?? 0).getTime();
  // Empty peek results are suspect — the IVR scraper sometimes lands on
  // a pre-render state where #ailTable_1 exists but the rows haven't
  // populated yet, then writes {ok:true, rows:[]} to closinglist's
  // cache. Treat those as stale so the caller re-collects. On the rare
  // genuine zero-callout day, the recollect also returns 0 and we
  // surface that legitimately.
  const isEmpty = !Array.isArray(last.rows) || last.rows.length === 0;
  if (ageMs > PEEK_FRESHNESS_MS || isEmpty) {
    return { ok: true, rows: last.rows ?? [], stale: true, capturedAt: last.fetchedAt, ageMs };
  }
  return { ok: true, rows: last.rows ?? [], stale: false, capturedAt: last.fetchedAt, ageMs };
}

export async function collect() {
  // Invoke closinglist's collect handler directly. This will:
  //   - Open or find the ivrattcloud-prod tab
  //   - Run the multi-page flow
  //   - Wait for the absence-table scrape
  //   - Persist to chrome.storage.local["closinglist.ivrLastResult"]
  //   - Return { ok, rows, capturedAt, error }
  const result = await closinglistHandlers["collect-ivr-absences"]({});
  return result;
}

// Normalize a raw closinglist row to the AbsenceRecord schema documented
// in docs/live_dashboard_backend/DATA_CONTRACTS.md.
//
// Raw closinglist row shape (from modules/closinglist/content/ivr.js):
//   { associate, absence_date, dept, job, call_date_time, absence_type,
//     absence_reason, confirmation, source }
export function normalize(rawRow, storeNbr, capturedAt, sourceUrl) {
  const win = extractWin(rawRow.associate);
  return {
    storeNbr:        String(storeNbr),
    associate:       rawRow.associate ?? "",
    win:             win,
    absenceDate:     toIsoDate(rawRow.absence_date),
    callDateTime:    rawRow.call_date_time ?? null,
    dept:            rawRow.dept ?? "",
    job:             rawRow.job ?? "",
    absenceType:     rawRow.absence_type ?? "",
    absenceReason:   rawRow.absence_reason ?? "",
    confirmation:    rawRow.confirmation ?? null,
    source:          rawRow.source ?? null,
    _source: {
      module:     "closinglist",
      capturedAt: capturedAt,
      sourceUrl:  sourceUrl,
    },
  };
}

// Tries to pull the 8–9 digit WIN out of the associate string, e.g.
// "DOE, JOHN (12345678)" → "12345678". Returns null when no match.
function extractWin(associate) {
  if (!associate) return null;
  const m = String(associate).match(/\((\d{6,10})\)/);
  return m ? m[1] : null;
}

// "06/02/2026" → "2026-06-02". Returns the input unchanged when it
// doesn't parse, so we never lose data.
function toIsoDate(mdy) {
  if (!mdy) return null;
  const m = String(mdy).match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return String(mdy);
  const [, mo, dd, yy] = m;
  const year = yy.length === 2 ? `20${yy}` : yy;
  return `${year}-${mo.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

// Rollup helper for the widget.
export function rollup(records, todayIso) {
  let callouts = 0;
  let tardies  = 0;
  const byDept = {};
  for (const r of records) {
    if (r.absenceDate !== todayIso) continue;
    const isTardy = /tardy/i.test(r.absenceType);
    if (isTardy) tardies++;
    else callouts++;
    if (!isTardy) {
      byDept[r.dept] = (byDept[r.dept] || 0) + 1;
    }
  }
  let maxDept = null;
  let maxDeptCount = 0;
  for (const [d, c] of Object.entries(byDept)) {
    if (c > maxDeptCount) { maxDept = d; maxDeptCount = c; }
  }
  return { callouts, tardies, byDept, maxDept, maxDeptCount };
}
