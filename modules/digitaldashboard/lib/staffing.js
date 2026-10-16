// modules/digitaldashboard/lib/staffing.js
//
// "Will the pickers on the board get through the picks in the system, and if
// not, how many do we add each hour?" Pure, so the SW, the !commands and the
// tests share it.
//
// Model (deliberately simple, stated in the UI):
//   - Work: every item still to pick in GIF's OPD Hourly — open hours (total −
//     picked) and Upcoming Picks (qty to pick) — is due PICK_LEAD_MIN (30) before
//     its slot starts: "12pm - 1pm" orders must be picked by 11:30 (store rule,
//     user 2026-10-09).
//   - Already-late items (slot start has passed) are due by the end of the
//     current hour.
//   - Express that hasn't dropped yet: express orders land until :15 past each
//     hour and are due by the next hour (user, 2026-10-09), so each hour also
//     carries the express still expected — a full hourly express average for
//     later hours, the unexpired share of the drop window for this one.
//   - Pick window: an hour's picks can only be started PICK_AHEAD_MIN (2 h)
//     before the slot starts and are due 30 min before it (user, 2026-10-09):
//     the 3pm orders are picked 1:00-2:30.
//   - Who counts for which orders (user, 2026-10-09):
//       now   = the first open due time: everyone GIF shows picking right now.
//       next  = the one after: only if pickers have already started it (GIF
//               shows items picked), and then only the live pickers the "now"
//               orders don't need; not started yet = its scheduled pickers.
//       later = 2+ hours out: the board's scheduled pickers for the hour the
//               orders are picked in (slot - 2 h), against one hour of picking
//               at GIF's live rate — "18 scheduled, need 23 -> add 5".
//     Live pickers are never counted against future hours.
//   - Rate: GIF's live store "Avg pick rate" for the day (e.g. 95.42), used
//     as-is (it already reflects volume, performance and walking); only the
//     fallback default rate is discounted by util.
//   - Under 10 min to a due time, adding pickers can't help: "a few min late".

import { parseSlot, SLOT_START_HOUR } from "./gif_metrics.js";

export const DEFAULT_RATE = 95;    // items/hr while picking, when GIF has not given one
export const DEFAULT_UTIL = 0.85;  // discount on the DEFAULT rate only (GIF's live rate is used as-is)
export const PICK_LEAD_MIN = 30;   // picks are due this long before their slot starts
export const PICK_AHEAD_MIN = 120; // picks can't be started earlier than this before their slot starts
export const BETWEEN_WALKS_MIN = 10; // not active this long or less = between pick walks (~5 normal, user 2026-10-09)

/**
 * GIF's "Picking" count only covers people inside a pick walk, so anyone
 * dropping totes / staging / grabbing a cart drops out of it. Add the
 * scheduled pickers the break watch sees on Not active for under 10 min (their
 * last scan is read once per inactive stretch). Only a recent watch counts.
 * → null | { picking, betweenWalks, active, names }
 */
export function activePickers({ picking, watch, now = new Date(), gapMin = BETWEEN_WALKS_MIN, maxWatchAgeMin = 6 } = {}) {
  if (!Number.isFinite(picking)) return null;
  const age = watch?.checkedAt ? (now - Date.parse(watch.checkedAt)) / 60_000 : Infinity;
  const between = age <= maxWatchAgeMin
    ? (watch.suspects || []).filter((x) => x.idleMin != null && x.idleMin + Math.max(0, age) < gapMin) : [];
  return { picking, betweenWalks: between.length, active: picking + between.length, names: between.map((x) => x.name) };
}

/** Pickers the live output is worth: items/hr over the last hour ÷ GIF's per-person rate. */
export function outputPickers(perHour, rate) {
  return perHour > 0 && rate > 0 ? Math.round(perHour / rate) : null;
}

const isPick = (t) => String(t ?? "").trim().toUpperCase() === "PICK";

/** Grid roster → { [hour 0-23]: pickers on PICK }. Absent rows don't count. */
export function pickersByHour(roster) {
  const out = {};
  for (const r of roster || []) {
    if (!r?.name || r.status === "absent") continue;
    // The board stores slots as an index-keyed object ({ "0": "PICK", … },
    // 0 = 5 AM — what pickersNow reads with slots[k]); arrays work too.
    for (const [k, cell] of Object.entries(r.slots || {})) {
      const h = SLOT_START_HOUR + Number(k);
      if (Number.isInteger(h) && isPick(cell)) out[h] = (out[h] || 0) + 1;
    }
  }
  return out;
}

/** 13 → "1pm", 0 → "12am". */
export function hourLabel(h) {
  const hh = ((h % 24) + 24) % 24;
  return `${hh % 12 || 12}${hh < 12 ? "am" : "pm"}`;
}

/** Items still to pick: due by slot start − 30 min, workable from slot start − 2 h. */
export function dueItems({ open = [], upcoming = [] } = {}, leadMin = PICK_LEAD_MIN, aheadMin = PICK_AHEAD_MIN) {
  const out = [];
  for (const h of open) {
    const s = parseSlot(h.slot);
    const left = Number.isFinite(h.left) ? h.left
      : Number.isFinite(h.total) && Number.isFinite(h.picked) ? h.total - h.picked : null;
    if (s && left > 0) out.push({ slot: h.slot, by: s.start - leadMin, from: s.start - aheadMin, qty: left, started: h.picked > 0,
      // pickers with an active pick walk on this hour (GIF hour detail; phone app ≥ 0.1.1)
      walkers: Array.isArray(h.walkers) ? h.walkers.length : null });
  }
  for (const u of upcoming) {
    const s = parseSlot(u.slot);
    if (s && u.qty > 0) out.push({ slot: u.slot, by: s.start - leadMin, from: s.start - aheadMin, qty: u.qty });
  }
  return out.sort((a, b) => a.by - b.by);
}

/**
 * @param {{ open?: object[], upcoming?: object[], roster?: object[], rate?: number,
 *           util?: number, now?: Date }} p
 * @returns {null | { rate, util, perPicker, rows: object[], totalItems, addPeak,
 *           firstShortHour, verdict: "ok"|"short", noGrid: boolean, rateFromGif: boolean }}
 */
export const EXPRESS_DROP_UNTIL_MIN = 15;   // express can drop in until :15 past the hour

/** Express items still expected to drop in that are due by the end of hour `h` (window ends h:15, due (h+1):00). */
export function expressStillExpected(h, nowMin, perHour) {
  if (!(perHour > 0)) return 0;
  const windowEnd = h * 60 + EXPRESS_DROP_UNTIL_MIN, windowStart = windowEnd - 60;
  const left = Math.min(60, Math.max(0, windowEnd - Math.max(windowStart, nowMin)));
  return Math.round(perHour * left / 60);
}

export function staffingPlan({ open = [], upcoming = [], roster = [], rate, util, pickingNow, active = null, output = null, expressPerHour, now = new Date() } = {}) {
  const items = dueItems({ open, upcoming });
  if (!items.length) return null;
  const rateFromGif = Number.isFinite(rate) && rate > 0;
  util = util ?? (rateFromGif ? 1 : DEFAULT_UTIL);
  const r = rateFromGif ? rate : DEFAULT_RATE;
  const perPicker = r * util;
  const sched = pickersByHour(roster);
  const noGrid = !Object.keys(sched).length;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  // active = picking + between walks when the break watch is fresh, else GIF's picking count
  const live = active?.active ?? (Number.isFinite(pickingNow) ? pickingNow : null);
  const expressFor = (h) => (expressPerHour > 0 ? expressStillExpected(h, nowMin, expressPerHour) : 0);

  // one row per due time (several slots can share one only in odd data)
  const byDue = new Map();
  for (const it of items) {
    const g = byDue.get(it.by) || { by: it.by, from: it.from, slots: [], qty: 0, started: false, walkers: null };
    g.slots.push(it.slot); g.qty += it.qty; g.started ||= !!it.started; g.from = Math.min(g.from, it.from);
    if (it.walkers != null) g.walkers = (g.walkers || 0) + it.walkers;
    byDue.set(it.by, g);
  }
  const groups = [...byDue.values()].sort((x, y) => x.by - y.by);
  const rows = [];
  let liveLeft = live, kindIdx = 0, heldFor = null;   // heldFor: the live pickers the "now" orders keep
  for (const g of groups) {
    const base = { by: g.by, slots: g.slots, left: g.qty, dueThisHour: g.qty, started: g.started };
    if (g.by <= nowMin) {
      rows.push({ ...base, kind: "past", label: "past due", pastDue: true, late: true, add: 0, needed: 0, have: null,
        scheduled: sched[now.getHours()] || 0, basis: "past", slack: -g.qty, canPickThisHour: 0, expressExpected: 0 });
      continue;
    }
    // now / next / later, counted among the due times still ahead
    // next = the hour after, once pickers are on it (walk cards, or items picked when walks weren't read)
    const onNext = g.walkers != null ? g.walkers > 0 : (g.started || g.from <= nowMin);
    const kind = kindIdx === 0 ? "now" : kindIdx === 1 && onNext ? "next" : "later";
    kindIdx++;
    const pickHour = Math.floor(g.from / 60);              // the hour these orders are mostly picked in
    // the board for the hour that matters: this hour for the orders being picked now/next, else the pick hour
    const scheduled = kind === "later" ? sched[pickHour] || 0 : sched[now.getHours()] || 0;
    let minutes, have, basis;
    if (kind === "later") {
      minutes = 60; have = scheduled; basis = "scheduled";
    } else {
      minutes = g.by - Math.max(nowMin, g.from);
      // real per-hour pickers when GIF's hour detail was read: walk cards on that hour
      // (+ the scheduled pickers between walks, for the orders being picked now)
      if (g.walkers != null && kind === "now") { have = g.walkers + (active?.betweenWalks || 0); basis = "picking now"; }
      else if (g.walkers != null && kind === "next") { have = g.walkers; basis = "picking now"; }
      else if (kind === "now" && live != null) { have = live; basis = "picking now"; }
      else if (kind === "next" && g.started && liveLeft != null) { have = Math.max(0, liveLeft); basis = "picking now"; }
      else { have = sched[Math.floor(Math.max(nowMin, g.from) / 60)] || 0; basis = "scheduled"; }
    }
    const express = expressFor(pickHour);
    const work = g.qty + express;
    const hrs = Math.max(minutes, 1) / 60;
    const needed = Math.ceil(work / (perPicker * hrs));
    // the "now" orders keep the live pickers they need; the rest can be on the next hour's
    if (kind === "now" && liveLeft != null) { liveLeft = live - Math.min(live, needed); heldFor = { orders: slotList({ slots: g.slots }), needed: Math.min(live, needed) }; }
    const tooLate = kind !== "later" && minutes < PACE_ACTIONABLE_MIN;
    const gap = Math.max(0, needed - have);
    const canPick = Math.round(have * perPicker * hrs);
    rows.push({
      ...base, kind, label: `by ${clockLabel(g.by)}`, from: clockLabel(Math.max(nowMin, g.from)),
      opensAt: g.from > nowMin ? clockLabel(g.from) : null, pickHour, minutes: Math.round(minutes),
      scheduled, pickingNow: basis === "picking now" ? have : null, have, working: have, basis,
      needed, add: tooLate ? 0 : gap, late: tooLate && gap > 0, spare: Math.max(0, have - needed),
      ...(kind === "next" && basis === "picking now" && g.walkers == null ? { liveTotal: live, heldFor } : {}),
      walkers: g.walkers,
      canPickThisHour: canPick, expressExpected: express, slack: canPick - work,
    });
  }
  const short = rows.filter((x) => x.add > 0);
  return {
    rate: Math.round(r * 10) / 10, rateFromGif, util, perPicker: Math.round(perPicker),
    expressPerHour: expressPerHour > 0 ? Math.round(expressPerHour) : 0,
    rows, totalItems: items.reduce((t, it) => t + it.qty, 0),
    addPeak: Math.max(0, ...rows.map((x) => x.add)), firstShortHour: short.length ? short[0].pickHour : null,
    verdict: short.length ? "short" : "ok", noGrid, active, output,
  };
}

/** One line for chat (!summary / dashboard banner). */
export function staffingLine(plan) {
  if (!plan) return "Staffing: nothing left to pick in GIF.";
  if (plan.noGrid) return "Staffing: no pickers on today's board yet, so there's nothing to check against.";
  const last = plan.rows.at(-1);
  if (plan.verdict === "ok") return `Staffing: on track for everything due through ${last ? clockLabel(last.by) : "the day"} (${plan.totalItems.toLocaleString("en-US")} items left).`;
  const adds = plan.rows.filter((x) => x.add > 0).map((x) => x.basis === "picking now"
    ? `${slotList(x)}: get ${x.add} more picking now (${x.have} picking, need ${x.needed})`
    : `${slotList(x)}: add ${x.add} (${x.scheduled} scheduled ${hourLabel(x.pickHour)}-${hourLabel(x.pickHour + 1)}, need ${x.needed})`);
  return `Staffing: short. ${adds.join("; ")} (at ${Math.round(plan.rate)}/hr each).`;
}

const slotList = (x) => `${x.slots.map(slotHour).join(" + ")} orders`;

/**
 * Chat reply for !staffing: a header, then one line per due time, same shape
 * every time. Lines start with "-"; at-risk hours start with "⚠️" (user,
 * 2026-10-09: no other emojis). `pace` (slotPace rows) flags the "now" orders
 * when the live pick rate is falling behind.
 *
 *   Staffing @ 2:05pm - 6,805 left - 88/hr per picker
 *   - 3pm orders - due 2:30 - 252 left - scheduled 18 (active 20), need 3 - covered
 *   ⚠️ 4pm orders - due 3:30 (started) - 1,966 left - scheduled 18 (active 17), need 15 - add 8
 *   ⚠️ 5pm orders - 2,045 left - scheduled 21, need 25 - add 4
 */
export function staffingText(plan, now = new Date(), pace = [], roster = null) {
  const sched = roster ? scheduleLines(roster) : [];
  if (!plan || plan.noGrid) return [staffingLine(plan), ...sched].join("\n");
  const nf = (x) => Math.round(x).toLocaleString("en-US");
  const hm = (min) => clockLabel(min).replace(/(am|pm)$/, "");   // "1:30"
  const paceBy = Object.fromEntries((pace || []).map((p) => [p.slot, p]));
  const head = `Staffing @ ${clockLabel(now.getHours() * 60 + now.getMinutes())} - ${nf(plan.totalItems)} left - `
    + `${Math.round(plan.rate)}/hr per picker${plan.rateFromGif ? "" : " (default)"}`
    + (plan.active ? ` - active ${plan.active.active}${plan.active.betweenWalks ? ` (${plan.active.picking} picking + ${plan.active.betweenWalks} between walks)` : ""}` : "")
    + (plan.output != null ? ` - output ~${plan.output}` : "");
  const lines = plan.rows.map((x) => {
    const what = slotList(x);
    if (x.pastDue) return `⚠️ ${what} - past due - ${nf(x.left)} left`;
    let risk = x.add > 0, tail;
    if (x.kind === "later") {
      tail = `${what} - ${nf(x.left)} left - scheduled ${x.scheduled}, need ${x.needed}`;
    } else {
      const due = `due ${hm(x.by)}${x.kind === "next" ? (x.started ? " (started)" : " (not started)") : ""}`;
      // active = GIF's live pickers (for the next hour: the ones the current orders don't need)
      const active = x.basis === "picking now" ? ` (active ${x.have})` : "";
      tail = `${what} - ${due} - ${nf(x.left)} left - scheduled ${x.scheduled}${active}, need ${x.needed}`;
    }
    // only what to add matters (user, 2026-10-09) — no surplus, no head-count detail
    if (x.add > 0) tail += ` - add ${x.add}`;
    else if (!x.late) tail += " - covered";
    else if (x.late) { risk = true; tail += " - a few min late"; }
    const p = x.kind === "now" ? x.slots.map((s) => paceBy[s]).find((q) => q && (q.status === "short" || q.status === "tight")) : null;
    if (p) tail = tail.replace(/ - covered$/, "");   // the live rate says otherwise
    if (p?.status === "short") { risk = true; tail += ` - behind: picking ${nf(p.rate)}/hr, need ${nf(p.needPerHour)}/hr - get ${p.add} more now`; }
    else if (p?.status === "tight") { risk = true; tail += " - a few min late at the live rate"; }
    return `${risk ? "⚠️" : "-"} ${tail}`;
  });
  return [head, ...lines, ...sched].join("\n");
}

/** 14 → "2-3pm", 11 → "11am-12pm". */
export function hourRange(h) {
  const a = hourLabel(h), b = hourLabel(h + 1);
  return a.slice(-2) === b.slice(-2) ? `${a.slice(0, -2)}-${b}` : `${a}-${b}`;
}

/**
 * The board's PICK count for every hour of the day, whether or not orders have
 * dropped for it yet (user, 2026-10-10: "2-3 14 pickers, 3-4 18 pickers").
 * First to last hour with anyone on PICK; empty hours in between show 0.
 */
export function scheduleLines(roster) {
  const by = pickersByHour(roster);
  const hrs = Object.keys(by).map(Number).sort((x, y) => x - y);
  if (!hrs.length) return [];
  const out = ["", "Scheduled pickers:"];
  for (let h = hrs[0]; h <= hrs.at(-1); h++) out.push(`- ${hourRange(h)}: ${by[h] || 0} picker${by[h] === 1 ? "" : "s"}`);
  return out;
}

/** "2pm - 3pm" → "2pm". */
const slotHour = (slot) => String(slot).split(/\s*-\s*/)[0].replace(/\s+/g, "");

/** 690 → "11:30am". */
export function clockLabel(min) {
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")}${h % 24 < 12 ? "am" : "pm"}`;
}

/**
 * Live pace per open due hour: will what we're picking right now get each
 * hour's orders done by their due time (slot start − 30 min)?
 *
 * For each open slot, in due order: everything due by then (this slot + any
 * earlier slot still open) ÷ time left = the rate needed. Compare with the live
 * store rate (picks/hr over the last hour, every picker incl. store help). If
 * it falls short, the gap ÷ (one picker's rate × time left) = extra pickers
 * needed from now until that due time.
 *
 * @param {{ open?: object[], rate?: number, perPicker?: number, now?: Date, leadMin?: number }} p
 *   rate = live picks/hr; perPicker = one picker's effective items/hr (rate × util)
 */
export const PACE_ACTIONABLE_MIN = 10;   // closer than this, adding pickers can't help

export function slotPace({ open = [], rate, perPicker = DEFAULT_RATE * DEFAULT_UTIL, now = new Date(), leadMin = PICK_LEAD_MIN } = {}) {
  const nowMin = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  const items = dueItems({ open }, leadMin);
  const rows = [];
  let cum = 0;
  for (const it of items) {
    cum += it.qty;
    const minutesLeft = it.by - nowMin;
    // not open yet (picks start 2 h before the slot): only its own window counts, for its own items
    const opensIn = it.from - nowMin;
    const row = { slot: it.slot, dueAt: it.by, due: clockLabel(it.by), left: it.qty, cumLeft: opensIn > 0 ? it.qty : cum,
      minutesLeft: Math.round(opensIn > 0 ? it.by - it.from : minutesLeft), opensAt: opensIn > 0 ? clockLabel(it.from) : null };
    if (minutesLeft <= 0) { rows.push({ ...row, status: "late", short: cum }); continue; }
    const hrs = row.minutesLeft / 60;
    const needPerHour = Math.round(row.cumLeft / hrs);
    const projected = Number.isFinite(rate) ? Math.round(rate * hrs) : null;
    const short = projected == null ? null : Math.max(0, row.cumLeft - projected);
    // Under 10 min to go, extra people can't get there in time — call it
    // "finishing a few minutes late" instead of asking for pickers.
    const tooLate = minutesLeft < PACE_ACTIONABLE_MIN;
    const add = short && !tooLate ? Math.ceil(short / (perPicker * hrs)) : 0;
    rows.push({ ...row, needPerHour, rate: Number.isFinite(rate) ? Math.round(rate) : null, projected, short,
      add, status: projected == null ? "unknown" : short > 0 ? (tooLate ? "tight" : "short") : "on track" });
  }
  return rows;
}

/** "12pm–1pm orders (due 11:30am): 329 left in 21 min — need 940/hr, picking 1,411/hr · on track" */
export function paceLine(r) {
  const nf = (x) => Number(x).toLocaleString("en-US");
  const name = `${String(r.slot).replace(/\s+/g, "")} (due ${r.due})`;
  if (r.status === "late") return `${name}: past due with ${nf(r.cumLeft)} left`;
  const base = r.opensAt
    ? `${name}: opens ${r.opensAt}, ${nf(r.cumLeft)} to pick in ${r.minutesLeft} min — need ${nf(r.needPerHour)}/hr`
    : `${name}: ${nf(r.cumLeft)} left in ${r.minutesLeft} min — need ${nf(r.needPerHour)}/hr`;
  if (r.status === "unknown") return `${base} (no live rate yet)`;
  if (r.status === "tight") return `${base}, picking ${nf(r.rate)}/hr · ~${nf(r.short)} will finish a few minutes late`;
  return r.status === "on track"
    ? `${base}, picking ${nf(r.rate)}/hr · on track`
    : `${base}, picking ${nf(r.rate)}/hr · ~${nf(r.short)} short → get ${r.add} more picking ${r.opensAt ? `at ${r.opensAt}` : "now"}`;
}
