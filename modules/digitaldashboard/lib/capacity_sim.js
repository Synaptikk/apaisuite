// modules/digitaldashboard/lib/capacity_sim.js
//
// "When and where do we need to add pickers?" — a minute-by-minute forecast of
// the rest of the day (user, 2026-10-25: "current hour staffing vs current picks,
// pick rate… account for future picks not being clickable until they drop in,
// associates in walks and when they should finish and get into another one,
// breaks, lunches, everything"). Pure, so the SW, the !commands and the tests
// share it; staffing.js keeps the older one-hour estimate as the fallback.
//
// Work (GIF OPD Hourly):
//   - Each order hour ("4pm - 5pm") is due PICK_LEAD_MIN (30) before its slot and
//     can't be started before its window opens PICK_AHEAD_MIN (2 h) before the
//     slot (the store's pick window; future orders aren't clickable until then).
//   - Express still expected to drop is added to the hour it lands in.
//   - Items already on someone's walk card are that picker's work: they finish
//     them first, at their own rate.
// People (the Daily Board):
//   - A person picks only in their PICK hours ("30" = the first half of the hour
//     after a PICK hour). "L" = lunch, not picking.
//   - 15-min breaks are not on the board: assumed ~2 h into the shift and ~2 h
//     after lunch (6 h+ shifts), or one mid-shift for shorter shifts (user rules,
//     2026-09-23). Breaks before now are taken as done.
//   - Someone the break watch shows idle now is on a break (back at 15 min) or,
//     idle 15–60 min, on lunch (back at 60 min).
//   - Rate: their own pick rate today from GIF's leaderboard (picking time only),
//     else the store's; every walk costs WALK_GAP_MIN between walks (cart, totes,
//     staging) on top, and walks hold AVG_WALK_ITEMS items (store average).
//   - People picking now who aren't on the board (store help) finish their walk.
// Adds: for each order hour that would finish late, the fewest extra pickers (at
// the store rate) over the window they can help in that gets it done on time.

import { parseSlot, SLOT_START_HOUR, sameName } from "./gif_metrics.js";

export const PICK_LEAD_MIN = 30;
export const PICK_AHEAD_MIN = 120;
export const WALK_GAP_MIN = 5;
export const AVG_WALK_ITEMS = 37;
export const BREAK_MIN = 15;
export const DEFAULT_RATE = 95;
// Stores without a planning board: the people picking now are assumed to keep picking this long,
// with a break allowance; hours due after that depend on who comes in, so they're flagged, not forecast.
export const NO_BOARD_HORIZON_MIN = 120;
// A GIF reading older than this is too stale to forecast from (walks and counts have moved on).
export const STALE_FORECAST_MIN = 30;
export const NO_BOARD_BREAK_SHARE = 0.08;
const MAX_ADD = 40;

const minOf = (d) => d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
export const clock = (m) => {
  const h = Math.floor(m / 60) % 24, mm = Math.round(m % 60);
  const hh = mm === 60 ? h + 1 : h, m2 = mm === 60 ? 0 : mm;
  return `${hh % 12 || 12}:${String(m2).padStart(2, "0")}${hh < 12 ? "am" : "pm"}`;
};
const hourLbl = (h) => `${h % 12 || 12}${h % 24 < 12 ? "am" : "pm"}`;

/** Board row → per-minute availability windows (pick minutes), lunch and breaks applied. */
export function boardWindows(row) {
  const cells = row?.slots || {};
  const hours = Object.keys(cells).map(Number).sort((a, b) => a - b);
  const pick = [];      // [startMin, endMin) when the board says PICK
  let lunch = null;
  for (const k of hours) {
    const c = String(cells[k] ?? "").trim().toUpperCase();
    const h0 = (SLOT_START_HOUR + k) * 60;
    if (c === "PICK") pick.push([h0, h0 + 60]);
    else if (c === "30" && String(cells[k - 1] ?? "").trim().toUpperCase() === "PICK") pick.push([h0, h0 + 30]);
    else if (c === "L" && !lunch) lunch = [h0, h0 + 60];
  }
  // merge adjacent PICK hours
  const merged = [];
  for (const w of pick) { const last = merged.at(-1); if (last && last[1] === w[0]) last[1] = w[1]; else merged.push([...w]); }
  // shift span (any cell) for break timing
  const first = hours.length ? (SLOT_START_HOUR + hours[0]) * 60 : null;
  const lastK = hours.at(-1);
  const end = hours.length ? (SLOT_START_HOUR + lastK) * 60 + (String(cells[lastK]).trim() === "30" ? 30 : 60) : null;
  const breaks = [];
  if (first != null) {
    const len = end - first;
    if (len >= 360) {
      breaks.push(first + 120);
      if (lunch) breaks.push(lunch[1] + 120); else breaks.push(first + Math.round(len * 0.75));
    } else if (len >= 240) breaks.push(first + Math.round(len / 2));
  }
  return { pick: merged, lunch, breaks: breaks.filter((b) => end == null || b < end - 15), start: first, end };
}

/** Is this person scheduled to pick at minute t (board PICK, not on a break)? */
function onBoardPick(win, t) {
  if (!win.pick.some(([a, b]) => t >= a && t < b)) return false;
  return !win.breaks.some((b) => t >= b && t < b + BREAK_MIN);
}

/**
 * Order hours still to pick → [{ slot, start, due, from, items, express }]
 * open: GIF open hours ({ slot, left|total+picked, walks:[{name, qty}] }); upcoming: [{ slot, qty }].
 */
export function orderHours({ open = [], upcoming = [], expressPerHour = 0, nowMin }) {
  const out = [];
  const add = (slot, items, walks = []) => {
    const s = parseSlot(slot);
    if (!s || !(items > 0)) return;
    // express drops until :15 past each hour and is due by the next; count what's still to come
    const h = s.start / 60 - 1;
    const exWindowEnd = h * 60 + 15, exStart = exWindowEnd - 60;
    const exLeft = expressPerHour > 0 ? Math.round(expressPerHour * Math.min(60, Math.max(0, exWindowEnd - Math.max(exStart, nowMin))) / 60) : 0;
    out.push({ slot, start: s.start, due: s.start - PICK_LEAD_MIN, from: s.start - PICK_AHEAD_MIN, items, express: exLeft,
      onWalks: walks.reduce((t, w) => t + (w.qty > 0 ? w.qty : 0), 0) });
  };
  for (const o of open) {
    const left = Number.isFinite(o.left) ? o.left : Number.isFinite(o.total) && Number.isFinite(o.picked) ? o.total - o.picked : 0;
    add(o.slot, left, o.walks || []);
  }
  for (const u of upcoming) add(u.slot, u.qty);
  return out.sort((a, b) => a.due - b.due);
}

/**
 * Run the day forward from `now`.
 * @param {object} p
 *   open, upcoming, roster (board rows), leaderboard ([{name, rate}]), storeRate, watch ({suspects:[{name, idleMin}]}),
 *   expressPerHour, avgWalkItems, now (Date), extras ([{from, to, n}] extra generic pickers)
 * @returns {{ hours: object[], perHour: object[], endMin: number }}
 */
export function simulate({ open = [], upcoming = [], roster = [], leaderboard = [], storeRate, watch = null, expressPerHour = 0,
  avgWalkItems = AVG_WALK_ITEMS, now = new Date(), extras = [], activeNow = null } = {}) {
  const nowMin = minOf(now);
  const rate0 = storeRate > 0 ? storeRate : DEFAULT_RATE;
  const hours = orderHours({ open, upcoming, expressPerHour, nowMin }).map((h) => ({
    ...h, left: h.items + h.express, free: h.items + h.express - h.onWalks, doneAt: null, picked: 0,
  }));
  if (!hours.length) return { hours, perHour: [], endMin: nowMin };
  const endMin = Math.max(...hours.map((h) => h.due)) + 180;
  const rateOf = (name) => {
    const r = (leaderboard || []).find((x) => sameName(x.name, name))?.rate;
    return r > 30 && r < 400 ? r : rate0;
  };
  const idle = (name) => (watch?.suspects || []).find((x) => sameName(x.name, name))?.idleMin;

  // pickers: board rows + anyone on a walk card who isn't on the board
  const noBoard = !(roster || []).some((r) => r?.name && r.status !== "absent" && boardWindows(r).pick.length);
  const horizon = [Math.floor(nowMin), Math.floor(nowMin) + NO_BOARD_HORIZON_MIN];
  const people = [];
  for (const row of roster || []) {
    if (!row?.name || row.status === "absent") continue;
    const win = boardWindows(row);
    if (!win.pick.length) continue;
    const p = { name: row.name, win, rate: rateOf(row.name), busyUntil: nowMin, board: true, pickMin: 0 };
    const im = idle(row.name);
    if (im != null && im >= 10) p.busyUntil = nowMin + (im < BREAK_MIN ? BREAK_MIN - im : im < 60 ? 60 - im : 0);
    people.push(p);
  }
  // A walk shows one card per order hour it has items for, so a picker's cards are ONE walk: picked
  // in due order at their rate, each hour's items done as the picker reaches them.
  const allWalks = open.flatMap((o) => (o.walks || []).map((w) => ({ ...w, slot: o.slot })));
  const byPicker = new Map();
  for (const w of allWalks) {
    if (!(w.qty > 0)) continue;
    const key = [...byPicker.keys()].find((k) => sameName(k, w.name)) ?? w.name;
    (byPicker.get(key) || byPicker.set(key, []).get(key)).push(w);
  }
  for (const [name, cards] of byPicker) {
    let p = people.find((x) => sameName(x.name, name));
    if (!p) { p = { name, win: null, rate: rateOf(name), busyUntil: nowMin, board: false, pickMin: 0 }; people.push(p); }
    let t = nowMin;   // they are on this walk now, whatever the watch says
    for (const w of cards.sort((a, b) => (parseSlot(a.slot)?.start ?? 0) - (parseSlot(b.slot)?.start ?? 0))) {
      const mins = (w.qty / p.rate) * 60;
      t += mins;
      const h = hours.find((x) => x.slot === w.slot);
      if (h) (h.events ||= []).push([t, w.qty, "walk"]);
      p.pickMin += mins;
    }
    p.busyUntil = t + WALK_GAP_MIN;
    if (noBoard && !p.win) p.win = { pick: [horizon], breaks: [] };   // keeps picking after this walk
  }
  if (noBoard) {
    // no board: whoever GIF shows picking now (incl. between walks) keeps picking for the horizon, at the store rate,
    // less a break allowance; the ones on walk cards are already counted above
    const extraLive = Math.max(0, Math.round((activeNow ?? 0) - byPicker.size));
    for (let i = 0; i < extraLive; i++) people.push({ name: `live${i}`, win: { pick: [horizon], breaks: [] }, rate: rate0, busyUntil: nowMin, board: false, pickMin: 0 });
    for (const p of people) p.rate *= 1 - NO_BOARD_BREAK_SHARE;
  }
  // extra pickers asked for by the add search
  for (const e of extras) for (let i = 0; i < e.n; i++) people.push({ name: `extra${i}@${e.from}`, win: { pick: [[e.from, e.to]], breaks: [] }, rate: rate0, busyUntil: e.from, board: true, extra: true, pickMin: 0 });

  // minute loop: free pickers take the next walk from the earliest-due pickable hour
  const perHour = {};
  for (let t = Math.floor(nowMin); t < endMin; t++) {
    const hourKey = Math.floor(t / 60);
    for (const p of people) {
      if (p.busyUntil > t || !p.win || !onBoardPick(p.win, t)) continue;
      const h = hours.find((x) => x.free > 0 && t >= x.from);
      if (!h) continue;
      const n = Math.min(avgWalkItems, h.free);
      h.free -= n;
      const mins = (n / p.rate) * 60;
      (h.events ||= []).push([t + mins, n]);
      p.busyUntil = t + mins + WALK_GAP_MIN;
      p.pickMin += mins;
      const ph = (perHour[hourKey] ||= { hour: hourKey, walks: 0, items: 0 });
      ph.walks++; ph.items += n;
    }
  }
  // completion per order hour
  for (const h of hours) {
    const ev = (h.events || []).sort((a, b) => a[0] - b[0]);
    // walks already out vs. the rest: tells "check on slow walks" apart from "add pickers"
    const walkEv = ev.filter((e) => e[2] === "walk"), poolEv = ev.filter((e) => e[2] !== "walk");
    h.walksDoneAt = walkEv.length ? walkEv.at(-1)[0] : null;
    h.slowWalks = walkEv.filter((e) => e[0] > h.due).length;
    h.restDoneAt = poolEv.length ? poolEv.at(-1)[0] : (walkEv.length ? null : h.doneAt);
    let done = 0;
    for (const [t, n] of ev) { done += n; if (done >= h.left - 0.5) { h.doneAt = t; break; } }
    h.picked = Math.min(h.left, done);
    h.late = h.doneAt == null || h.doneAt > h.due;
    h.lateMin = h.doneAt == null ? null : Math.max(0, Math.round(h.doneAt - h.due));
    h.leftAtDue = Math.round(h.left - ev.filter(([t]) => t <= h.due).reduce((s, [, n]) => s + n, 0));
    delete h.events;
  }
  return { hours, perHour: Object.values(perHour), endMin, people: people.filter((p) => !p.extra).length, noBoard, horizonEnd: horizon[1] };
}

/** Board count and expected pickers per clock hour (breaks/lunch applied), for the "who picks what" lines. */
export function boardByHour(roster, fromHour, toHour) {
  const out = [];
  for (let h = fromHour; h <= toHour; h++) {
    let board = 0, avail = 0;
    for (const row of roster || []) {
      if (!row?.name || row.status === "absent") continue;
      const win = boardWindows(row);
      const mins = Array.from({ length: 60 }, (_, i) => h * 60 + i);
      if (win.pick.some(([a, b]) => h * 60 >= a && h * 60 < b)) board++;
      avail += mins.filter((t) => onBoardPick(win, t)).length / 60;
    }
    if (board || avail) out.push({ hour: h, board, avail: Math.round(avail * 10) / 10 });
  }
  return out;
}

/**
 * Forecast + adds. Same inputs as simulate().
 * Each late order hour gets the fewest extra pickers over [max(now, window open), due] that bring it in on time
 * (searched in due order, keeping earlier adds).
 */
export function forecast(input) {
  const now = input.now || new Date();
  const nowMin = minOf(now);
  const base = simulate(input);
  const extras = [];
  const adds = [];
  for (const h0 of base.hours) {
    if (h0.due <= nowMin) continue;   // past due: nothing to add for it
    const run = (n) => simulate({ ...input, extras: [...extras, ...(n ? [{ from: Math.max(Math.ceil(nowMin), h0.from), to: h0.due, n }] : [])] })
      .hours.find((x) => x.slot === h0.slot);
    const cur = run(0);
    if (!cur.late) continue;
    let lo = 1, hi = MAX_ADD, best = null;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (!run(mid).late) { best = mid; hi = mid - 1; } else lo = mid + 1; }
    const from = Math.max(Math.ceil(nowMin), h0.from);
    if (best) { extras.push({ from, to: h0.due, n: best }); adds.push({ slot: h0.slot, n: best, from, to: h0.due }); }
    else adds.push({ slot: h0.slot, n: null, from, to: h0.due, cantMake: true });
  }
  const final = extras.length ? simulate({ ...input, extras }) : base;
  return { now: nowMin, base, final, adds };
}

/**
 * Chat reply for !staffing (forecast version).
 *   Staffing @ 2:05pm (GIF read 2:04) - 4,201 left - 27 picking - 93/hr store rate
 *   - 3pm orders - due 2:30 - 450 left - done ~2:18 - covered
 *   ⚠️ 4pm orders - due 3:30 - 1,717 left - done ~3:52 (22 min late) - add 4 from 2:05 to 3:30
 *   - 5pm orders - opens 3:00, due 4:30 - 1,603 left - done ~4:21 - covered
 *
 *   Who picks which orders (orders are picked in the 2 h before their slot):
 *   - 2-3pm: 20 on board, ~17 picking after breaks/lunch -> 4pm orders
 */
export function forecastText(fc, { readAt = null, picking = null, storeRate = null, roster = [] } = {}) {
  const nf = (x) => Math.round(x).toLocaleString("en-US");
  const hm = (m) => clock(m).replace(/(am|pm)$/, "");
  const slotHour = (s) => String(s).split(/\s*-\s*/)[0].replace(/\s+/g, "");
  const total = fc.base.hours.reduce((t, h) => t + h.items, 0);
  const age = readAt != null ? Math.round(fc.now - minOf(readAt)) : null;
  const head = `Staffing @ ${clock(fc.now)}${readAt ? ` (GIF read ${clock(minOf(readAt))})` : ""} - ${nf(total)} left`
    + (Number.isFinite(picking) ? ` - ${picking} picking` : "") + (storeRate ? ` - ${Math.round(storeRate)}/hr store rate` : "");
  const lines = [head];
  if (fc.base.noBoard) lines.push(`No planning board: assuming the ${fc.base.people} people picking now keep going until ~${clock(fc.base.horizonEnd)} (each at their own rate, less breaks). Hours after that depend on who comes in.`);
  if (age != null && age > STALE_FORECAST_MIN) {
    // too old to forecast from: the walks and counts it would start from are long gone
    lines.push(`⚠️ GIF reading is ${age} min old - the phone has likely stopped reading, so no forecast. Last known (${clock(minOf(readAt))}):`);
    for (const h of fc.base.hours) lines.push(`- ${slotHour(h.slot)} orders - due ${hm(h.due)} - ${nf(h.items)} left then`);
    return lines.join("\n");
  }
  if (age != null && age > 15) lines.push(`⚠️ GIF reading is ${age} min old - the phone may have stopped reading; numbers below are as of ${clock(minOf(readAt))}.`);
  for (const h of fc.base.hours) {
    const what = `${slotHour(h.slot)} orders`;
    const left = nf(h.items) + (h.express ? ` (+${nf(h.express)} express to come)` : "");
    if (h.due <= fc.now) { lines.push(`⚠️ ${what} - past due ${hm(h.due)} - ${left} left`); continue; }
    const opens = h.from > fc.now ? `opens ${hm(h.from)}, ` : "";
    if (fc.base.noBoard && h.from >= fc.base.horizonEnd) { lines.push(`- ${what} - ${opens}due ${hm(h.due)} - ${left} - picked after ~${hm(fc.base.horizonEnd)}: depends on who's scheduled then`); continue; }
    const add = fc.adds.find((a) => a.slot === h.slot);
    let tail;
    if (h.doneAt == null) tail = "won't finish today at this staffing";
    else if (!h.late) tail = `done ~${hm(h.doneAt)} - covered`;
    else tail = `done ~${hm(h.doneAt)} (${h.lateMin} min late)`;
    if (add?.n) tail += ` - add ${add.n} from ${hm(add.from)} to ${hm(add.to)}`;
    else if (add?.cantMake && h.slowWalks > 0) tail += ` - held up by ${h.slowWalks} walk${h.slowWalks === 1 ? "" : "s"} already out that finish after ${hm(h.due)}`
      + (h.restDoneAt != null && h.restDoneAt <= h.due ? ` (the rest is done ~${hm(h.restDoneAt)})` : "") + " - check on those pickers";
    else if (add?.cantMake) tail += " - can't be made on time even with more pickers";
    else if (h.late && !add && fc.final.hours.find((x) => x.slot === h.slot)?.late === false) tail += " - covered once the adds above are in";
    lines.push(`${h.late ? "⚠️" : "-"} ${what} - ${opens}due ${hm(h.due)} - ${left} - ${tail}`);
  }
  // who picks which orders
  const first = Math.floor(fc.now / 60);
  const last = Math.max(first, ...fc.base.hours.map((h) => Math.floor((h.due - 1) / 60)));
  const by = fc.base.noBoard ? [] : boardByHour(roster, first, last);
  if (by.length) {
    lines.push("", "Who picks which orders (picked in the 2 h before their slot):");
    const range = (h) => { const a = hourLbl(h), b = hourLbl(h + 1); return a.slice(-2) === b.slice(-2) ? `${a.slice(0, -2)}-${b}` : `${a}-${b}`; };
    for (const b of by) lines.push(`- ${range(b.hour)}: ${b.board} on board, ~${Math.round(b.avail)} picking after breaks/lunch -> ${hourLbl(b.hour + 2)} orders`);
  }
  return lines.join("\n");
}
