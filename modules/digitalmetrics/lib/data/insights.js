// modules/digitalmetrics/lib/data/insights.js
//
// Daily volume, Digital vs Store Help split, Store Help peak hours, and 5am
// late-start impact. Pure.

import { classificationOf } from "./classify.js";
import { parsePickDate } from "./parse.js";
import { scanHour, minutesPastFive } from "./clock.js";
import { expressForLabel } from "./express.js";

const LATE_FLAG_MINUTES = 5;    // >5:05 counts as late for the day count
const LATE_MAX_MINUTE   = 50;   // 5:51+ is an early 6am start, not a late 5am one

// Store Help is excluded from late starts: they work different schedules and
// are not expected at 5am.
//
// Fashion was also excluded until 2026-08-25, when the category was retired
// (data/classify.js) — apparel pickers now classify as Store Help, so they are
// still excluded, just by the surviving rule rather than a second one.
const LATE_START_EXCLUDED = new Set(["Store Help"]);

// Every unit picked, substitutes included — the scorecard's TY Qty counts
// them (9/20: 22,905 as-requested + 1,205 subs = its 24,114 within 4).
const picksOf = (row) =>
  (row["Picked As Req Qty"] || 0) + (row["Exception Picked As Req Qty"] || 0) +
  (row["Substitution Qty"] || 0) + (row["Exception Substitution Qty"] || 0);

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const round1 = (v) => Math.round(v * 10) / 10;

/** Forward-fill the sparse Pick Date column, keeping the original label. */
function filled(rawData) {
  let last = null;
  return (rawData || []).map((row) => {
    if (row["Pick Date"]) last = row["Pick Date"];
    return { ...row, _label: last };
  });
}

/**
 * Per-day pick volume split by group. Most recent day first.
 *
 * `express` is the week document's Express Pickup map (ISO date → { orders,
 * units }). A day it does not cover reports null, not 0 — "not pulled yet" and
 * "no express orders" must stay distinguishable in the table. `expressRate`
 * is the Express pick-rate map (ISO date → { rate, units, hours, pickers }).
 */
export function dailyPicks(rawData, classifications = {}, express = null, expressRate = null) {
  const byDate = new Map();

  for (const row of filled(rawData)) {
    if (!row._label) continue;
    if (!byDate.has(row._label)) {
      byDate.set(row._label, { date: row._label, total: 0, digital: 0, exceptions: 0, storeHelp: 0, storeHelpHours: 0 });
    }
    const day = byDate.get(row._label);
    const picks = picksOf(row);
    day.total += picks;

    switch (classificationOf(row.Associate, classifications)) {
      case "Digital":    day.digital    += picks; break;
      case "Exceptions": day.exceptions += picks; break;
      case "Store Help":
        day.storeHelp      += picks;
        // The hours the store spent covering digital: same Pick Hours column
        // the per-associate table sums, restricted to borrowed help.
        day.storeHelpHours += num(row["Pick Hours"]);
        break;
    }
  }

  return [...byDate.values()]
    .map((d) => {
      // Exceptions are digital work; the split people care about is
      // "our team" vs "borrowed help".
      const digitalTotal = d.digital + d.exceptions;
      const ex = expressForLabel(express, d.date);
      const er = expressForLabel(expressRate, d.date);
      return {
        ...d,
        storeHelpHours: round1(d.storeHelpHours),
        digitalTotal,
        digitalPct: d.total > 0 ? Math.round((digitalTotal / d.total) * 100) : 0,
        // "Picks" is the dashboard's UNITS measure (SUM(ITEMS)).
        expressOrders: ex ? (ex.orders ?? 0) : null,
        expressPicks:  ex ? (ex.units  ?? 0) : null,
        // Units ÷ pick hours on Associate By Day filtered to Express Pickup.
        expressRate:      er?.rate ?? null,
        expressRateUnits: er ? (er.units ?? 0) : null,
        expressRateHours: er ? (er.hours ?? 0) : null,
      };
    })
    .sort((a, b) => (parsePickDate(b.date) ?? 0) - (parsePickDate(a.date) ?? 0));
}

/** Health band for the digital share of a day's picks. */
export function digitalTone(pct) {
  if (pct >= 85) return "good";
  if (pct >= 70) return "warn";
  return "bad";
}

/** Totals across the whole loaded period. */
export function distribution(daily) {
  const sum = (key) => daily.reduce((s, d) => s + d[key], 0);
  const total = sum("total");
  const share = (v) => (total > 0 ? Math.round((v / total) * 100) : 0);

  const digitalTotal   = sum("digitalTotal");
  const storeHelp      = sum("storeHelp");
  const storeHelpHours = round1(sum("storeHelpHours"));

  // Express totals cover only the days that have been pulled; say how many.
  const withExpress = daily.filter((d) => d.expressOrders != null);
  const expressDays = withExpress.length;
  return {
    total, digitalTotal, storeHelp, storeHelpHours,
    digitalPct:   share(digitalTotal),
    storeHelpPct: share(storeHelp),
    expressDays,
    expressOrders: expressDays ? withExpress.reduce((s, d) => s + d.expressOrders, 0) : null,
    expressPicks:  expressDays ? withExpress.reduce((s, d) => s + d.expressPicks, 0)  : null,
    // Hours-weighted across the days that have one, like the daily figure.
    ...expressRateSummary(daily),
  };
}

function expressRateSummary(daily) {
  const days = daily.filter((d) => d.expressRateHours > 0);
  const units = days.reduce((s, d) => s + d.expressRateUnits, 0);
  const hours = days.reduce((s, d) => s + d.expressRateHours, 0);
  return {
    expressRateDays: days.length,
    expressRate: hours > 0 ? Math.round((units / hours) * 10) / 10 : null,
  };
}

/**
 * Day-level overlap between borrowed-help hours and Express pick hours,
 * for the "is Express why we keep pulling store help?" question. Only days
 * whose Express pick-rate pull exists can be compared; r is Pearson across
 * those days and null when there are fewer than 3 or no variance.
 */
export function helpVsExpress(daily) {
  const days = daily
    .filter((d) => d.expressRateHours != null)
    .sort((a, b) => (parsePickDate(b.date) ?? 0) - (parsePickDate(a.date) ?? 0));

  const helpHours    = round1(days.reduce((s, d) => s + d.storeHelpHours, 0));
  const expressHours = round1(days.reduce((s, d) => s + d.expressRateHours, 0));
  return {
    days,
    helpHours,
    expressHours,
    r: pearson(days.map((d) => d.storeHelpHours), days.map((d) => d.expressRateHours)),
  };
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  if (sxx === 0 || syy === 0) return null;
  return Math.round((sxy / Math.sqrt(sxx * syy)) * 100) / 100;
}

/**
 * Parse "12/6/25 9:08 AM", "8/22/2026 1:08:37 PM" or bare "9:08" to a 0–23
 * hour. Re-exported from data/clock.js, which explains why the old inline
 * regex read minutes as hours.
 */
export { scanHour };

/** When Store Help actually starts, by first-scan hour. Busiest first. */
export function storeHelpPeakHours(rawData, classifications = {}) {
  const byHour = new Map();
  let total = 0;

  for (const row of rawData || []) {
    if (classificationOf(row.Associate, classifications) !== "Store Help") continue;
    const hour = scanHour(row["Min. First Scan"]);
    if (hour === null) continue;

    const picks = picksOf(row);
    const bucket = byHour.get(hour) || { hour, count: 0, picks: 0 };
    bucket.count++;
    bucket.picks += picks;
    byHour.set(hour, bucket);
    total += picks;
  }

  return [...byHour.values()]
    .map((h) => ({ ...h, pct: total > 0 ? Math.round((h.picks / total) * 100) : 0 }))
    .sort((a, b) => b.picks - a.picks);
}

export function formatHour(h) {
  if (h === 0)  return "12 AM";
  if (h === 12) return "12 PM";
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

/**
 * Late starts for 5am associates, with an estimate of the picks lost.
 *
 * Lost picks are minutes-late converted to hours times that associate's own
 * pick rate — an estimate, and labelled as one in the UI. It exists to make
 * "twelve minutes" mean something operationally.
 */
export function lateStarts(rawData, associates = [], classifications = {}) {
  const rateByName = new Map(associates.map((a) => [a.name, a.pick_rate || 0]));
  const byName = new Map();

  for (const row of filled(rawData)) {
    const name = row.Associate;
    if (!name) continue;
    if (LATE_START_EXCLUDED.has(classificationOf(name, classifications))) continue;

    const minutes = minutesPastFive(row["Min. First Scan"], LATE_MAX_MINUTE);
    if (minutes === null) continue;

    if (!byName.has(name)) byName.set(name, { name, days: [] });
    byName.get(name).days.push({ date: row._label, minutes });
  }

  const people = [...byName.values()].map((p) => {
    const totalLost = p.days.reduce((s, d) => s + d.minutes, 0);
    const rate      = rateByName.get(p.name) || 0;
    return {
      name:      p.name,
      days:      p.days,
      dayCount:  p.days.length,
      avgMinutes: Math.round(totalLost / p.days.length),
      totalLost,
      lateDays:  p.days.filter((d) => d.minutes > LATE_FLAG_MINUTES),
      pickRate:  rate,
      lostPicks: Math.round((totalLost / 60) * rate),
    };
  }).sort((a, b) => b.totalLost - a.totalLost);

  const totalDays = people.reduce((s, p) => s + p.dayCount, 0);
  return {
    people,
    associateCount: people.length,
    totalLostMinutes: people.reduce((s, p) => s + p.totalLost, 0),
    totalLostPicks:   people.reduce((s, p) => s + p.lostPicks, 0),
    totalLateDays:    people.reduce((s, p) => s + p.lateDays.length, 0),
    // Weighted by days worked, so someone with one bad day doesn't dominate.
    avgStartMinutes:  totalDays > 0
      ? Math.round(people.reduce((s, p) => s + p.avgMinutes * p.dayCount, 0) / totalDays)
      : 0,
  };
}
