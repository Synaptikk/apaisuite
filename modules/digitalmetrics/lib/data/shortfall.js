// modules/digitalmetrics/lib/data/shortfall.js
//
// Where digital's pick hours went, per day: the original plan (WFM schedule,
// because TLs erase call-ins from the board live — the saved board is always
// post-absence) against what was delivered, split into buckets. Pure.
//
// Ground rules fitted with the user on 2026-09-23 (dev/dm-shortfall.mjs is
// the ad-hoc twin of this file):
//   • Every digital call-out costs pick hours regardless of assigned task —
//     a dispenser's no-show pulls a picker onto dispensing.
//   • Coaches and TLs are salaried overseers: no punches, no task capacity.
//   • A lunch landing on an assigned pick hour is normal, not a failure:
//     it reduces the plan instead of blaming the associate.
//   • Top-20%-rate pickers bag their own items after walks; their missing
//     pick time is acceptable ("bagging-exempt"), not leakage.

import { effectiveAssignedHours, findAssignmentMatch } from "./adherence.js";
import { isDigitalJob, leadershipForJob } from "./job_classify.js";

const SLOT0_MIN = 5 * 60;             // slot 0 = 5–6am (grid.js)
const LONG_MEAL_MIN = 70;             // >1:10 is an excessive lunch
const FAST_SHARE = 0.2;               // top 20% by rate are bagging-exempt
const SLOW_FACTOR = 0.85;             // <85% of team rate reads as slow

const r1 = (v) => Math.round(v * 10) / 10;
const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/** Shift length in hours from a schedule record, less an hour's lunch on 7+. */
function scheduledShiftHours(a) {
  const h = (a.endSlot ?? 0) - (a.startSlot ?? 0) + 1;
  return h >= 7 ? h - 1 : h;
}

const pickSlotIndexes = (row) => Object.entries(row.slots || {})
  .filter(([, t]) => String(t).toLowerCase() === "pick")
  .map(([k]) => parseInt(k, 10)).sort((a, b) => a - b);

const taskSlotCount = (row) => Object.values(row.slots || {})
  .filter((t) => !["l", "b", ""].includes(String(t).toLowerCase())).length;

/** Pick-slot hours outside the punch window or inside the meal, in hours. */
function missedPickHours(pickSlots, clock) {
  if (clock?.clockIn == null || clock?.clockOut == null) return 0;
  let missed = 0;
  for (const k of pickSlots) {
    const s0 = SLOT0_MIN + k * 60, s1 = s0 + 60;
    missed += Math.max(0, Math.min(clock.clockIn, s1) - s0);
    missed += Math.max(0, s1 - Math.max(clock.clockOut, s0));
    if (clock.mealOut != null && clock.mealIn != null)
      missed += overlap(s0, s1, clock.mealOut, clock.mealIn);
  }
  return missed / 60;
}

/**
 * One day's ledger.
 *
 * @param roster     the board's associates array for the day (post-call-out)
 * @param schedule   the WFM schedule doc's associates array (pre-call-out)
 * @param clockDay   { NAME: { clockIn, clockOut, mealOut, mealIn } } — this
 *                   day's punches; null/missing means "not pulled", NOT absent
 * @param actualByName  { NAME: { isoDate: pickHours } } (adherence.js)
 * @param iso        the day, for actualByName lookups
 * @returns { plan, delivered, buckets: { callin, reassigned, tardy, leftEarly,
 *            underPick }, people: { <bucket>: [{ name, hours, note }] },
 *            clockCoverage }
 */
export function dayShortfall(roster, schedule, clockDay, actualByName, iso) {
  const clock = clockDay || {};
  const clockPulled = Object.keys(clock).length > 0;
  const buckets = { callin: 0, reassigned: 0, tardy: 0, leftEarly: 0, underPick: 0 };
  const people = { callin: [], reassigned: [], tardy: [], leftEarly: [], underPick: [] };
  const add = (bucket, name, hours, note = "") => {
    if (hours < 0.1) return;
    buckets[bucket] += hours;
    people[bucket].push({ name, hours: r1(hours), note });
  };
  let plan = 0, delivered = 0;

  const onBoard = (name) =>
    (roster || []).some((r) => r.name === name) || !!findAssignmentMatch(name, roster || []);

  // Call-ins the TLs already erased: scheduled digital (not leadership), no
  // punches, not on the board. Their whole shift is plan AND deduction —
  // whatever they were going to do, their absence lands on picking.
  if (clockPulled) {
    for (const a of (schedule || []).filter((x) => isDigitalJob(x.jobName) && !leadershipForJob(x.jobName))) {
      if (!a.name || onBoard(a.name)) continue;
      const c = clock[a.name];
      if (c && (c.clockIn != null || c.clockOut != null)) continue;   // worked, just unboarded
      if (!(a.name in clock)) continue;                               // never matched in GTA — unknowable
      const hrs = scheduledShiftHours(a);
      plan += hrs;
      add("callin", a.name, hrs, "erased from board");
    }
  }

  for (const row of roster || []) {
    const name = row.name;
    if (!name) continue;
    const pickSlots = pickSlotIndexes(row);
    const c = clock[name];
    const noShow = row.status === "absent" ||
      (clockPulled && name in clock && c?.clockIn == null && c?.clockOut == null);

    if (!pickSlots.length) {
      // A no-show dispenser/stager still costs pick hours (someone covers).
      if (noShow) {
        const hrs = taskSlotCount(row);
        plan += hrs;
        add("callin", name, hrs, "non-pick tasks");
      }
      continue;
    }

    const rowPlan = effectiveAssignedHours({ ...row, status: null }, roster);
    if (!rowPlan) continue;

    let actual = actualByName?.[name]?.[iso];
    if (actual == null) {
      for (const [mn, byDay] of Object.entries(actualByName || {})) {
        if (byDay?.[iso] != null && findAssignmentMatch(mn, [row])) { actual = byDay[iso]; break; }
      }
    }
    actual = actual || 0;

    if (noShow && actual === 0) {
      plan += rowPlan;
      add("callin", name, rowPlan);
      continue;
    }

    // Pick hours they physically could not work (late in / out early), and
    // the lunch that landed on a pick hour, which quietly shrinks the plan.
    let late = 0, early = 0, lunch = 0;
    if (c?.clockIn != null && c?.clockOut != null) {
      for (const k of pickSlots) {
        const s0 = SLOT0_MIN + k * 60, s1 = s0 + 60;
        late  += Math.max(0, Math.min(c.clockIn, s1) - s0);
        early += Math.max(0, s1 - Math.max(c.clockOut, s0));
        if (c.mealOut != null && c.mealIn != null) lunch += overlap(s0, s1, c.mealOut, c.mealIn);
      }
      late /= 60; early /= 60; lunch /= 60;
    }
    const rowPlanNet = Math.max(0, rowPlan - Math.min(rowPlan, lunch));
    plan += rowPlanNet;
    delivered += actual;
    add("tardy", name, late);
    add("leftEarly", name, early);

    const missed = Math.min(rowPlanNet, late + early);
    const gap = Math.max(0, rowPlanNet - missed - actual);
    if (actual === 0) add("reassigned", name, gap, "worked, 0 picks");
    else add("underPick", name, gap);
  }

  for (const k of Object.keys(buckets)) buckets[k] = r1(buckets[k]);
  for (const k of Object.keys(people)) people[k].sort((a, b) => b.hours - a.hours);
  return { plan: r1(plan), delivered: r1(delivered), buckets, people, clockCoverage: clockPulled };
}

/**
 * Under-pick per associate across the loaded days, with the read that decides
 * whether it is a problem: bagging-exempt (top rates), multi-task bleed, slow,
 * or unexplained. `days` is dayShortfall-shaped inputs per iso date.
 */
export function underPickLeaders(dayInputs, rawRows) {
  // Mean per-day Pick Rate and exception items per metrics name.
  const rateByName = new Map();
  let last = null;
  for (const row of rawRows || []) {
    if (row["Pick Date"]) last = row["Pick Date"];
    const name = row.Associate;
    if (!name) continue;
    const rec = rateByName.get(name) || { rateSum: 0, rateDays: 0, excItems: 0 };
    if (typeof row["Pick Rate"] === "number" && row["Pick Rate"] > 0) { rec.rateSum += row["Pick Rate"]; rec.rateDays++; }
    rec.excItems += row["Exception Qty Req to Pick"] || 0;
    rateByName.set(name, rec);
  }

  const perPerson = new Map();
  for (const { roster, schedule, clockDay, actualByName, iso } of dayInputs || []) {
    const day = dayShortfall(roster, schedule, clockDay, actualByName, iso);
    for (const p of day.people.underPick) {
      const rec = perPerson.get(p.name) || { name: p.name, hours: 0, days: 0, otherSlots: 0 };
      rec.hours += p.hours; rec.days++;
      const row = (roster || []).find((r) => r.name === p.name);
      if (row) rec.otherSlots += Object.values(row.slots || {})
        .filter((t) => !["pick", "l", "b", ""].includes(String(t).toLowerCase())).length;
      perPerson.set(p.name, rec);
    }
  }

  const findRate = (boardName) => {
    for (const [mName, rec] of rateByName) {
      if (mName === boardName || findAssignmentMatch(mName, [{ name: boardName }]))
        return rec.rateDays ? { rate: Math.round(rec.rateSum / rec.rateDays), excItems: rec.excItems } : { rate: null, excItems: rec.excItems };
    }
    return { rate: null, excItems: 0 };
  };

  const list = [...perPerson.values()].map((p) => ({ ...p, hours: r1(p.hours), ...findRate(p.name) }));
  const rates = list.map((p) => p.rate).filter((v) => v != null).sort((a, b) => b - a);
  const fastCut = rates.length ? rates[Math.max(0, Math.ceil(rates.length * FAST_SHARE) - 1)] : Infinity;
  const teamRate = rates.length ? Math.round(rates.reduce((s, v) => s + v, 0) / rates.length) : 0;

  for (const p of list) {
    p.read = p.rate != null && p.rate >= fastCut ? "bagging"
      : p.otherSlots >= 4 || p.excItems > 100 ? "multi-task"
      : p.rate != null && p.rate < teamRate * SLOW_FACTOR ? "slow"
      : "leak";
  }
  list.sort((a, b) => b.hours - a.hours);

  const sumBy = (read) => r1(list.filter((p) => p.read === read).reduce((s, p) => s + p.hours, 0));
  return {
    list, fastCut, teamRate,
    totals: {
      all: r1(list.reduce((s, p) => s + p.hours, 0)),
      bagging: sumBy("bagging"), multiTask: sumBy("multi-task"),
      slow: sumBy("slow"), leak: sumBy("leak"),
    },
  };
}

/** Meal windows over LONG_MEAL_MIN across the loaded clock data. */
export function longMeals(clockByDate) {
  const out = [];
  for (const [iso, byName] of Object.entries(clockByDate || {})) {
    for (const [name, c] of Object.entries(byName || {})) {
      if (c?.mealOut == null || c?.mealIn == null) continue;
      const min = c.mealIn - c.mealOut;
      if (min > LONG_MEAL_MIN) out.push({ date: iso, name, minutes: min, over: min - 60 });
    }
  }
  return out.sort((a, b) => b.minutes - a.minutes);
}

/**
 * Plan vs volume vs delivery for one day — the capacity row. Rates are the
 * store's own demonstrated ones, passed in so a better week prices itself.
 */
export function capacityRow({ units, expressUnits = null, plan, delivered, helpHours = 0,
                              nonExpressRate = 93, expressRate = 60 }) {
  const required = expressUnits != null
    ? (units - expressUnits) / nonExpressRate + expressUnits / expressRate
    : units / nonExpressRate;
  return {
    required: r1(required),
    planVsRequired: r1(plan - required),
    deliveredVsRequired: r1(delivered + helpHours - required),
  };
}
