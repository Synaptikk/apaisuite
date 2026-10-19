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
//   - the peak window (coverage.js PEAK, 2p-5p) never short
//   - no hour below `floorPct` of guidance (or below today's level where it already is)
//   - whole-hour starts; 9 h blocks; 1 h unpaid lunch on every shift over 6 h,
//     placed 3-4 h in (validator 10017 / 10054)
//   - In Home Delivery drivers untouched; minors never moved onto weekdays or
//     earlier on a weekday (school hours, validator 12024 HARD)
//   - 10 h rest between shifts (hard; the legal floor is 8) and a cost for every hour under 12
//     (store rule: no closing late and coming right back) — checked across the week edges too
//     when `neighbors` carries last week's Friday end / next week's Saturday start;
//     weekly paid hours cap (40, part-time 33.75)
//   - people rules from lib/rules.js
//   - full-time = 5 x 9 h shifts (40 paid): a full-timer under 40 is credited for
//     every hour they get back - short shifts stretch to 9 h, open days get a
//     new 9 h shift where it helps the graph most (ftHours)
//   - anyone with open days (not at their weekly cap) can be given an added shift
//     when the gap it covers is worth more than CREATE_COST (fill)
//   - relay moves: a flexible associate moves into a gap and someone whose
//     availability only fits the slot they left takes it (a single move sees
//     only half of that and never makes it)
//
// Output is a changes list in the same shape lib/page.js validates and saves.

import { toMin, fmt, IN_HOME_JOB, needFor, unpaidWindows, shiftSpan, paidHours, isMinor, PEAK, isOvernight, DAY_START } from "./coverage.js";
import { nameKey } from "./rules.js";
import { inArea, isSetUp } from "./areas.js";

const AREA_GAP = 5000;   // per 15 min an open-to-close area has nobody on the floor
const SLOT = 15, NS = 96 + 16, LUNCH_MIN = 360, BLOCK = 540, REST = 600;
const MOVE_COST = 6, DAY_COST = 10, EXT_CREDIT = 4, LUNCH_COST = 2;
const CREATE_COST = 15;   // an added shift has to cover more than ~1.5 FTE-hours of gap
const FT_HOUR = 8;        // per paid hour a full-timer sits under ftHours
const LOSS_HOUR = 12;     // per paid hour anyone drops below what they had
const MAX_DAYS = 5;
// store rule (2026-10-18): red (over guidance) beats yellow (short) — a short hour costs more than an over one
const UNDER_W = 14, OVER_W = 6;
const REST_PREF = 720, REST_W = 10;   // per hour of rest under 12 h
const SOFT_FLOOR = 30;     // per FTE below today's level, in an hour that was already under floorPct
const paid = (len) => (len - (len > LUNCH_MIN ? 60 : 0)) / 60;
const LUNCH_OFFS = (len) => len > LUNCH_MIN ? [180, 240].filter((o) => o + 60 <= len - 60) : [null];

export function windowsFor(w, di, date) {
  const exc = (w.exceptions || []).some((e) => e.unavailable !== false && String(e.from).slice(0, 10) <= date && String(e.to).slice(0, 10) > date);
  const v = w.availability?.[["sat", "sun", "mon", "tue", "wed", "thu", "fri"][di]];
  if (exc || v == null || v === "off") return [];
  if (v === "any") return [[0, 1440]];
  return String(v).split(",").map((r) => { const [a, b] = r.split("-").map(toMin); return [a, b <= a ? b + 1440 : b]; }).filter(([a, b]) => b > a);
}

export function suggest(data, opts = {}) {
  const {
    roleId = 1000271, roleIds = roleId, jobs = ["1-936-1451"], keepJobs = [IN_HOME_JOB], rules = null,
    floorPct = 0.85, matchBonus = 5, protectWeekend = true, peak = PEAK,
    startStep = 60, allowExtend = true, allowDayMoves = true, lock = [],
    // roleIds: one role id or several; their guidance is summed
    roleJobs = null,       // { roleId: [job codes] }: with several roles, each shift counts only toward its own job's role
    areas = [],            // open-to-close areas (lib/areas.js): never leave one with nobody on the floor
    editableFrom = null,   // "YYYY-MM-DD": days before it are already worked — never touched
    fill = true,           // add shifts on open days (full-timers under ftHours, gaps nobody else can reach)
    ftHours = 40,          // full-time target: 5 x 9 h shifts
    relay = true,          // two-person moves (see header)
    neighbors = {},        // { workerId: { prevEnd, nextStart } } minutes from day 0 midnight (last week's Fri end is negative)
  } = opts;
  const R = rules || { pairs: [], fixed: new Map(), daysOnly: new Map(), windows: new Map(), noDayMove: new Set(), keep: new Set() };
  const locked = new Set(lock.map(String));
  const DATES = data.dates, WEEKEND = protectWeekend ? [0, 1] : [];
  const past = (di) => !!editableFrom && DATES[di] < editableFrom;
  // One group per role: its own guidance line and the job codes whose shifts count toward it.
  // A single role (or no role → job map) is one group holding every job, as before.
  const ids = [roleIds].flat().map(Number);
  const GROUPS = ids.length > 1 && roleJobs
    ? ids.map((r) => ({ r, jobs: new Set((roleJobs[r] || []).filter((j) => jobs.includes(j))) })).filter((g) => g.jobs.size)
    : [{ r: ids, jobs: new Set(jobs) }];
  for (const g of GROUPS) {
    g.need = needFor(data, g.r);
    g.openClose = g.need.map((n) => { const hrs = n.map((v, h) => (v > 0 ? h : null)).filter((h) => h != null);
      return hrs.length ? [hrs[0] * 60, (hrs.at(-1) + 1) * 60] : [0, 0]; });
  }
  const groupOf = (job) => GROUPS.findIndex((g) => g.jobs.has(job));
  const need = DATES.map((_, di) => Array.from({ length: 24 }, (_, h) => GROUPS.reduce((t, g) => t + g.need[di][h], 0)));
  const partnerOf = (k) => { for (const p of R.pairs) { if (p[0] === k) return p[1]; if (p[1] === k) return p[0]; } return null; };

  // ── people + the shifts in play ───────────────────────────────────────────
  const people = new Map(), shifts = [], areaFixed = [];
  for (const w of data.workers) {
    const k = nameKey(w.name);
    const inHome = String(w.job || "").includes(IN_HOME_JOB) || w.shifts.some((s) => keepJobs.includes(s.job));
    const P = { w, k, name: w.name, minor: isMinor(w), inHome,
      fixedPerson: inHome || R.keep.has(k) || locked.has(String(w.workerId)) || locked.has(k),
      maxWeek: /part/i.test(`${w.employmentType} ${w.payType}`) ? 33.75 : 40, otherPaid: 0, wins: [], free: [],
      ft: /full/i.test(String(w.employmentType || "")) && !/part/i.test(`${w.employmentType} ${w.payType}`),
      job: jobs.includes(w.job) ? w.job : w.shifts.find((s) => jobs.includes(s.job))?.job || null,
      // PTO days count toward the full-time 40 (8 h each; the scheduler doesn't carry PTO hours)
      pto: new Set((w.otherEvents || []).filter((e) => /pto|vac|holiday|sick/i.test(e.type || "") && DATES.includes(e.day)).map((e) => e.day)).size };
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
      if (!jobs.includes(s.job)) { P.free[di] = false; P.otherPaid += paidHours(s); areaFixed.push({ w, s, di }); continue; }
      const [a, b] = shiftSpan(s);
      const brk = unpaidWindows(s).map(([p, q]) => [p - a, q - a]);
      const win = P.wins[di].find(([x, y]) => x <= a && y >= b) || null;
      const mustMove = !win && !!P.rawWins[di].find(([x, y]) => x <= a && y >= b); // only a manager rule rules it out
      shifts.push({ P, di, s: a, len: b - a, brk, src: s, mustMove, overnight: isOvernight(s), g: groupOf(s.job), win: win || (mustMove ? P.wins[di].find(([x, y]) => y - x >= b - a) || null : null) });
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
          const fixed = x.P.fixedPerson || y.P.fixedPerson || x.g < 0 || x.g !== y.g || x.overnight || y.overnight;
          units.push({ members: [x, y], di, s: x.s, len: x.len, win, pair: true, status: fixed || past(di) ? "kept" : win ? "movable" : "outside" });
        } else units.push({ members: [x], di, s: x.s, len: x.len, win: x.win, status: "pairkept", note: y ? "pair on different shifts — kept" : "partner not scheduled — kept" });
        continue;
      }
      const fx = R.fixed.get(x.P.k);
      units.push({ members: [x], di, s: x.s, len: x.len, win: x.win, mustMove: x.mustMove,
        status: x.P.fixedPerson || past(di) || x.g < 0 || x.overnight ? "kept" : !x.win ? (x.mustMove ? "nofit" : "outside")
          : fx && (x.s !== fx[0] || x.len !== fx[1] - fx[0]) ? "fixedoff" : "movable" });
    }
  }
  // ── open days: one candidate (unplaced) shift per person per day off ──────
  if (fill) for (const P of people.values()) {
    const g = P.job ? groupOf(P.job) : -1;
    if (P.fixedPerson || P.minor || g < 0 || partnerOf(P.k) || P.w.shifts.some(isOvernight)) continue;   // overnight pickers stay on the event
    for (let di = 0; di < 7; di++) {
      if (past(di) || !P.free[di] || !P.wins[di].length || shifts.some((x) => x.P === P && x.di === di)) continue;
      units.push({ members: [{ P, di, s: 0, len: 0, brk: [], src: null, g }], di, s: 0, len: 0, win: null, status: "movable", ghost: true });
    }
  }
  for (const u of units) { u.cur = { di: u.di, s: u.s, len: u.len, lo: null }; u.solo = u.members.length === 1 && !u.pair; }

  // ── coverage, incremental ─────────────────────────────────────────────────
  const slots = GROUPS.map(() => DATES.map(() => new Float64Array(NS)));
  const covIdx = (m, st, len, lo) => {
    const brk = lo == null ? (len === m.len ? m.brk : []) : [[lo, lo + 60]], out = [];
    for (let t = st; t < st + len; t += SLOT) { const off = t - st; if (brk.some(([a, b]) => off >= a && off < b)) continue; const i = Math.floor(t / SLOT); if (i < NS) out.push(i); }
    return out;
  };
  // open-to-close areas: people on the floor per 15-min slot; shifts outside the fitted jobs never move
  const AREAS = areas.filter(isSetUp).map((a) => { let lo = Math.floor(toMin(a.open) / SLOT), hi = Math.ceil(toMin(a.close) / SLOT); if (!(hi > lo)) hi = 96; return { a, lo, hi, on: DATES.map(() => new Float64Array(NS)) }; });
  for (const u of units) for (const m of u.members) m.areas = AREAS.filter((A) => inArea(A.a, m.P.name, m.src ? m.src.job : m.P.job));
  for (const { w, s, di } of areaFixed) for (const A of AREAS) if (inArea(A.a, w.name, s.job)) {
    const [a, b] = shiftSpan(s), off = unpaidWindows(s);
    for (let m = a; m < b; m += SLOT) { if (off.some(([p, q]) => m >= p && m < q)) continue; const dd = di + Math.floor(m / 1440), i = Math.floor((m % 1440) / SLOT); if (A.on[dd]) A.on[dd][i]++; }
  }
  const areaGapSlots = (di) => AREAS.reduce((t, A) => { let n = 0; for (let i = A.lo; i < A.hi; i++) if (A.on[di][i] < 0.5) n++; return t + n; }, 0);
  const apply = (u, c, sign) => { for (const m of u.members) { const idx = covIdx(m, c.s, c.len, c.lo);
    if (m.g >= 0) for (const i of idx) slots[m.g][c.di][i] += sign;
    for (const A of m.areas) for (const i of idx) { const dd = c.di + Math.floor(i / 96), j = i % 96; if (A.on[dd]) A.on[dd][j] += sign; } } };
  let FLOOR = null, BONUS = 0;
  const dayCost = (di) => {
    let a = 0;
    for (let gi = 0; gi < GROUPS.length; gi++) { const sl = slots[gi][di], nd = GROUPS[gi].need[di], fl = FLOOR?.[gi][di];
    for (let h = 0; h < 24; h++) {
      const v = (sl[h * 4] + sl[h * 4 + 1] + sl[h * 4 + 2] + sl[h * 4 + 3]) / 4, n = nd[h], g = v - n;
      // floor: opening a gap below floorPct is near-forbidden; an hour that was already
      // under it may dip (a new lunch) at a soft price when the shift pays it back elsewhere
      if (fl && v < fl[h] - 1e-9) a += (fl[h] < floorPct * n - 1e-9 ? SOFT_FLOOR : 3000) * (fl[h] - v);
      a += (Math.abs(g) < 1e-9 && n > 0 ? -BONUS : 0) + (g < 0 ? UNDER_W : OVER_W) * Math.abs(g) + 0.2 * g * g + (n === 0 ? 40 * Math.abs(g) : 0)
        + ((WEEKEND.includes(di) || peak.includes(h)) && g < 0 ? 3000 * -g : 0);
    } }
    return a + AREA_GAP * areaGapSlots(di);
  };
  const hourlyG = (gi, di) => Array.from({ length: 24 }, (_, h) => +((slots[gi][di][h * 4] + slots[gi][di][h * 4 + 1] + slots[gi][di][h * 4 + 2] + slots[gi][di][h * 4 + 3]) / 4).toFixed(2));
  const hourly = (di) => Array.from({ length: 24 }, (_, h) => +GROUPS.reduce((t, _, gi) => t + hourlyG(gi, di)[h], 0).toFixed(2));
  const snapG = () => GROUPS.map((_, gi) => DATES.map((_, di) => hourlyG(gi, di)));
  for (const u of units) apply(u, u.cur, 1);
  const before = DATES.map((_, di) => hourly(di)), beforeG = snapG();
  const gapsBefore = DATES.reduce((t, _, di) => t + areaGapSlots(di), 0);
  FLOOR = GROUPS.map((g, gi) => beforeG[gi].map((b, di) => g.need[di].map((n, h) => Math.min(floorPct * n, b[h]))));

  const occ = new Map(); for (const P of people.values()) occ.set(P.k, new Array(7).fill(null));
  for (const u of units) if (u.cur.len) for (const m of u.members) occ.get(m.P.k)[u.cur.di] = u;
  const changeCost = (u, c) => u.ghost ? (c.len ? CREATE_COST : 0)
    : (c.di !== u.di ? DAY_COST : c.s !== u.s || c.len !== u.len ? MOVE_COST : c.lo != null ? LUNCH_COST : 0) - (c.len > u.len ? EXT_CREDIT : 0);
  const weekPaid = (P) => P.otherPaid + occ.get(P.k).reduce((a, x) => a + (x ? paid(x.cur.len) : 0), 0);
  const daysOn = (P) => occ.get(P.k).filter(Boolean).length;
  for (const P of people.values()) P.basePaid = weekPaid(P);
  // hours: full-timers toward ftHours (5 x 9 h), nobody below what they already had
  const ftTarget = (P) => Math.min(ftHours - 8 * P.pto, P.maxWeek);
  const hoursCost = (P, wp) => (P.ft && !P.fixedPerson ? FT_HOUR * Math.max(0, ftTarget(P) - wp) : 0) + LOSS_HOUR * Math.max(0, P.basePaid - wp);
  const pTerm = (u, c) => u.members.reduce((t, m) => t + hoursCost(m.P, weekPaid(m.P) - paid(u.cur.len) + paid(c.len)), 0);
  const setCur = (u, c) => {
    apply(u, u.cur, -1);
    for (const m of u.members) { const o = occ.get(m.P.k); if (o[u.cur.di] === u) o[u.cur.di] = null; if (c.len) o[c.di] = u; }
    u.cur = c; apply(u, c, 1);
  };
  // minutes of rest before and after a shift on day di (Infinity when nothing is next to it)
  const restGaps = (P, di, st, en, self) => {
    const o = occ.get(P.k), prev = di > 0 ? o[di - 1] : null, next = di < 6 ? o[di + 1] : null, nb = neighbors[P.w.workerId] || {};
    const before = prev && prev !== self ? st + 1440 - (prev.cur.s + prev.cur.len) : di === 0 && nb.prevEnd != null ? st - nb.prevEnd : Infinity;
    const after = next && next !== self ? next.cur.s + 1440 - en : di === 6 && nb.nextStart != null ? nb.nextStart - (6 * 1440 + en) : Infinity;
    return [before, after];
  };
  const restOK = (P, di, st, en, self) => restGaps(P, di, st, en, self).every((g) => g >= REST);
  const restCost = (u, c) => !c.len ? 0 : u.members.reduce((t, m) => t + restGaps(m.P, c.di, c.s, c.s + c.len, u).reduce((a, g) => a + REST_W * Math.max(0, REST_PREF - g) / 60, 0), 0);

  function options(u) {
    const out = [], P = u.members[0].P, fx = R.fixed.get(P.k);
    if (u.status !== "movable") return [{ di: u.di, s: u.s, len: u.len, lo: null }];
    if (u.ghost) {
      const di = u.di, o = occ.get(P.k);
      out.push({ di, s: 0, len: 0, lo: null });
      if ((o[di] && o[di] !== u) || (!o[di] && daysOn(P) >= MAX_DAYS)) return out;
      const [open, close] = GROUPS[u.members[0].g].openClose[di]; if (close <= open) return out;
      const room = P.maxWeek - (weekPaid(P) - paid(u.cur.len));
      const lens = [BLOCK, LUNCH_MIN].filter((l) => paid(l) <= room + 1e-9).slice(0, 1);   // a full 9 h shift, else 6 h
      for (const len of lens) for (const [a, b] of P.wins[di]) {
        const starts = fx ? [fx[0]] : [];
        if (!fx) for (let st = Math.ceil(Math.max(a, open) / startStep) * startStep; st + len <= Math.min(b, close); st += startStep) starts.push(st);
        for (const st of starts) {
          if (st < a || st + len > b || !restOK(P, di, st, st + len, u)) continue;
          for (const lo of LUNCH_OFFS(len)) out.push({ di, s: st, len, lo });
        }
      }
      return out;
    }
    const canDay = allowDayMoves && u.solo && !R.noDayMove.has(P.k) && !WEEKEND.includes(u.di) && !fx;
    for (const di of canDay ? [0, 1, 2, 3, 4, 5, 6] : [u.di]) {
      if (past(di)) continue;
      let win;
      if (di === u.di) win = u.win;
      else { if (!P.free[di] || (occ.get(P.k)[di] && occ.get(P.k)[di] !== u)) continue; win = P.wins[di].find(([a, b]) => b - a >= u.len) || null; if (!win) continue; }
      const [open, close] = GROUPS[u.members[0].g].openClose[di]; if (close <= open) continue;
      const ext = allowExtend && u.len < BLOCK && !u.members.some((m) => m.P.minor) && !fx &&
        u.members.every((m) => weekPaid(m.P) + paid(BLOCK) - paid(u.cur.len) <= m.P.maxWeek);
      for (const len of ext ? [u.len, BLOCK] : [u.len]) {
        const starts = [];
        if (fx) starts.push(fx[0]);
        else for (let st = Math.ceil(Math.max(win[0], open) / startStep) * startStep; st + len <= Math.min(win[1], close); st += startStep) starts.push(st);
        if (di === u.di && len === u.len && !starts.includes(u.s) && !u.mustMove) starts.push(u.s);
        for (const st of starts) {
          if (st < win[0] || st + len > win[1]) continue;
          if (u.members.some((m) => m.P.minor) && di >= 2 && (di !== u.di || st < u.s)) continue;
          if (!u.members.every((m) => restOK(m.P, di, st, st + len, u))) continue;
          // same shift: keep it, or only re-time its lunch (staggers lunches inside an area)
          if (di === u.di && st === u.s && len === u.len) { out.push({ di, s: st, len, lo: null }); if (len > LUNCH_MIN) for (const lo of LUNCH_OFFS(len)) if (lo != null) out.push({ di, s: st, len, lo }); }
          else for (const lo of LUNCH_OFFS(len)) out.push({ di, s: st, len, lo });
        }
      }
    }
    return out;
  }

  // Relay: A takes a new slot on its day, B (same role, same day) takes the slot A left.
  const localCost = (ds, us) => [...ds].reduce((t, di) => t + dayCost(di), 0)
    + us.reduce((t, u) => t + changeCost(u, u.cur) + restCost(u, u.cur) + u.members.reduce((a, m) => a + hoursCost(m.P, weekPaid(m.P)), 0), 0);
  function relayPass() {
    let moved = 0;
    const placed = units.filter((u) => u.status === "movable" && u.solo && u.cur.len);
    for (const A of placed) {
      const a0 = A.cur, mates = placed.filter((B) => B !== A && B.cur.len && B.cur.di === a0.di && B.members[0].g === A.members[0].g);
      if (!mates.length || !a0.len) continue;
      const aOpts = options(A).filter((c) => c.di === a0.di && c.len && (c.s !== a0.s || c.len !== a0.len));
      for (const B of mates) {
        const b0 = B.cur;
        const bOpts = options(B).filter((c) => c.di === a0.di && c.len === b0.len && c.s !== b0.s && (c.s === a0.s || c.s + c.len === a0.s + a0.len));
        if (!bOpts.length) continue;
        const ds = new Set([a0.di]), base = localCost(ds, [A, B]);
        let best = null, bestV = base - 1e-6;
        for (const bc of bOpts) {
          setCur(B, bc);
          for (const ac of aOpts) { setCur(A, ac); const v = localCost(ds, [A, B]); if (v < bestV) { bestV = v; best = [ac, bc]; } setCur(A, a0); }
          setCur(B, b0);
        }
        if (best) { setCur(B, best[1]); setCur(A, best[0]); moved++; break; }
      }
    }
    return moved;
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
        const curV = (u.mustMove && cur.di === u.di && cur.s === u.s && cur.len === u.len) || (cur.len && !u.members.every((m) => restOK(m.P, cur.di, cur.s, cur.s + cur.len, u))) ? Infinity : dayCost(cur.di) - baseDay[cur.di] + changeCost(u, cur) + pTerm(u, cur) + restCost(u, cur);
        apply(u, cur, -1);
        let best = cur, bestC = curV;
        for (const c of options(u)) { apply(u, c, 1); const v = dayCost(c.di) - baseDay[c.di] + changeCost(u, c) + pTerm(u, c) + restCost(u, c); apply(u, c, -1); if (v < bestC - 1e-9) { bestC = v; best = c; } }
        apply(u, cur, 1);
        if (best !== cur) { setCur(u, best); changed++; }
      }
      if (!changed && !(relay && relayPass())) break;
    }
  }

  // ── changes list ──────────────────────────────────────────────────────────
  const changes = [];
  for (const u of units) {
    const c = u.cur;
    if (u.ghost) {
      if (c.len) { const P = u.members[0].P;
        changes.push({ name: P.name, workerId: P.w.workerId, action: "create", day: DATES[c.di], job: P.job, start: fmt(c.s), end: fmt(c.s + c.len), lunch: c.lo != null ? fmt(c.s + c.lo) : "none", added: true }); }
      continue;
    }
    if (c.di === u.di && c.s === u.s && c.len === u.len && c.lo == null) continue;
    for (const m of u.members) {
      const base = { name: m.P.name, workerId: m.P.w.workerId, day: DATES[u.di], from: m.src.start, expectEnd: m.src.end, job: m.src.job };
      const lunch = c.lo != null ? { lunch: fmt(c.s + c.lo) } : c.len === u.len ? {} : { lunch: "none" };
      const t = { start: fmt(c.s), end: fmt(c.s + c.len), ...lunch };
      changes.push(c.di === u.di ? { ...base, action: "edit", ...t } : { ...base, action: "move", toDay: DATES[c.di], ...t });
    }
  }
  const after = DATES.map((_, di) => hourly(di)), afterG = snapG();
  // blue hours are counted per role: each role's own bar has to match its own guidance
  const blueG = (gi, rows) => rows.reduce((a, r, di) => a + r.filter((v, h) => GROUPS[gi].need[di][h] > 0 && Math.abs(v - GROUPS[gi].need[di][h]) < 1e-9).length, 0);
  const blue = (G) => G.reduce((t, rows, gi) => t + blueG(gi, rows), 0);
  return {
    changes,
    days: DATES.map((date, di) => ({ date, need: need[di], before: before[di], after: after[di] })),
    roles: GROUPS.map((g, gi) => ({ roleId: g.r, blueBefore: blueG(gi, beforeG[gi]), blueAfter: blueG(gi, afterG[gi]) })),
    stats: { blueBefore: blue(beforeG), blueAfter: blue(afterG), units: units.length, movable: movable.length,
      dayMoves: changes.filter((x) => x.action === "move").length,
      areaGapHrsBefore: gapsBefore * SLOT / 60, areaGapHrsAfter: DATES.reduce((t, _, di) => t + areaGapSlots(di), 0) * SLOT / 60, stretched: units.filter((u) => !u.ghost && u.cur.len > u.len).length, added: units.filter((u) => u.ghost && u.cur.len).length },
    // rest under 12 h after the fit (kept shifts the fitter can't move, or no better slot)
    turnarounds: [...people.values()].flatMap((P) => occ.get(P.k).map((u, di) => {
      if (!u) return null; const c = u.cur, [before] = restGaps(P, di, c.s, c.s + c.len, u);
      return before < REST_PREF ? { name: P.name, day: DATES[di], start: fmt(c.s), restH: +(before / 60).toFixed(2) } : null; })
      .concat((() => { const u = occ.get(P.k)[6], nb = neighbors[P.w.workerId]; if (!u || nb?.nextStart == null) return [];
        const g = nb.nextStart - (6 * 1440 + u.cur.s + u.cur.len); return g < REST_PREF ? [{ name: P.name, day: "next week", start: "", restH: +(g / 60).toFixed(2) }] : []; })())
      .filter(Boolean)).sort((a, b) => a.restH - b.restH),
    // whose weekly hours moved, and full-timers still under ftHours (no open day / availability / graph room left)
    hours: [...people.values()].filter((P) => P.job && !P.fixedPerson && (weekPaid(P) !== P.basePaid || (P.ft && weekPaid(P) < ftTarget(P) - 1e-9)))
      .map((P) => { const after = weekPaid(P), short = P.ft && after < ftTarget(P) - 1e-9;
        const open = DATES.filter((_, di) => !occ.get(P.k)[di] && !past(di)), fits = open.filter((_, i) => P.free[DATES.indexOf(open[i])] && P.wins[DATES.indexOf(open[i])].some(([a, b]) => b - a >= BLOCK));
        const narrow = occ.get(P.k).some((u, di) => u && u.cur.len < BLOCK && !P.wins[di].some(([a, b]) => b - a >= BLOCK));
        return { name: P.name, ft: P.ft, before: P.basePaid, after, pto: P.pto, target: P.ft ? ftTarget(P) : null,
          why: !short ? null : daysOn(P) >= MAX_DAYS ? (narrow ? "availability windows too short for 9 h shifts" : "already 5 days") : !fits.length ? "no open day with a 9 h availability window" : narrow ? "availability windows too short for 9 h shifts" : "an added shift would over-staff the graph" }; }),
    notes: units.filter((u) => u.status !== "movable" && u.status !== "kept").map((u) => ({
      names: u.members.map((m) => m.P.name), day: DATES[u.di], shift: `${fmt(u.s)}-${fmt(u.s + u.len)}`,
      why: u.note || (u.status === "outside" ? "shift is outside their availability — left as is" : u.status === "nofit" ? "breaks a people rule and no window fits — left as is" : u.status === "fixedoff" ? "fixed-time rule doesn't match the current shift — left as is" : u.status) })),
  };
}
