// modules/digitalmetrics/lib/data/metrics.js
//
// Per-associate aggregation and benchmark calculation. Pure — takes rows and a
// classification map, returns numbers. No DOM, no storage, no globals.
//
// Definitions that look surprising but are deliberate (they match the FAQ tab
// and the numbers people already trust):
//
//   • Exception picks are ADDED into every headline metric. FTPR, nil rate and
//     sub rate all count regular + exception work together.
//   • `pick_rate` is the unweighted mean of the per-day Pick Rate column, not
//     total picks ÷ total hours. A short day counts as much as a long one.
//   • Benchmarks are computed twice: exception pickers are measured only
//     against each other, and Fashion is excluded from the pick-rate average
//     because their task mix makes the number incomparable.

import { parsePickDate } from "./parse.js";
import { formatKey } from "./weeks.js";

const EXCEPTION_PICKER_THRESHOLD = 0.20;   // ≥20% exception work → own benchmark
const LATE_START_MAX_MINUTE      = 50;     // 5:51+ reads as a 6am start, not a late 5am

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const round1 = (v) => Math.round(v * 10) / 10;
const pct1   = (v) => Math.round(v * 1000) / 10;

/** Attach a resolved local `_date` to every row, forward-filling blanks. */
export function withDates(rows) {
  let last = null;
  return (rows || []).map((row) => {
    const parsed = parsePickDate(row["Pick Date"]);
    if (parsed) last = parsed;
    return { ...row, _date: last };
  });
}

/** Sorted YYYY-MM-DD list of every date present. Local time, never UTC. */
export function distinctDates(rows) {
  return [...new Set(withDates(rows).filter((r) => r._date).map((r) => formatKey(r._date)))].sort();
}

/** Inclusive date-range filter. Rows with no date are kept, as in the donor. */
export function filterByDate(rows, { start = null, end = null } = {}) {
  if (!start && !end) return rows;
  return rows.filter((r) => {
    if (!r._date) return true;
    if (start && r._date < start) return false;
    if (end   && r._date > end)   return false;
    return true;
  });
}

/**
 * Minutes past 5:00 for a 5am associate's first scan, or null if this row
 * isn't a 5am start. "5:51"–"5:59" is treated as an early 6am start.
 */
export function lateStartMinutes(firstScan) {
  if (typeof firstScan !== "string") return null;
  const m = firstScan.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) return null;

  const hour    = parseInt(m[1], 10);
  const minutes = parseInt(m[2], 10);
  const isPM    = m[3].toUpperCase() === "PM";
  if (isPM || hour !== 5 || minutes > LATE_START_MAX_MINUTE) return null;
  return minutes;
}

/** Aggregate rows into one record per associate. */
export function aggregate(rows) {
  const byName = new Map();

  for (const row of rows || []) {
    const name = row.Associate;
    if (!name) continue;

    if (!byName.has(name)) {
      byName.set(name, {
        name, hours: 0, ftpExpected: 0, ftpActual: 0, pickRateSum: 0,
        picked: 0, nil: 0, sub: 0, regularPicks: 0, exceptionPicks: 0,
        lateStarts: [], count: 0,
      });
    }
    const g = byName.get(name);

    g.hours          += num(row["Pick Hours"]);
    g.ftpExpected    += num(row["FTP Expected"]) + num(row["Exception Qty Req to Pick"]);
    g.ftpActual      += num(row["FTP Actual"])   + num(row["Exception Picked As Req Qty"]);
    g.pickRateSum    += num(row["Pick Rate"]);
    g.regularPicks   += num(row["FTP Expected"]);
    g.exceptionPicks += num(row["Exception Qty Req to Pick"]);
    g.picked         += num(row["Picked As Req Qty"])  + num(row["Exception Picked As Req Qty"]);
    g.nil            += num(row["Nil Pick Qty"])       + num(row["Exception Nil Pick Qty"]);
    g.sub            += num(row["Substitution Qty"])   + num(row["Exception Substitution Qty"]);
    g.count++;

    const late = lateStartMinutes(row["Min. First Scan"]);
    if (late !== null) g.lateStarts.push(late);
  }

  return [...byName.values()].map((g) => {
    const totalPicks = g.regularPicks + g.exceptionPicks;
    const totalLate  = g.lateStarts.reduce((s, m) => s + m, 0);

    return {
      name:            g.name,
      hours:           round1(g.hours),
      ftpr:            pct1(g.ftpExpected > 0 ? g.ftpActual / g.ftpExpected : 0),
      pick_rate:       round1(g.count > 0 ? g.pickRateSum / g.count : 0),
      nil_rate:        pct1(g.picked > 0 ? g.nil / g.picked : 0),
      sub_rate:        pct1(g.picked > 0 ? g.sub / g.picked : 0),
      picked_qty:      g.picked,
      nil_qty:         g.nil,
      sub_qty:         g.sub,
      ftp_expected:    g.ftpExpected,
      ftp_actual:      g.ftpActual,
      regular_picks:   g.regularPicks,
      exception_picks: g.exceptionPicks,

      isExceptionsPicker: totalPicks > 0 && g.exceptionPicks / totalPicks >= EXCEPTION_PICKER_THRESHOLD,

      is5amAssociate:   g.lateStarts.length > 0,
      lateStartDays:    g.lateStarts.length,
      totalLateMinutes: totalLate,
      avgLateMinutes:   g.lateStarts.length ? Math.round(totalLate / g.lateStarts.length) : 0,
    };
  });
}

const mean = (list, key) =>
  list.length ? list.reduce((s, a) => s + a[key], 0) / list.length : 0;

/**
 * Group averages. `classifications` maps associate name → classification and
 * is only consulted to exclude Fashion from the pick-rate benchmark.
 */
export function benchmarks(associates, classifications = {}) {
  const regular   = associates.filter((a) => !a.isExceptionsPicker);
  const exception = associates.filter((a) =>  a.isExceptionsPicker);
  const nonFashion = regular.filter((a) => classifications[a.name] !== "Fashion");

  return {
    ftpr:      round1(mean(regular, "ftpr")),
    nil_rate:  round1(mean(regular, "nil_rate")),
    sub_rate:  round1(mean(regular, "sub_rate")),
    pick_rate: round1(mean(nonFashion, "pick_rate")),

    exc_ftpr:      round1(mean(exception, "ftpr")),
    exc_nil_rate:  round1(mean(exception, "nil_rate")),
    exc_sub_rate:  round1(mean(exception, "sub_rate")),
    exc_pick_rate: round1(mean(exception, "pick_rate")),
  };
}

/** One call: rows + classifications → { associates, benchmarks, dates }. */
export function analyse(rawData, classifications = {}, dateFilter = {}) {
  const dated    = withDates(rawData);
  const filtered = filterByDate(dated, dateFilter);
  const list     = aggregate(filtered);
  return {
    associates: list,
    benchmarks: benchmarks(list, classifications),
    dates:      distinctDates(rawData),
  };
}
