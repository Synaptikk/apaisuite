// modules/digitalmetrics/lib/data/opportunities.js
//
// Which associates are underperforming, and by how much. Pure.
//
// Two separate ideas that the donor computed in one pass:
//   issues[] — human-readable flags, one per metric that is off benchmark
//   score    — a single ranking number, so the list can be ordered by
//              "who needs attention most" rather than by any one metric
//
// Every comparison uses the benchmark for that associate's own cohort:
// exception pickers are measured against exception pickers, everyone else
// against everyone else. Mixing them makes exception pickers look terrible at
// picking and everyone else look terrible at exceptions.

const LATE_START_THRESHOLD = 5;   // minutes past 5:00 before a start is "late"

// Score weights. Each converts "how far off benchmark" into comparable points;
// the divisors exist because the raw units are wildly different scales (a
// percentage point of FTPR is not one pick per hour).
const WEIGHTS = {
  ftpr:      (delta) => delta,             // percentage points, 1:1
  pickRate:  (delta) => delta / 10,        // picks/hour are a coarser unit
  nilRate:   (delta) => delta * 2,         // not-found hurts twice
  subRate:   (delta) => delta * 2,
  lateStart: (minutes) => minutes / 10,
  adherence: (shortfall) => shortfall / 5,
};

const r1 = (v) => Math.round(v * 10) / 10;

/** The benchmark set that applies to one associate. */
export function benchmarkFor(associate, benchmarks) {
  return associate.isExceptionsPicker
    ? { ftpr:      benchmarks.exc_ftpr      ?? 0,
        nil_rate:  benchmarks.exc_nil_rate  ?? 0,
        sub_rate:  benchmarks.exc_sub_rate  ?? 0,
        pick_rate: benchmarks.exc_pick_rate ?? 0 }
    : { ftpr:      benchmarks.ftpr      ?? 0,
        nil_rate:  benchmarks.nil_rate  ?? 0,
        sub_rate:  benchmarks.sub_rate  ?? 0,
        pick_rate: benchmarks.pick_rate ?? 0 };
}

/**
 * Annotate associates with `issues`, `score` and `scoreBreakdown`.
 *
 * @param adherence  { name: { adherence, isLowAdherence, actualHours, assignedHours } }
 */
export function analyseOpportunities(associates, benchmarks, adherence = {}) {
  return (associates || []).map((a) => {
    const b    = benchmarkFor(a, benchmarks);
    const adh  = adherence[a.name] || null;
    const pct  = (v) => `${v}%`;

    const issues    = [];
    const breakdown = [];
    let score = 0;

    const add = (label, points, detail) => {
      if (!(points > 0)) return;
      score += points;
      breakdown.push(`${label}: +${points.toFixed(1)} (${detail})`);
    };

    if (a.ftpr < b.ftpr) {
      issues.push(`FTPR: ${pct(a.ftpr)} (avg: ${pct(b.ftpr)})`);
      add("FTPR", r1(WEIGHTS.ftpr(b.ftpr - a.ftpr)), `${pct(a.ftpr)} vs ${pct(b.ftpr)} avg`);
    }
    if (a.pick_rate < b.pick_rate) {
      issues.push(`Pick Rate: ${a.pick_rate} (avg: ${b.pick_rate})`);
      add("Pick Rate", r1(WEIGHTS.pickRate(b.pick_rate - a.pick_rate)),
          `${a.pick_rate} vs ${b.pick_rate} avg`);
    }
    if (a.nil_rate > b.nil_rate) {
      issues.push(`Nil: ${pct(a.nil_rate)} (avg: ${pct(b.nil_rate)})`);
      add("Nil Rate", r1(WEIGHTS.nilRate(a.nil_rate - b.nil_rate)),
          `${pct(a.nil_rate)} vs ${pct(b.nil_rate)} avg`);
    }
    if (a.sub_rate > b.sub_rate) {
      issues.push(`Sub: ${pct(a.sub_rate)} (avg: ${pct(b.sub_rate)})`);
      add("Sub Rate", r1(WEIGHTS.subRate(a.sub_rate - b.sub_rate)),
          `${pct(a.sub_rate)} vs ${pct(b.sub_rate)} avg`);
    }
    if (a.is5amAssociate && a.avgLateMinutes > LATE_START_THRESHOLD) {
      issues.push(`Late Start: avg 5:${String(a.avgLateMinutes).padStart(2, "0")} AM ` +
                  `(${a.totalLateMinutes} min lost over ${a.lateStartDays} days)`);
    }
    if (a.is5amAssociate && a.totalLateMinutes > 0) {
      // Scored even below the flagging threshold — small delays still rank.
      add("Late Start", r1(WEIGHTS.lateStart(a.totalLateMinutes)),
          `${a.totalLateMinutes} min total`);
    }
    if (adh?.isLowAdherence) {
      issues.push(`Pick Adherence: ${pct(adh.adherence)} ` +
                  `(${adh.actualHours}h of ${adh.assignedHours}h assigned)`);
    }
    if (adh && adh.adherence < 100) {
      add("Adherence", r1(WEIGHTS.adherence(100 - adh.adherence)),
          `${pct(adh.adherence)} of assigned`);
    }

    return { ...a, issues, adherence: adh?.adherence ?? null,
             score: r1(score), scoreBreakdown: breakdown };
  });
}

/** Sort comparators. "overall" ranks by score; the rest are worst-first. */
export const SORTS = {
  overall:        (a, b) => b.score - a.score,
  ftpr:           (a, b) => a.ftpr - b.ftpr,
  pick_rate:      (a, b) => a.pick_rate - b.pick_rate,
  nil_rate:       (a, b) => b.nil_rate - a.nil_rate,
  sub_rate:       (a, b) => b.sub_rate - a.sub_rate,
  late_start:     (a, b) => b.totalLateMinutes - a.totalLateMinutes,
  pick_adherence: (a, b) => (a.adherence ?? 100) - (b.adherence ?? 100),
};

export function sortOpportunities(list, sortBy = "overall") {
  return [...list].sort(SORTS[sortBy] || SORTS.overall);
}

/**
 * Leaderboard outlier rule: exclude anyone below 10% of the average pick
 * volume. Without it a single half-day skews every ranking.
 * Returns { ranked, excluded }.
 */
export function excludeOutliers(associates, { threshold = 0.1 } = {}) {
  const list = associates || [];
  if (!list.length) return { ranked: [], excluded: [] };

  const avg   = list.reduce((s, a) => s + (a.picked_qty || 0), 0) / list.length;
  const floor = avg * threshold;

  return {
    ranked:   list.filter((a) => (a.picked_qty || 0) >= floor),
    excluded: list.filter((a) => (a.picked_qty || 0) <  floor),
  };
}
