// modules/digitalmetrics/lib/data/wmweek.js
//
// Walmart fiscal week numbering. Pure.
//
// ── The rule, and how it was pinned down ───────────────────────────────────
// The fiscal year starts 1 February, and weeks run Saturday–Friday. So week 1
// is the Sat–Fri week CONTAINING 1 February — which means it usually starts a
// day or two BEFORE the 1st, not on it.
//
// Verified against two independent sources rather than derived from the
// definition alone, because an off-by-one here mislabels every week in the
// picker:
//
//   · Tableau's WM_WEEK filter reports 202630 for the week beginning
//     2026-08-22 (dev/DIGITALMETRICS_PULL_FINDINGS.md).
//   · The Workforce Planning scheduler shows "WK 30" for that same week.
//
// Saturday-on-or-before 2026-02-01 is 2026-01-31 (the 1st is a Sunday), and
// 2026-08-22 is 29 weeks after it → week 30. Both agree.
//
// Everything here works in LOCAL time. Parsing "2026-08-22" with `new Date()`
// gives UTC midnight, which in a negative-offset zone is the previous day —
// and a week key that slips a day lands in the wrong fiscal week.

/** Parse YYYY-MM-DD as a local date. */
function localDate(iso) {
  const [y, m, d] = String(iso).split("-").map((n) => parseInt(n, 10));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  return new Date(y, m - 1, d);
}

const pad = (n) => String(n).padStart(2, "0");
const iso = (dt) => `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;

/** The Saturday on or before a date. getDay(): Sun=0 … Sat=6. */
function saturdayOnOrBefore(dt) {
  const out = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
  out.setDate(out.getDate() - ((out.getDay() + 1) % 7));
  return out;
}

/** Start of fiscal week 1 for the fiscal year labelled `year`. */
export function fiscalYearStart(year) {
  return saturdayOnOrBefore(new Date(year, 1, 1));   // month 1 === February
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Fiscal week for a date.
 *
 * @returns { year, week, code, label } — `code` is Tableau's WM_WEEK spelling
 * ("202630"), `label` is what the scheduler shows ("WK 30").
 */
export function wmWeek(dateOrIso) {
  const dt = typeof dateOrIso === "string" ? localDate(dateOrIso) : dateOrIso;
  if (!dt || Number.isNaN(dt.getTime())) return null;

  const sat = saturdayOnOrBefore(dt);

  // A date in January usually belongs to the PREVIOUS fiscal year's last week,
  // so try this calendar year first and fall back.
  let year = sat.getFullYear();
  let start = fiscalYearStart(year);
  if (sat < start) {
    year -= 1;
    start = fiscalYearStart(year);
  }

  const week = Math.round((sat - start) / WEEK_MS) + 1;
  return {
    year,
    week,
    code: `${year}${pad(week)}`,
    label: `WK ${week}`,
    weekStart: iso(sat),
  };
}

/**
 * Label for the week picker: "WK 30 · Aug 22 – Aug 28".
 *
 * The date range stays because the fiscal week number alone does not tell you
 * which days you are looking at, and the module keys everything by the
 * Saturday.
 */
export function weekLabel(weekStartIso, { withYear = false } = {}) {
  const w = wmWeek(weekStartIso);
  if (!w) return String(weekStartIso ?? "");

  const start = localDate(w.weekStart);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
  const fmt = (d) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });

  return `${w.label}${withYear ? ` (FY${String(w.year).slice(-2)})` : ""} · ${fmt(start)} – ${fmt(end)}`;
}

/** How many fiscal weeks a year has — 52, or 53 when the calendar demands it. */
export function weeksInFiscalYear(year) {
  const start = fiscalYearStart(year);
  const next = fiscalYearStart(year + 1);
  return Math.round((next - start) / WEEK_MS);
}
