// modules/digitalmetrics/lib/data/classify.js
//
// Classification vocabulary and lookup. Pure.
//
// Meanings, because they drive benchmark maths elsewhere:
//   Digital      — dedicated digital fulfilment team. Includes In Home
//                  Delivery (2026-08-29): the title has no "digital" in it,
//                  but the work is digital and belongs on the same
//                  leaderboard. See data/job_classify.js::DIGITAL_JOB_RE.
//   Exceptions   — digital associates mostly working exception picks; measured
//                  only against each other (see data/metrics.js)
//   Store Help   — store associates helping out; different schedules, so
//                  excluded from 5am late-start analysis
//
// ── Fashion was retired 2026-08-25 ─────────────────────────────────────────
// Classification is now derived from the scheduler's job title
// (data/job_classify.js): digital titles are Digital, everyone else who picked
// is Store Help. Apparel pickers fall out as Store Help under that rule, which
// is what the analyst asked for, and the category sat at zero.
//
// UNCLASSIFIED is kept as an INTERNAL fallback, not a category. Something has
// to describe a picker the scheduler has no title for — deleting the constant
// would silently drop those people out of every count rather than show them.
// It is excluded from CLASSIFICATIONS so it cannot be assigned, and the
// dashboard only renders it when it is non-zero.

export const CLASSIFICATIONS = ["Digital", "Exceptions", "Store Help"];
export const UNCLASSIFIED = "Unclassified";

/** Classification for a name, defaulting to Unclassified. */
export function classificationOf(name, classifications = {}) {
  return classifications[name] || UNCLASSIFIED;
}

/** CSS modifier for a classification badge, e.g. "Store Help" → "store-help". */
export function badgeClass(classification) {
  return String(classification || UNCLASSIFIED).toLowerCase().replace(/\s+/g, "-");
}

/** Count associates per classification, including Unclassified. */
export function countByClassification(associates, classifications = {}) {
  const counts = Object.fromEntries([...CLASSIFICATIONS, UNCLASSIFIED].map((c) => [c, 0]));
  for (const a of associates || []) counts[classificationOf(a.name, classifications)]++;
  return counts;
}

/** Totals across a set of associates — the numbers the dashboard headlines. */
export function totals(associates) {
  const sum = (key) => (associates || []).reduce((s, a) => s + (a[key] || 0), 0);
  const picks = sum("picked_qty");
  const hours = sum("hours");
  return {
    associates:     (associates || []).length,
    picks,
    exceptionPicks: sum("exception_picks"),
    hours:          Math.round(hours * 10) / 10,
    nil:            sum("nil_qty"),
    sub:            sum("sub_qty"),
    avgPickRate:    hours > 0 ? Math.round(picks / hours) : 0,
  };
}
