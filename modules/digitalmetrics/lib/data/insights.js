// modules/digitalmetrics/lib/data/insights.js
//
// Daily volume, Digital vs Store Help split, Store Help peak hours, and 5am
// late-start impact. Pure.

import { classificationOf } from "./classify.js";
import { parsePickDate } from "./parse.js";

const LATE_FLAG_MINUTES = 5;    // >5:05 counts as late for the day count
const LATE_MAX_MINUTE   = 50;   // 5:51+ is an early 6am start, not a late 5am one

// Documented behaviour (see the donor's tab description) is to exclude both
// Store Help and Fashion from late starts: they work different schedules and
// are not expected at 5am. The donor's CODE excluded only Store Help, so this
// is a deliberate correction, not an accidental divergence.
const LATE_START_EXCLUDED = new Set(["Store Help", "Fashion"]);

const picksOf = (row) =>
  (row["Picked As Req Qty"] || 0) + (row["Exception Picked As Req Qty"] || 0);

/** Forward-fill the sparse Pick Date column, keeping the original label. */
function filled(rawData) {
  let last = null;
  return (rawData || []).map((row) => {
    if (row["Pick Date"]) last = row["Pick Date"];
    return { ...row, _label: last };
  });
}

/** Per-day pick volume split by group. Most recent day first. */
export function dailyPicks(rawData, classifications = {}) {
  const byDate = new Map();

  for (const row of filled(rawData)) {
    if (!row._label) continue;
    if (!byDate.has(row._label)) {
      byDate.set(row._label, { date: row._label, total: 0, digital: 0, exceptions: 0, storeHelp: 0 });
    }
    const day = byDate.get(row._label);
    const picks = picksOf(row);
    day.total += picks;

    switch (classificationOf(row.Associate, classifications)) {
      case "Digital":    day.digital    += picks; break;
      case "Exceptions": day.exceptions += picks; break;
      case "Store Help": day.storeHelp  += picks; break;
    }
  }

  return [...byDate.values()]
    .map((d) => {
      // Exceptions are digital work; the split people care about is
      // "our team" vs "borrowed help".
      const digitalTotal = d.digital + d.exceptions;
      return {
        ...d,
        digitalTotal,
        digitalPct: d.total > 0 ? Math.round((digitalTotal / d.total) * 100) : 0,
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

  const digitalTotal = sum("digitalTotal");
  const storeHelp    = sum("storeHelp");
  return {
    total, digitalTotal, storeHelp,
    digitalPct:   share(digitalTotal),
    storeHelpPct: share(storeHelp),
  };
}

/** Parse "12/6/25 9:08 AM" (or bare "9:08 AM") to a 0–23 hour. */
export function scanHour(firstScan) {
  if (typeof firstScan !== "string") return null;
  const m = firstScan.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) return null;

  let hour = parseInt(m[1], 10);
  const isPM = m[3].toUpperCase() === "PM";
  if (isPM && hour !== 12) hour += 12;
  if (!isPM && hour === 12) hour = 0;
  return hour;
}

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

    const scan = row["Min. First Scan"];
    if (typeof scan !== "string") continue;
    const m = scan.match(/(\d+):(\d+)\s*(AM|PM)/i);
    if (!m) continue;

    const hour    = parseInt(m[1], 10);
    const minutes = parseInt(m[2], 10);
    const isPM    = m[3].toUpperCase() === "PM";
    if (isPM || hour !== 5 || minutes > LATE_MAX_MINUTE) continue;

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
