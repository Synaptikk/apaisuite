// modules/digitalmetrics/lib/pages/faq.js
//
// Static reference. The definitions here must stay in step with
// data/metrics.js and data/adherence.js — they are the same rules in prose,
// and people make staffing decisions on them.

import { section } from "./_shared.js";

const ENTRIES = [
  ["FTPR (First Time Pick Rate)",
   "FTP Actual ÷ FTP Expected. Exception picks are included in both halves."],
  ["Pick Rate",
   "The unweighted mean of the daily Pick Rate column — a short day counts as much as a long one. It is not total picks ÷ total hours."],
  ["Nil Rate",
   "Nil Pick Qty ÷ Picked As Req Qty. Items that could not be found."],
  ["Sub Rate",
   "Substitution Qty ÷ Picked As Req Qty. Items swapped for something else."],
  ["Pick Adherence",
   "Actual pick hours ÷ assigned pick hours, flagged below 70%. Assigned hours are net of a break allowance: 30 minutes for shifts over 6 hours, 15 minutes otherwise, and only when picking is more than half the shift. Days scheduled to pick with no recorded pick time are skipped rather than scored as zero, since those are task swaps."],
  ["Exceptions classification",
   "Auto-flagged at 20% or more exception work. Exception pickers are benchmarked only against other exception pickers."],
  ["Fashion classification",
   "Excluded from the pick-rate benchmark — the task mix makes the number incomparable — but still counted in FTPR."],
  ["Late starts",
   "For 5am associates only, based on first scan. 5:00–5:50 counts as a 5am start; 5:51 and later reads as an early 6am start. Store Help and Fashion are excluded, since they work different schedules."],
  ["Week numbering",
   "Weeks run Saturday to Friday and are keyed by the Saturday. Week 1 of a fiscal year is the week containing Feb 1 — a retail calendar, not an ISO one."],
  ["Where are the names?",
   "Associate names are never stored in the database. Each associate is written as a token plus an encrypted display name, decrypted in your browser. See the privacy documentation for what that does and does not protect."],
];

export function render() {
  return section("FAQ", `<dl class="dm-faq">${
    ENTRIES.map(([term, def]) => `<dt>${term}</dt><dd>${def}</dd>`).join("")
  }</dl>`);
}
