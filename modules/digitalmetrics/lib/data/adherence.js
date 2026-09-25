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

// ── Breaks ───────────────────────────────────────────────────────────────
//
// How the store actually breaks (the user, 2026-09-23): a 15 every two hours.
// A full 9-hour shift takes a 15 near the 2-hour mark, then lunch, then a 15
// two hours after lunch; a 6-hour shift takes one 15 in the middle. So a
// break costs pick time only when the hour it falls in is assigned to Pick —
// a break taken during Dispense costs nothing.
//
// This replaced a prorated allowance (15 or 30 minutes spread across the day,
// only when picking was over half the shift), which charged a break to the
// pick total whether or not the break hour was a pick hour.
const BREAK_HOURS            = 0.25;
const TWO_BREAKS_FROM_HOURS  = 7;   // worked hours, lunch excluded: a 9h shift = 8
const ONE_BREAK_FROM_HOURS   = 3;

/** [start, end) slots of the shift, from whichever shape this row is. */
function shiftBounds(a) {
  // A schedule record's endSlot is inclusive; a saved assignment's shiftEnd is
  // exclusive (see effectiveAssignedHours below for the history).
  if (a.startSlot != null || a.endSlot != null) return [a.startSlot ?? 0, (a.endSlot ?? 16) + 1];
  if (typeof a.shiftStart === "number" && typeof a.shiftEnd === "number") return [a.shiftStart, a.shiftEnd];
  const filled = Object.keys(a.slots || {}).map(Number).sort((x, y) => x - y);
  return filled.length ? [filled[0], filled.at(-1) + 1] : null;
}

/**
 * The slots an associate's 15-minute breaks are expected to fall in.
 *
 * Explicit "B" cells on the board win: the planner already placed the breaks,
 * and those hours are not Pick hours to begin with, so nothing is predicted.
 */
export function breakSlots(assignment) {
  const slots = assignment?.slots || {};
  const bounds = shiftBounds(assignment || {});
  if (!bounds) return [];
  const [start, end] = bounds;

  const task = (k) => String(slots[k] ?? "").toUpperCase();
  if (Object.keys(slots).some((k) => task(k) === "B")) return [];

  const lunchKey = Object.keys(slots).map(Number).sort((x, y) => x - y)
    .find((k) => k >= start && k < end && task(k) === "L");
  const worked = end - start - (lunchKey != null ? 1 : 0);

  let out = [];
  if (worked >= TWO_BREAKS_FROM_HOURS) {
    // "Near the 2-hour mark" is the boundary after the second hour; the break
    // is booked to that second hour. Likewise two hours after lunch.
    const second = lunchKey != null ? lunchKey + 2 : start + Math.round((end - start) * 2 / 3);
    out = [start + 1, second];
  } else if (worked >= ONE_BREAK_FROM_HOURS) {
    out = [start + Math.max(0, Math.floor((end - start) / 2) - 1)];
  }
  return out.filter((k) => k >= start && k < end);
}

// ── Staggered breaks ─────────────────────────────────────────────────────
//
// Nobody sends the whole team to break at once (the user, 2026-09-23): the
// people due a 15 at the same point are split between a quarter to the hour,
// on the hour, and a quarter past, rotating in roster order. breakSlots() gives
// the hour a break ENDS by; the stagger decides the minute:
//
//   :45 — the last quarter of that hour          (costs that hour)
//   :00 — the first quarter of the next hour     (costs the next hour)
//   :15 — the second quarter of the next hour    (costs the next hour)
//
// Without a roster there is nobody to stagger against, so every break is :45 —
// exactly the hour breakSlots() books it to.
const STAGGER_MINUTES = [45, 0, 15];
const SLOT_START_HOUR = 5;           // slot 0 = 5–6am (see grid.js)

function clockLabel(slot, minute) {
  const h24 = SLOT_START_HOUR + slot;
  const h12 = ((h24 + 11) % 12) + 1;
  return `${h12}:${String(minute).padStart(2, "0")}`;
}

/**
 * Each expected 15 for this associate, staggered against the day's roster:
 * [{ slot, minute, label }] where `slot` is the hour the break falls in.
 */
export function breakTimes(assignment, roster = null) {
  const own = breakSlots(assignment);
  if (!own.length) return [];
  const bounds = shiftBounds(assignment) || [0, 0];

  // Everyone on the roster who is here and due a break at the same boundary,
  // in roster order. The associate's place in that line picks the minute.
  const present = (roster || []).filter((r) => r && r.status !== "absent");
  return own.map((slot) => {
    let rank = 0;
    if (present.length) {
      const line = present.filter((r) => breakSlots(r).includes(slot));
      rank = Math.max(0, line.findIndex((r) => r === assignment || r.name === assignment.name));
    }
    let minute = STAGGER_MINUTES[rank % STAGGER_MINUTES.length];
    // :00 and :15 land in the next hour; if the shift is over by then, go early.
    if (minute !== 45 && slot + 1 >= bounds[1]) minute = 45;
    const at = minute === 45 ? slot : slot + 1;
    return { slot: at, minute, label: clockLabel(at, minute) };
  });
}

/** Pick hours lost to breaks: 15 minutes per break that lands on a Pick hour. */
export function breakPickHours(assignment, roster = null) {
  const slots = assignment?.slots || {};
  return breakTimes(assignment, roster)
    .filter(({ slot: k }) => k <= LAST_PICK_SLOT && String(slots[k] ?? "").toLowerCase() === "pick")
    .length * BREAK_HOURS;
}

/** Assigned pick hours net of breaks. Floored to avoid ÷0. */
export function effectiveAssignedHours(assignment, roster = null) {
  const pick  = assignedPickHours(assignment);
  if (pick === 0) return 0;
  // Shift shape matters here, and the two DISAGREE about what the end index
  // means, which is the trap:
  //
  //   schedule record : startSlot/endSlot, endSlot INCLUSIVE  → end - start + 1
  //   saved assignment: shiftStart/shiftEnd, shiftEnd EXCLUSIVE → end - start
  //                     (the grid tests idx < shiftEnd)
  //
  // Reading only the schedule pair once meant a saved day measured as the
  // whole 17-slot grid. shiftBounds() handles both.
  return Math.max(0.25, pick - breakPickHours(assignment, roster));
}

/**
 * Adherence per associate.
 *
 * @param associates      aggregated records (needs `.name`)
 * @param assignmentsByDate  { dateKey: { associates: [...] } }
 * @param actualByName    { name: { dateKey: hours } } — same keys (dateKey())
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

      const effective = effectiveAssignedHours(match, doc?.associates);
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

/**
 * Assigned vs actual pick hours for a week, by day and by associate.
 *
 * Unlike calculateAdherence(), a day with pick hours assigned and none picked
 * is KEPT (as 0 actual): this is the plain ledger of what was planned and what
 * happened, for spotting "assigned 6 hours, picked 3". Assigned hours are net
 * of expected breaks (effectiveAssignedHours), so a full day of Pick with two
 * 15s on it reads 7.5, not 8.
 *
 * Only Digital and Exceptions associates, as in calculateAdherence. Someone
 * assigned Pick who never appears in the metrics is included by their
 * assignment name, with 0 actual.
 *
 * @param assignmentsByDate  { isoDate: { associates } }
 * @param actualByName       actualPickHoursByName() output
 * @param classifications    { name: classification }
 * @returns {{ days: [{date, assigned, actual, people}], people: [{name, byDate, assigned, actual}] }}
 */
export function weekPickBreakdown(assignmentsByDate, actualByName, classifications = {}) {
  const isPicker = (n) => ["Digital", "Exceptions"].includes(classifications[n]);
  const dates = Object.keys(assignmentsByDate || {}).sort();
  const people = new Map();
  const person = (name) => people.get(name) || people.set(name, { name, byDate: {}, assigned: 0, actual: 0 }).get(name);

  for (const date of dates) {
    const roster = assignmentsByDate[date]?.associates || [];
    const claimed = new Set();

    // Metrics side first: everyone who picked, matched to their assignment row.
    for (const [name, byDay] of Object.entries(actualByName || {})) {
      if (!isPicker(name)) continue;
      const actual = byDay?.[date] || 0;
      const row = findAssignmentMatch(name, roster);
      const assigned = row ? effectiveAssignedHours(row, roster) : 0;
      if (row) claimed.add(row.name);
      if (!actual && !assigned) continue;
      const p = person(name);
      p.byDate[date] = { assigned, actual };
      p.assigned += assigned; p.actual += actual;
    }
    // Assigned Pick, never picked, not in the metrics at all.
    for (const row of roster) {
      if (claimed.has(row.name) || row.status === "absent") continue;
      const assigned = effectiveAssignedHours(row, roster);
      if (!assigned) continue;
      if (Object.keys(classifications).length && classifications[row.name] && !isPicker(row.name)) continue;
      const p = person(row.name);
      p.byDate[date] = { assigned, actual: 0 };
      p.assigned += assigned;
    }
  }

  const r1 = (n) => Math.round(n * 10) / 10;
  const list = [...people.values()].map((p) => ({ ...p, assigned: r1(p.assigned), actual: r1(p.actual) }));
  return {
    days: dates.map((date) => {
      const rows = list.map((p) => p.byDate[date]).filter(Boolean);
      return {
        date,
        assigned: r1(rows.reduce((t, r) => t + r.assigned, 0)),
        actual:   r1(rows.reduce((t, r) => t + r.actual, 0)),
        people:   rows.length,
      };
    }),
    people: list,
  };
}

/**
 * Picking vs exception work, per associate, for a week.
 *
 * The two are measured differently, which is why they are shown apart rather
 * than folded into one classification (the user, 2026-09-23):
 *   - Picking: the board's PICK hours against the metrics' "Pick Hours".
 *   - Exceptions: the board's EXC hours against exception ITEM counts. The
 *     metrics' Pick Hours do not include exception time (checked 2026-09-23
 *     at 1458: 9 EXC hours and 1 PICK hour on the board, 1.58 Pick Hours in
 *     the metrics), so exception work only shows up as quantities.
 * "Picked As Req Qty" is regular items only; exception items are separate
 * columns (an exception-heavy day has more exception picks than regular).
 *
 * Everyone with EXC hours on the board, or exception items in the metrics.
 *
 * @returns {Array<{name, excHours, excReq, excPicked, excNil, excSub,
 *   pickAssigned, pickActual, regItems, days}>} most EXC hours first
 */
export function exceptionSplit(assignmentsByDate, rawData) {
  const metrics = {};
  let last = null;
  for (const row of rawData || []) {
    const date = row["Pick Date"] ? dateKey(row["Pick Date"]) : last;
    if (row["Pick Date"]) last = date;
    if (!row.Associate || !date) continue;
    (metrics[row.Associate] ||= {})[date] = row;
  }

  const n = (v) => Number(v) || 0;
  const out = new Map();
  const get = (name) => out.get(name) || out.set(name, {
    name, excHours: 0, excReq: 0, excPicked: 0, excNil: 0, excSub: 0,
    pickAssigned: 0, pickActual: 0, regItems: 0, days: new Set(),
  }).get(name);

  const dates = new Set([...Object.keys(assignmentsByDate || {}),
    ...Object.values(metrics).flatMap((m) => Object.keys(m))]);
  for (const date of dates) {
    const roster = assignmentsByDate?.[date]?.associates || [];
    const claimed = new Set();
    const add = (name, row, m) => {
      const excHours = row
        ? Object.values(row.slots || {}).filter((t) => /^EXC/i.test(String(t))).length : 0;
      const excReq = n(m?.["Exception Qty Req to Pick"]);
      if (!excHours && !excReq) return;
      const e = get(name);
      e.days.add(date);
      e.excHours += excHours;
      e.excReq += excReq;
      e.excPicked += n(m?.["Exception Picked As Req Qty"]);
      e.excNil += n(m?.["Exception Nil Pick Qty"]);
      e.excSub += n(m?.["Exception Substitution Qty"]);
      e.pickAssigned += row ? effectiveAssignedHours(row, roster) : 0;
      e.pickActual += n(m?.["Pick Hours"]);
      e.regItems += n(m?.["Picked As Req Qty"]);
    };
    for (const [name, byDate] of Object.entries(metrics)) {
      const m = byDate[date];
      if (!m) continue;
      const row = findAssignmentMatch(name, roster);
      if (row) claimed.add(row.name);
      add(name, row, m);
    }
    for (const row of roster) if (!claimed.has(row.name)) add(row.name, row, null);
  }

  const r1 = (x) => Math.round(x * 10) / 10;
  return [...out.values()]
    .map((e) => ({ ...e, days: e.days.size, pickAssigned: r1(e.pickAssigned), pickActual: r1(e.pickActual) }))
    .sort((a, b) => b.excHours - a.excHours || b.excReq - a.excReq);
}

/**
 * "9/19/26", "09/19/2026", "2026-09-19" → "2026-09-19"; anything else as is.
 *
 * The join key between assignments (ISO-dated documents) and metrics (Tableau's
 * "Pick Date", unpadded M/D/YY). Until 2026-09-23 the view built "09/19/26"
 * for one side and the metrics said "9/19/26", so no day in a single-digit
 * month ever matched and Pick Adherence was blank all September.
 */
export function dateKey(value) {
  const s = String(value ?? "").trim();
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
  if (us) {
    const y = us[3].length === 2 ? `20${us[3]}` : us[3];
    return `${y}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  }
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
}

/** Actual pick hours per associate per ISO date, forward-filling sparse dates. */
export function actualPickHoursByName(rawData) {
  const out = {};
  let last = null;
  for (const row of rawData || []) {
    const date = row["Pick Date"] ? dateKey(row["Pick Date"]) : last;
    if (row["Pick Date"]) last = date;
    const name = row.Associate;
    if (!name || !date) continue;
    (out[name] ||= {})[date] = row["Pick Hours"] || 0;
  }
  return out;
}
