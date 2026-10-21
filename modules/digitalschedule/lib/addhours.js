// modules/digitalschedule/lib/addhours.js
//
// "Add N extra hours" planner — for weeks the manager wants to staff past the
// guidance (holiday ramp, a push). Pure; runs on the queued-state `read`
// result and returns changes to APPEND to the queue.
//
// Where the hours go: the extra is spread over the guidance in proportion to
// its volume (an hour needing 6 FTE gets twice the share of one needing 3),
// weighted up on Sat/Sun and in the peak window (coverage.js PEAK, 2p–5p). That gives every hour a raised target
// (guidance + its share of whatever the week ends up past the guidance:
// scheduled now + N − guidance). Short hours fill first because their gap to the
// target is biggest; hours with no guidance (store closed, no volume) are
// never staffed.
//
// How they're placed — proper shifts only, greedy, best value first:
//   - stretch an existing shift toward 9 h (8 paid + 1 h lunch) by whole
//     hours, inside availability;
//   - add a shift on an open day: 9 h preferred, shorter only when the cap or
//     the availability window says so, never under 4 h; whole-hour starts;
//     1 h unpaid lunch 3–4 h in for anything over 6 h.
// Limits: weekly cap (part-time 33.75, else 40) over ALL jobs, 5 working days
// for full-timers / 6 for part-timers, availability + exceptions + PTO days,
// people rules (keep, fixed, days, window), minors weekends only and within
// coverage.js minorShiftOK (7.75 paid h, not before 6:15), 10 h rest, `lock`
// between shifts (neighbouring weeks included), In Home drivers untouched,
// today and earlier never touched, shifts already in the queue left alone.

import { toMin, fmt, coverage, needFor, paidHours, shiftSpan, unpaidWindows, isMinor, minorShiftOK, isPeak, isOvernight, DAY_START, IN_HOME_JOB } from "./coverage.js";
import { windowsFor } from "./suggest.js";
import { nameKey } from "./rules.js";

const BLOCK = 540, MIN_SHIFT = 240, REST = 600, LUNCH_OVER = 360;
const r2 = (x) => Math.round(x * 100) / 100;
const paidOf = (len) => (len - (len > LUNCH_OVER ? 60 : 0)) / 60;
const lenFor = (paidH) => { const h = Math.floor(paidH + 1e-9); return h < 4 ? 0 : Math.min(BLOCK, h * 60 + (h > 6 ? 60 : 0)); };

export function addHours(data, opts = {}) {
  const { roleId, jobs, roleJobs = null, extra = 0, editableFrom = null, rules = null, neighbors = {},
    weekendBoost = 0.25, peakBoost = 0.5, allowExtend = true, allowCreate = true, lock = [] } = opts;
  const locked = new Set(lock.map(String));
  const D = data.dates;

  // ── per-role grids: need / have / target ──────────────────────────────────
  const groups = roleJobs && Object.keys(roleJobs).length > 1
    ? Object.entries(roleJobs).map(([r, js]) => ({ ids: [+r], jobs: js }))
    : [{ ids: [roleId].flat(), jobs }];
  const roleOfJob = new Map(); groups.forEach((g, gi) => g.jobs.forEach((j) => roleOfJob.set(j, gi)));
  const G = groups.map((g) => { const need = needFor(data, g.ids); const have = coverage(data, g.ids, g.jobs).map((d) => d.have.slice()); return { need, have }; });
  const wOf = (di, h) => 1 + (di < 2 ? weekendBoost : 0) + (isPeak(h) ? peakBoost : 0);
  // "add N" = N hours on top of what's scheduled now: the raised targets sum to max(guidance, scheduled + N);
  // the part past the guidance is spread by volume x weight.
  let mass = 0, guide = 0, sched = 0;
  G.forEach((g) => g.need.forEach((day, di) => day.forEach((n, h) => { mass += n * wOf(di, h); guide += n; sched += Math.min(g.have[di][h], n > 0 ? Infinity : 0); })));
  const past = Math.max(0, sched + extra - guide);
  G.forEach((g) => { g.target = g.need.map((day, di) => day.map((n, h) => n + (mass > 0 ? past * n * wOf(di, h) / mass : 0))); });

  // value of one 15-min slot of coverage at (role, day, hour) given current have
  const slotGain = (g, di, h) => {
    if (di > 6 || h > 23) return -1;
    const n = g.need[di][h], t = g.target[di][h], v = g.have[di][h];
    if (n <= 1e-9) return -1;                          // no guidance: never staff it
    if (v < n - 1e-9) return 1.6 * wOf(di, h);         // genuinely short
    if (v < t - 1e-9) return 1.0 * wOf(di, h);         // inside the extra share
    return -0.6;                                       // past the raised target
  };
  // on-clock slot list for a shift laid out as [a,b) with unpaid windows
  const slots = (di, a, b, off) => { const out = []; for (let m = a; m < b; m += 15) if (!off.some(([p, q]) => m >= p && m < q)) out.push([di + Math.floor(m / 1440), Math.floor((m % 1440) / 60)]); return out; };
  const valueOf = (g, sl) => sl.reduce((t, [di, h]) => t + slotGain(g, di, h), 0);
  const bump = (g, sl, by) => sl.forEach(([di, h]) => { if (di <= 6 && h <= 23) g.have[di][h] += by; });

  // ── people ────────────────────────────────────────────────────────────────
  const rk = rules || { keep: new Set(), fixed: new Map(), daysOnly: new Map(), windows: new Map() };
  const day0 = Date.parse(D[0] + "T00:00:00Z");
  const absOf = (date, m) => (Date.parse(date + "T00:00:00Z") - day0) / 6e4 + m;
  const inScope = (w) => w.shifts.some((s) => roleOfJob.has(s.job)) || roleOfJob.has(String(w.job || ""));
  const people = [];
  for (const w of data.workers.filter(inScope)) {
    const k = nameKey(w.name);
    if (String(w.job || "").includes(IN_HOME_JOB) || w.shifts.some((s) => s.job === IN_HOME_JOB)) continue;
    if (rk.keep.has(k) || rk.fixed.has(k) || locked.has(String(w.workerId)) || locked.has(k)) continue;
    if (w.shifts.some(isOvernight)) continue;   // overnight pickers (before 5am / past midnight) stay on the event
    const part = /part/i.test(`${w.employmentType} ${w.payType}`);
    const homeJob = roleOfJob.has(String(w.job || "")) ? String(w.job) : (() => { const c = {}; w.shifts.filter((s) => roleOfJob.has(s.job)).forEach((s) => { c[s.job] = (c[s.job] || 0) + 1; }); return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0]; })();
    const spans = w.shifts.map((s) => { const [a, b] = shiftSpan(s); return [absOf(s.day, a), absOf(s.day, b)]; });
    const nb = neighbors[w.workerId] || {};
    if (nb.prevEnd != null) spans.push([nb.prevEnd - 1, nb.prevEnd]);
    if (nb.nextStart != null) spans.push([nb.nextStart, nb.nextStart + 1]);
    people.push({ w, k, part, minor: isMinor(w), homeJob, cap: part ? 33.75 : 40, maxDays: part && !isMinor(w) ? 6 : 5,   // minors: 5 days (validator 10000, 2026-10-21)
     
      paid: w.shifts.reduce((a, s) => a + paidHours(s), 0), before: w.shifts.reduce((a, s) => a + paidHours(s), 0),
      days: new Set(w.shifts.map((s) => s.day)), busy: new Set((w.otherEvents || []).map((e) => e.day)), spans });
  }
  const dayOk = (P, di) => {
    const date = D[di];
    if (editableFrom && date < editableFrom) return false;
    if (P.minor && di >= 2) return false;
    const only = rk.daysOnly.get(P.k); if (only && !only.includes(di)) return false;
    return !P.busy.has(date);
  };
  // availability windows for the day, narrowed by any "window" people rule
  const winsOf = (P, di) => {
    let ws = windowsFor(P.w, di, D[di]);
    for (const r of rk.windows.get(P.k) || []) if (r.days.includes(di)) ws = ws.map(([a, b]) => [Math.max(a, r.lo), Math.min(b, r.hi)]).filter(([a, b]) => b > a);
    return ws;
  };
  const restOk = (P, di, a, b, skip = null) => { const A = absOf(D[di], a), B = absOf(D[di], b);
    return P.spans.every((sp) => sp === skip || sp[1] + REST <= A || B + REST <= sp[0]); };

  // best lunch for a shift [a,b): offset 3 h or 4 h in, whichever loses less value
  const layout = (g, di, a, b) => {
    const len = b - a;
    if (len <= LUNCH_OVER) return { off: [], lunch: null, sl: slots(di, a, b, []) };
    let best = null;
    for (const o of [180, 240]) { if (o + 60 > len - 60) continue;
      const off = [[a + o, a + o + 60]], sl = slots(di, a, b, off), v = valueOf(g, sl);
      if (!best || v > best.v) best = { off, lunch: a + o, sl, v }; }
    return best;
  };

  // ── candidates ────────────────────────────────────────────────────────────
  function bestCreate(P) {
    if (!allowCreate || !P.homeJob || P.days.size >= P.maxDays) return null;
    const room = P.cap - P.paid, Lmax = lenFor(room); if (Lmax < MIN_SHIFT) return null;
    const g = G[roleOfJob.get(P.homeJob)];
    let best = null;
    for (let di = 0; di < 7; di++) {
      if (P.days.has(D[di]) || !dayOk(P, di)) continue;
      for (let [wa, wb] of winsOf(P, di)) {
        const b0 = Math.min(wb, 1440); wa = Math.max(wa, DAY_START * 60);
        for (const L of new Set([Math.min(Lmax, BLOCK), Math.min(Lmax, 480), Math.min(Lmax, 360)])) {
          if (L < MIN_SHIFT || b0 - wa < L) continue;
          for (let a = Math.ceil(wa / 60) * 60; a + L <= b0; a += 60) {
            if (!restOk(P, di, a, a + L)) continue;
            if (P.minor && !minorShiftOK(a, L)) continue;
            const lay = layout(g, di, a, a + L); const v = lay.v ?? valueOf(g, lay.sl);
            const paid = paidOf(L), score = v - 4 - 1.2 * Math.max(0, 8 - paid);   // a new shift has a fixed cost; short shifts cost more
            if (!best || score > best.score) best = { kind: "create", P, g, di, a, b: a + L, lunch: lay.lunch, sl: lay.sl, paid, score };
          }
        }
      }
    }
    return best;
  }
  function bestExtend(P) {
    if (!allowExtend) return null;
    const room = P.cap - P.paid; if (room < 1 - 1e-9) return null;
    let best = null;
    P.w.shifts.forEach((s) => {
      if (s.changed || s.qIdx != null || !roleOfJob.has(s.job) || isOvernight(s)) return;
      const di = D.indexOf(s.day); if (di < 0 || !dayOk(P, di)) return;
      const [a, b] = shiftSpan(s); if (b - a >= BLOCK) return;
      const g = G[roleOfJob.get(s.job)], ws = winsOf(P, di);
      const oldOff = unpaidWindows(s), oldSl = slots(di, a, b, oldOff), oldV = valueOf(g, oldSl);
      const span = P.spans.find((sp) => sp[0] === absOf(s.day, a));
      for (let na = a; na >= Math.max(a - 240, DAY_START * 60); na -= 60) for (let nb = b; nb <= Math.min(b + 240, 1440); nb += 60) {
        if (na === a && nb === b) continue;
        const L = nb - na; if (L > BLOCK) continue;
        if (P.minor && !minorShiftOK(na, L)) continue;
        const add = paidOf(L) - paidHours(s); if (add < 1 - 1e-9 || add > room + 1e-9) continue;
        if (!ws.some(([wa, wb]) => na >= wa && nb <= wb)) continue;
        if (!restOk(P, di, na, nb, span)) continue;
        // lunch: keep the old one when it still sits 3–4 h in, else re-place it
        const lunchOk = oldOff.length && oldOff.every(([p]) => p - na >= 180 && p - na <= 240);
        const lay = L <= LUNCH_OVER ? { off: [], lunch: null, sl: slots(di, na, nb, []) } : lunchOk ? { off: oldOff, lunch: oldOff[0][0], sl: slots(di, na, nb, oldOff) } : layout(g, di, na, nb);
        // value of the new layout with the old shift's coverage taken out first
        bump(g, oldSl, -0.25); const v = valueOf(g, lay.sl); bump(g, oldSl, 0.25);
        const gain = v - oldV, score = gain - 0.5 + (L === BLOCK ? 1.5 : 0);
        if (!best || score > best.score) best = { kind: "extend", P, g, di, s, a: na, b: nb, lunch: lay.lunch, sl: lay.sl, oldSl, span, paid: add, score };
      }
    });
    return best;
  }

  // ── greedy ────────────────────────────────────────────────────────────────
  const changes = [], log = { created: 0, extended: 0 }, byDay = Array(7).fill(0);
  let added = 0, stopWhy = null;
  for (let guard = 0; guard < 400 && added < extra - 0.25; guard++) {
    let best = null;
    for (const P of people) for (const c of [bestCreate(P), bestExtend(P)]) if (c && (!best || c.score > best.score)) best = c;
    if (!best) { stopWhy = "nobody has legal room left (caps, days, availability, rest, rules)"; break; }
    if (best.score <= 0) { stopWhy = "every remaining placement lands on hours already past the raised target or with no guidance"; break; }
    const { P, g, di } = best, date = D[di];
    if (best.kind === "create") {
      bump(g, best.sl, 0.25);
      changes.push({ name: P.w.name, workerId: P.w.workerId, action: "create", day: date, start: fmt(best.a), end: fmt(best.b), lunch: best.lunch != null ? fmt(best.lunch) : "none", job: P.homeJob, added: true });
      const sh = { day: date, start: fmt(best.a), end: fmt(best.b), job: P.homeJob, breaks: best.lunch != null ? [{ start: fmt(best.lunch), end: fmt(best.lunch + 60), paid: false }] : [], changed: true };
      P.w = { ...P.w, shifts: [...P.w.shifts, sh] };
      P.days.add(date); P.spans.push([absOf(date, best.a), absOf(date, best.b)]); log.created++;
    } else {
      bump(g, best.oldSl, -0.25); bump(g, best.sl, 0.25);
      const s = best.s, keepPaid = (s.breaks || []).filter((x) => x.paid);
      const breaks = [...keepPaid, ...(best.lunch != null ? [{ start: fmt(best.lunch), end: fmt(best.lunch + 60), paid: false }] : [])];
      changes.push({ name: P.w.name, workerId: P.w.workerId, action: "edit", day: date, from: s.start, expectEnd: s.end, start: fmt(best.a), end: fmt(best.b), breaks, job: s.job, stretched: true });
      const ns = { ...s, start: fmt(best.a), end: fmt(best.b), breaks, changed: true };
      P.w = { ...P.w, shifts: P.w.shifts.map((x) => (x === s ? ns : x)) };
      const i = P.spans.indexOf(best.span); const sp = [absOf(date, best.a), absOf(date, best.b)]; if (i >= 0) P.spans[i] = sp; else P.spans.push(sp);
      log.extended++;
    }
    P.paid += best.paid; added += best.paid; byDay[di] += best.paid;
  }
  if (!stopWhy && added < extra - 0.25) stopWhy = "stopped after 400 placements";

  return {
    changes,
    stats: { asked: extra, added: r2(added), created: log.created, extended: log.extended, byDay: byDay.map(r2), stopWhy },
    people: people.filter((P) => P.paid - P.before > 1e-9).map((P) => ({ name: P.w.name, before: r2(P.before), after: r2(P.paid), cap: P.cap }))
      .sort((a, b) => b.after - b.before - (a.after - a.before)),
  };
}
