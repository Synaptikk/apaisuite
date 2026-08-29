// modules/digitalmetrics/lib/data/adherence.js
//
// Pick adherence: how much of an associate's ASSIGNED pick time they actually
// spent picking. Pure — takes assignment documents and metric rows, returns
// numbers.
//
// Operates on plaintext names throughout. That is safe because lib/firestore.js
// decodes on read, and it is necessary because the matching below is fuzzy —
// tokens are exact-match only and could never do this. This is the reason
// canonicalisation lives at the storage boundary rather than here.

import { slotCoverage } from "./grid.js";

const LAST_PICK_SLOT   = 13;    // 6–7pm; nothing meaningful is picked after
const LOW_ADHERENCE     = 70;   // <70% is flagged as 30%+ under target
const LONG_SHIFT_HOURS  = 6;    // >6h earns a 30-minute break, else 15

/**
 * Match a metrics name against the assignment roster.
 *
 * The two sources are written by different people at different times: metrics
 * carry full names ("QUINCY QUILL"), assignments are typed by hand and are
 * often a first name, or a first name plus a last initial.
 *
 * Ordered most- to least-specific, and deliberately stops at the first hit —
 * "QUINCY" must not win over "QUINCY Q" when both exist.
 */
export function findAssignmentMatch(metricsName, roster) {
  const name = String(metricsName || "").trim().toUpperCase();
  if (!name || !Array.isArray(roster)) return null;

  const parts   = name.split(/\s+/);
  const first   = parts[0];
  const initial = parts.length > 1 ? parts[1][0] : "";

  const find = (target) =>
    roster.find((a) => a.name && a.name.trim().toUpperCase() === target) || null;

  return find(name)
      || (initial ? find(`${first} ${initial}`) : null)
      || find(first);
}

/**
 * Hours of "Pick" assigned to one associate on one day.
 *
 * Slots are hourly, except that a shift starting or ending on a half hour makes
 * its first/last slot count a half. Evening slots are ignored entirely.
 */
export function assignedPickHours(assignment) {
  if (!assignment?.slots) return 0;

  // An absent associate was assigned nothing they could do. Billing them for
  // the plan and then measuring zero picks against it manufactures a
  // performance problem out of a day off.
  if (assignment.status === "absent") return 0;

  // Whether this row knows its shift at all. An associate added by hand, or one
  // whose schedule never imported, has tasks but no window — and a task is
  // still assigned work whether or not we know the hours around it. Without
  // this the coverage below returns 0 for every slot and their adherence
  // denominator silently vanishes.
  const bounded = typeof assignment.shiftStart === "number"
               && typeof assignment.shiftEnd === "number";

  let hours = 0;
  for (const [slot, task] of Object.entries(assignment.slots)) {
    if (String(task).toLowerCase() !== "pick") continue;
    const idx = parseInt(slot, 10);
    if (idx > LAST_PICK_SLOT) continue;

    if (!bounded) { hours += 1; continue; }

    // The SAME coverage the grid's staffing line uses. This used to be a
    // private copy that sniffed ":" on assignment.shiftStart — which works on
    // a SCHEDULE record, where that field is "5:40am", and never on a saved
    // ASSIGNMENT, where it is a slot index. So halfStart/halfEnd were always
    // false and startSlot/endSlot never existed: every pick slot billed a
    // whole hour. An 8-slot day that is really 7.5 hours was charged as 8,
    // against actual pick time measured to the minute — a built-in adherence
    // deficit for everyone whose shift does not start on the hour.
    hours += slotCoverage(assignment, idx);
  }
  return hours;
}

/**
 * Break time to discount from assigned pick hours.
 *
 * Only applies when picking is the majority of the shift: an associate who
 * picks for one hour of a six-hour shift takes their break on someone else's
 * time, so charging it against picking would understate their adherence. The
 * allowance is prorated by how much of the shift is picking.
 */
export function breakAllowance(pickHours, shiftHours) {
  if (!(shiftHours > 0)) return 0;
  const share = pickHours / shiftHours;
  if (share <= 0.5) return 0;
  return (shiftHours > LONG_SHIFT_HOURS ? 0.5 : 0.25) * share;
}

/** Assigned pick hours net of the break allowance. Floored to avoid ÷0. */
export function effectiveAssignedHours(assignment) {
  const pick  = assignedPickHours(assignment);
  if (pick === 0) return 0;
  // Shift length, from whichever shape this row is — and the two DISAGREE about
  // what the end index means, which is the trap here:
  //
  //   schedule record : startSlot/endSlot, endSlot INCLUSIVE  → end - start + 1
  //   saved assignment: shiftStart/shiftEnd, shiftEnd EXCLUSIVE → end - start
  //                     (the grid tests idx < shiftEnd)
  //
  // Reading only the schedule pair meant a saved day fell through to the
  // defaults and measured as the whole 17-slot grid, so the break allowance —
  // prorated by how much of the SHIFT is picking — was computed against a
  // shift nobody worked, and came out near zero every time.
  const scheduleShape = assignment.startSlot != null || assignment.endSlot != null;
  const shift = scheduleShape
    ? (assignment.endSlot ?? 16) - (assignment.startSlot ?? 0) + 1
    : Math.max(1, (assignment.shiftEnd ?? 17) - (assignment.shiftStart ?? 0));
  return Math.max(0.25, pick - breakAllowance(pick, shift));
}

/**
 * Adherence per associate.
 *
 * @param associates      aggregated records (needs `.name`)
 * @param assignmentsByDate  { "MM/DD/YY": { associates: [...] } }
 * @param actualByName    { name: { "MM/DD/YY": hours } }
 * @param classifications { name: classification }
 */
export function calculateAdherence(associates, assignmentsByDate, actualByName, classifications = {}) {
  const out = {};

  for (const { name } of associates || []) {
    // Only Digital and Exceptions are scheduled to pick. Including the others
    // would both mean nothing and, because matching is fuzzy, risk pairing a
    // store helper with a digital associate who shares a first name.
    const cls = classifications[name] || "";
    if (cls !== "Digital" && cls !== "Exceptions") continue;

    let assigned = 0, actual = 0, days = 0;
    const daily = [];

    for (const [date, doc] of Object.entries(assignmentsByDate || {})) {
      const match = findAssignmentMatch(name, doc?.associates);
      if (!match) continue;

      const slots = assignedPickHours(match);
      if (slots === 0) continue;

      const effective = effectiveAssignedHours(match);
      const actualHrs = actualByName?.[name]?.[date] || 0;

      // A scheduled picker with zero recorded pick time was moved to another
      // task; counting it as 0% adherence would punish a decision they did not
      // make. Skipped, as in the donor.
      if (actualHrs === 0) continue;

      assigned += effective;
      actual   += actualHrs;
      days++;

      daily.push({
        date,
        assignedSlots:  slots,
        effectiveHours: effective,
        actualHours:    actualHrs,
        adherence:      effective > 0 ? Math.round((actualHrs / effective) * 100) : 100,
      });
    }

    if (days > 0 && assigned > 0) {
      const adherence = Math.round((actual / assigned) * 100);
      out[name] = {
        assignedHours:   Math.round(assigned * 10) / 10,
        actualHours:     Math.round(actual * 10) / 10,
        adherence,
        daysWithData:    days,
        dailyDetails:    daily,
        isLowAdherence:  adherence < LOW_ADHERENCE,
      };
    }
  }
  return out;
}

/** Actual pick hours per associate per date, forward-filling sparse dates. */
export function actualPickHoursByName(rawData) {
  const out = {};
  let last = null;
  for (const row of rawData || []) {
    const date = row["Pick Date"] || last;
    if (row["Pick Date"]) last = row["Pick Date"];
    const name = row.Associate;
    if (!name || !date) continue;
    (out[name] ||= {})[date] = row["Pick Hours"] || 0;
  }
  return out;
}
