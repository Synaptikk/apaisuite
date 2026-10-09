// modules/digitalschedule/lib/suggest.js
//
// Fit one role's shifts to the Hours Guidance line by re-timing them on their
// day (whole-hour starts, lunch placement, stretching to 9 h blocks) and by
// moving weekday shifts to other days. Week-level coordinate descent over an
// incremental 15-minute coverage array. Generalised from the WK 39 run of
// 2026-10-07 (.claude/skills/wfm-schedule/reference/wk39-optimizer.mjs).
//
// Store rules applied as hard constraints / heavy penalties:
//   - Sat/Sun never short, nothing moves off a weekend day
//   - 12p-4p never short
//   - no hour below `floorPct` of guidance (or below today's level where it already is)
//   - whole-hour starts; 9 h blocks; 1 h unpaid lunch on every shift over 6 h,
//     placed 3-4 h in (validator 10017 / 10054)
//   - In Home Delivery drivers untouched; minors never moved onto weekdays or
//     earlier on a weekday (school hours, validator 12024 HARD)
//   - 10 h rest between shifts; weekly paid hours cap (40, part-time 33.75)
//   - people rules from lib/rules.js
//
// Output is a changes list in the same shape lib/page.js validates and saves.

import { toMin, fmt, IN_HOME_JOB, needFor, unpaidWindows, shiftSpan, paidHours } from "./coverage.js";
import { nameKey } from "./rules.js";

const SLOT = 15, NS = 96 + 16, LUNCH_MIN = 360, BLOCK = 540, REST = 600;
const MOVE_COST = 6, DAY_COST = 10, EXT_CREDIT = 4, LUNCH_COST = 2;
const paid = (len) => (len - (len > LUNCH_MIN ? 60 : 0)) / 60;
const LUNCH_OFFS = (len) => len > LUNCH_MIN ? [180, 240].filter((o) => o + 60 <= len - 60) : [null];

function windowsFor(w, di, date) {
  const exc = (w.exceptions || []).some((e) => e.unavailable !== false && String(e.from).slice(0, 10) <= date && String(e.to).slice(0, 10) > date);
  const v = w.availability?.[["sat", "sun", "mon", "tue", "wed", "thu", "fri"][di]];
  if (exc || v == null || v === "off") return [];
  if (v === "any") return [[0, 1440]];
  return String(v).split(",").map((r) => { const [a, b] = r.split("-").map(toMin); return [a, b <= a ? b + 1440 : b]; }).filter(([a, b]) => b > a);
}

export function suggest(data, opts = {}) {
  const {
    roleId = 1000271, jobs = ["1-936-1451"], keepJobs = [IN_HOME_JOB], rules = null,
    floorPct = 0.85, matchBonus = 5, protectWeekend = true, peak = [12, 13, 14, 15],
    startStep = 60, allowExtend = true, allowDayMoves = true, lock = [],
    editableFrom = null,   // "YYYY-MM-DD": days before it are already worked — never touched
  } = opts;
  const R = rules || { pairs: [], fixed: new Map(), daysOnly: new Map(), windows: new Map(), noDayMove: new Set(), keep: new Set() };
  const locked = new Set(lock.map(String));
  const DATES = data.dates, WEEKEND = protectWeekend ? [0, 1] : [];
  const past = (di) => !!editableFrom && DATES[di] < editableFrom;
  const need = needFor(data, roleId);
  const openClose = need.map((n) => { const hrs = n.map((v, h) => (v > 0 ? h : null)).filter((h) => h != null);
    return hrs.length ? [hrs[0] * 60, (hrs.at(-1) + 1) * 60] : [0, 0]; });
  const partnerOf = (k) => { for (const p of R.pairs) { if (p[0] === k) return p[1]; if (p[1] === k) return p[0]; } return null; };

  // ── people + the shifts in play ───────────────────────────────────────────
  const people = new Map(), shifts = [];
  for (const w of data.workers) {
    const k = nameKey(w.name);
    const inHome = String(w.job || "").includes(IN_HOME_JOB) || w.shifts.some((s) => keepJobs.includes(s.job));
    const P = { w, k, name: w.name, minor: /minor/i.test(String(w.minor ?? "")), inHome,
      fixedPerson: inHome || R.keep.has(k) || locked.has(String(w.workerId)) || locked.has(k),
      maxWeek: /part/i.test(`${w.employmentType} ${w.payType}`) ? 33.75 : 40, otherPaid: 0, wins: [], free: [] };
    DATES.forEach((date, di) => {
      let wins = windowsFor(w, di, date);
      const only = R.daysOnly.get(k); if (only && !only.includes(di)) wins = [];
      const raw = wins;
      for (const lim of R.windows.get(k) || []) if (lim.days.includes(di)) wins = wins.map(([a, b]) => [Math.max(a, lim.lo), Math.min(b, lim.hi)]).filter(([a, b]) => b > a);
      P.wins[di] = wins; P.rawWins = P.rawWins || []; P.rawWins[di] = raw;
      P.free[di] = !(w.otherEvents || []).some((e) => e.day === date);
    });
    for (const s of w.shifts) {
      const di = DATES.indexOf(s.day); if (di < 0) continue;
      if (!jobs.includes(s.job)) { P.free[di] = false; P.otherPaid += paidHours(s); continue; }
      const [a, b] = shiftSpan(s);
      const brk = unpaidWindows(s).map(([p, q]) => [p - a, q - a]);
      const win = P.wins[di].find(([x, y]) => x <= a && y >= b) || null;
      const mustMove = !win && !!P.rawWins[di].find(([x, y]) => x <= a && y >= b); // only a manager rule rules it out
      shifts.push({ P, di, s: a, len: b - a, brk, src: s, mustMove, win: win || (mustMove ? P.wins[di].find(([x, y]) => y - x >= b - a) || null : null) });
    }
    people.set(k, P);
  }

  // ── units: a pair on the same shift moves as one ──────────────────────────
  const units = [];
  for (let di = 0; di < 7; di++) {
    const ds = shifts.filter((x) => x.di === di), used = new Set();
    for (const x of ds) {
      if (used.has(x)) continue; used.add(x);
      const pk = partnerOf(x.P.k);
      if (pk) {
        const y = ds.find((z) => z.P.k === pk);
        if (y && y.s === x.s && y.len === x.len) {
          used.add(y);
          const win = x.win && y.win ? [Math.max(x.win[0], y.win[0]), Math.min(x.win[1], y.win[1])] : null;
          const fixed = x.P.fixedPerson || y.P.fixedPerson;
          units.push({ members: [x, y], di, s: x.s, len: x.len, win, pair: true, status: fixed || past(di) ? "kept" : win ? "movable" : "outside" });
        } else units.push({ members: [x], di, s: x.s, len: x.len, win: x.win, status: "pairkept", note: y ? "pair on different shifts — kept" : "partner not scheduled — kept" });
        continue;
      }
      const fx = R.fixed.get(x.P.k);
      units.push({ members: [x], di, s: x.s, len: x.len, win: x.win, mustMove: x.mustMove,
        status: x.P.fixedPerson || past(di) ? "kept" : !x.win ? (x.mustMove ? "nofit" : "outside")
          : fx && (x.s !== fx[0] || x.len !== fx[1] - fx[0]) ? "fixedoff" : "movable" });
    }
  }
  for (const u of units) { u.cur = { di: u.di, s: u.s, len: u.len, lo: null }; u.solo = u.members.length === 1 && !u.pair; }

  // ── coverage, incremental ─────────────────────────────────────────────────
  const slots = DATES.map(() => new Float64Array(NS));
  const covIdx = (m, st, len, lo) => {
    const brk = lo == null ? (len === m.len ? m.brk : []) : [[lo, lo + 60]], out = [];
    for (let t = st; t < st + len; t += SLOT) { const off = t - st; if (brk.some(([a, b]) => off >= a && off < b)) continue; const i = Math.floor(t / SLOT); if (i < NS) out.push(i); }
    return out;
  };
  const apply = (u, c, sign) => { for (const m of u.members) for (const i of covIdx(m, c.s, c.len, c.lo)) slots[c.di][i] += sign; };
  let FLOOR = null, BONUS = 0;
  const dayCost = (di) => {
    let a = 0; const sl = slots[di];
    for (let h = 0; h < 24; h++) {
      const v = (sl[h * 4] + sl[h * 4 + 1] + sl[h * 4 + 2] + sl[h * 4 + 3]) / 4, n = need[di][h], g = v - n;
      if (FLOOR && v < FLOOR[di][h] - 1e-9) a += 3000 * (FLOOR[di][h] - v);
      a += (Math.abs(g) < 1e-9 && n > 0 ? -BONUS : 0) + 10 * Math.abs(g) + 0.2 * g * g + (n === 0 ? 40 * Math.abs(g) : 0)
        + ((WEEKEND.includes(di) || peak.includes(h)) && g < 0 ? 3000 * -g : 0);
    }
    return a;
  };
  const hourly = (di) => Array.from({ length: 24 }, (_, h) => +((slots[di][h * 4] + slots[di][h * 4 + 1] + slots[di][h * 4 + 2] + slots[di][h * 4 + 3]) / 4).toFixed(2));
  for (const u of units) apply(u, u.cur, 1);
  const before = DATES.map((_, di) => hourly(di));
  FLOOR = before.map((b, di) => need[di].map((n, h) => Math.min(floorPct * n, b[h])));

  const occ = new Map(); for (const P of people.values()) occ.set(P.k, new Array(7).fill(null));
  for (const u of units) for (const m of u.members) occ.get(m.P.k)[u.cur.di] = u;
  const changeCost = (u, c) => (c.di !== u.di ? DAY_COST : c.s !== u.s || c.len !== u.len ? MOVE_COST : c.lo != null ? LUNCH_COST : 0) - (c.len > u.len ? EXT_CREDIT : 0);
  const weekPaid = (P) => P.otherPaid + occ.get(P.k).reduce((a, x) => a + (x ? paid(x.cur.len) : 0), 0);
  const restOK = (P, di, st, en, self) => {
    const o = occ.get(P.k), prev = di > 0 ? o[di - 1] : null, next = di < 6 ? o[di + 1] : null;
    if (prev && prev !== self && st + 1440 - (prev.cur.s + prev.cur.len) < REST) return false;
    if (next && next !== self && next.cur.s + 1440 - en < REST) return false;
    return true;
  };

  function options(u) {
    const out = [], P = u.members[0].P, fx = R.fixed.get(P.k);
    if (u.status !== "movable") return [{ di: u.di, s: u.s, len: u.len, lo: null }];
    const canDay = allowDayMoves && u.solo && !R.noDayMove.has(P.k) && !WEEKEND.includes(u.di) && !fx;
    for (const di of canDay ? [0, 1, 2, 3, 4, 5, 6] : [u.di]) {
      if (past(di)) continue;
      let win;
      if (di === u.di) win = u.win;
      else { if (!P.free[di] || (occ.get(P.k)[di] && occ.get(P.k)[di] !== u)) continue; win = P.wins[di].find(([a, b]) => b - a >= u.len) || null; if (!win) continue; }
      const [open, close] = openClose[di]; if (close <= open) continue;
      const ext = allowExtend && u.len < BLOCK && !u.members.some((m) => m.P.minor) && !fx &&
        u.members.every((m) => weekPaid(m.P) + paid(BLOCK) - paid(u.len) <= m.P.maxWeek);
      for (const len of ext ? [u.len, BLOCK] : [u.len]) {
        const starts = [];
        if (fx) starts.push(fx[0]);
        else for (let st = Math.ceil(Math.max(win[0], open) / startStep) * startStep; st + len <= Math.min(win[1], close); st += startStep) starts.push(st);
        if (di === u.di && len === u.len && !starts.includes(u.s) && !u.mustMove) starts.push(u.s);
        for (const st of starts) {
          if (st < win[0] || st + len > win[1]) continue;
          if (u.members.some((m) => m.P.minor) && di >= 2 && (di !== u.di || st < u.s)) continue;
          if (!u.members.every((m) => restOK(m.P, di, st, st + len, u))) continue;
          if (di === u.di && st === u.s && len === u.len) out.push({ di, s: st, len, lo: null });
          else for (const lo of LUNCH_OFFS(len)) out.push({ di, s: st, len, lo });
        }
      }
    }
    return out;
  }

  const movable = units.filter((u) => u.status === "movable");
  for (const phase of [0, 1]) {
    BONUS = phase ? matchBonus : 0;
    for (let pass = 0; pass < 25; pass++) {
      let changed = 0;
      for (const u of movable) {
        const cur = u.cur; apply(u, cur, -1);
        const baseDay = DATES.map((_, di) => dayCost(di));
        apply(u, cur, 1);
        const curV = u.mustMove && cur.di === u.di && cur.s === u.s && cur.len === u.len ? Infinity : dayCost(cur.di) - baseDay[cur.di] + changeCost(u, cur);
        apply(u, cur, -1);
        let best = cur, bestC = curV;
        for (const c of options(u)) { apply(u, c, 1); const v = dayCost(c.di) - baseDay[c.di] + changeCost(u, c); apply(u, c, -1); if (v < bestC - 1e-9) { bestC = v; best = c; } }
        if (best !== cur) { for (const m of u.members) { occ.get(m.P.k)[cur.di] = null; occ.get(m.P.k)[best.di] = u; } u.cur = best; changed++; }
        apply(u, u.cur, 1);
      }
      if (!changed) break;
    }
  }

  // ── changes list ──────────────────────────────────────────────────────────
  const changes = [];
  for (const u of units) {
    const c = u.cur; if (c.di === u.di && c.s === u.s && c.len === u.len && c.lo == null) continue;
    for (const m of u.members) {
      const base = { name: m.P.name, workerId: m.P.w.workerId, day: DATES[u.di], from: m.src.start, expectEnd: m.src.end, job: m.src.job };
      const lunch = c.lo != null ? { lunch: fmt(c.s + c.lo) } : c.len === u.len ? {} : { lunch: "none" };
      const t = { start: fmt(c.s), end: fmt(c.s + c.len), ...lunch };
      changes.push(c.di === u.di ? { ...base, action: "edit", ...t } : { ...base, action: "move", toDay: DATES[c.di], ...t });
    }
  }
  const after = DATES.map((_, di) => hourly(di));
  const blue = (rows) => rows.reduce((a, r, di) => a + r.filter((v, h) => need[di][h] > 0 && Math.abs(v - need[di][h]) < 1e-9).length, 0);
  return {
    changes,
    days: DATES.map((date, di) => ({ date, need: need[di], before: before[di], after: after[di] })),
    stats: { blueBefore: blue(before), blueAfter: blue(after), units: units.length, movable: movable.length,
      dayMoves: changes.filter((x) => x.action === "move").length, stretched: units.filter((u) => u.cur.len > u.len).length },
    notes: units.filter((u) => u.status !== "movable" && u.status !== "kept").map((u) => ({
      names: u.members.map((m) => m.P.name), day: DATES[u.di], shift: `${fmt(u.s)}-${fmt(u.s + u.len)}`,
      why: u.note || (u.status === "outside" ? "shift is outside their availability — left as is" : u.status === "nofit" ? "breaks a people rule and no window fits — left as is" : u.status === "fixedoff" ? "fixed-time rule doesn't match the current shift — left as is" : u.status) })),
  };
}
