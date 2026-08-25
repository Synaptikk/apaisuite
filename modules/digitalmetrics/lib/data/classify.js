// modules/digitalmetrics/lib/data/classify.js
//
// Classification vocabulary and lookup. Pure.
//
// Meanings, because they drive benchmark maths elsewhere:
//   Digital      — dedicated digital fulfilment team
//   Exceptions   — digital associates mostly working exception picks; measured
//                  only against each other (see data/metrics.js)
//   Fashion      — apparel pickers; excluded from the pick-rate benchmark
//                  because their task mix makes the number incomparable
//   Store Help   — store associates helping out; different schedules, so
//                  excluded from 5am late-start analysis
//   Unclassified — not yet categorised

export const CLASSIFICATIONS = ["Digital", "Exceptions", "Fashion", "Store Help"];
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
