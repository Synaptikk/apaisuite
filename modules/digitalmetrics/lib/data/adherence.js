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

  const startSlot = assignment.startSlot ?? 0;
  const endSlot   = assignment.endSlot   ?? 16;

  const halfHour = (v) => {
    const s = String(v || "");
    return s.includes(":") && !s.includes(":00");
  };
  const halfStart = halfHour(assignment.shiftStart);
  const halfEnd   = halfHour(assignment.shiftEnd);

  let hours = 0;
  for (const [slot, task] of Object.entries(assignment.slots)) {
    if (String(task).toLowerCase() !== "pick") continue;
    const idx = parseInt(slot, 10);
    if (idx > LAST_PICK_SLOT) continue;

    if      (idx === startSlot && halfStart) hours += 0.5;
    else if (idx === endSlot   && halfEnd)   hours += 0.5;
    else                                      hours += 1;
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
  const shift = (assignment.endSlot ?? 16) - (assignment.startSlot ?? 0) + 1;
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
