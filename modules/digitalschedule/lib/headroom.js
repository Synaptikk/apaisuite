// modules/digitalschedule/lib/headroom.js
//
// How many more paid hours each associate in scope could legally take this
// week, and how much of that lands on hours the guidance graph is short.
// Pure; works on the queued-state `read` result.
//
// Per associate: cap (part-time 33.75, else 40) less paid hours on ALL jobs,
// then every open, editable day (no shift, no PTO/other event) whose
// availability window (less exceptions) allows a shift of at least 4 h.
// A day's best shift is the window capped at 9 h (8 paid + lunch). Limits:
// 5 working days for full-timers, 6 for part-timers; minors get no weekday
// (school hours, validator 12024). Rest between shifts is not modelled —
// check_with_scheduler catches it.

import { DOW, coverage, paidHours, isMinor, IN_HOME_JOB } from "./coverage.js";
import { windowsFor } from "./suggest.js";

const MIN_SHIFT = 240, BLOCK = 540;
const r2 = (x) => Math.round(x * 100) / 100;
const paidOf = (len) => (len - (len > 360 ? 60 : 0)) / 60;

/** Paid hours → shift length (whole hours, +1 h lunch past 6 h), floor 4 h. */
export const lenFor = (paidH) => { const h = Math.max(4, Math.floor(paidH)); return Math.min(BLOCK, h * 60 + (h > 6 ? 60 : 0)); };

/** Best whole-hour start for a shift of up to `len` min inside the windows: most short guidance covered, then least over. */
export function bestShift(day, wins, len) {
  let best = null;
  for (const [a, b] of wins) {
    const L = Math.min(b - a, len);
    if (L < MIN_SHIFT) continue;
    for (let st = Math.ceil(a / 60) * 60; st + L <= b; st += 60) {
      let short = 0, over = 0;
      for (let m = st; m < st + L; m += 15) { const h = Math.floor(m / 60); if (h >= 24) { over += 0.25; continue; }
        if (day.have[h] < day.need[h] - 1e-9) short += 0.25; else over += 0.25; }
      if (!best || short > best.short || (short === best.short && over < best.over)) best = { start: st, len: L, paid: paidOf(L), short, over };
    }
  }
  return best;
}

export function headroom(data, { roleId, jobs, editableFrom = null } = {}) {
  const days = coverage(data, roleId, jobs);
  const inScope = (w) => w.shifts.some((s) => jobs.includes(s.job)) || jobs.includes(String(w.job || ""));
  const rows = [];
  for (const w of data.workers.filter(inScope)) {
    if (String(w.job || "").includes(IN_HOME_JOB) || w.shifts.some((s) => s.job === IN_HOME_JOB)) continue;
    const part = /part/i.test(`${w.employmentType} ${w.payType}`), cap = part ? 33.75 : 40, minor = isMinor(w);
    const now = w.shifts.reduce((a, s) => a + paidHours(s), 0);
    const worked = new Set(w.shifts.map((s) => s.day)), busy = new Set((w.otherEvents || []).map((e) => e.day));
    const maxDays = part ? 6 : 5;
    const open = [];
    data.dates.forEach((date, di) => {
      if (worked.has(date) || busy.has(date) || (editableFrom && date < editableFrom)) return;
      if (minor && di >= 2) return;
      const wins = windowsFor(w, di, date).map(([a, b]) => [a, Math.min(b, 1440)]).filter(([a, b]) => b - a >= MIN_SHIFT);
      if (!wins.length) return;
      const best = bestShift(days[di], wins, BLOCK);
      if (best) open.push({ di, date, wins, ...best });
    });
    let room = Math.max(0, cap - now), slots = Math.max(0, maxDays - worked.size);
    const picks = [...open].sort((a, b) => b.short - a.short || b.paid - a.paid).filter(() => slots-- > 0)
      .map((o) => { if (o.paid <= room) { room -= o.paid; return o; }
        const t = room >= 4 ? bestShift(days[o.di], o.wins, lenFor(room)) : null; if (t) room -= t.paid; return t && { ...o, ...t }; })
      .filter((o) => o && o.paid >= 4);
    const legal = picks.reduce((a, o) => a + o.paid, 0);
    rows.push({ name: w.name, part, minor, now: r2(now), cap, capRoom: r2(Math.max(0, cap - now)), legal: r2(legal),
      useful: r2(picks.reduce((a, o) => a + Math.min(o.short, o.paid), 0)), picks,
      why: legal ? null : cap - now < 4 ? "at cap" : worked.size >= maxDays ? `already ${worked.size} days` : minor ? "minor: weekends only, none open" : "no open day with a 4 h+ availability window" });
  }
  rows.sort((a, b) => b.legal - a.legal);
  const tot = (k) => r2(rows.reduce((a, r) => a + r[k], 0));
  return { rows, totals: { capRoom: tot("capRoom"), legal: tot("legal"), useful: tot("useful"),
    short: r2(days.reduce((a, d) => a + d.need.reduce((t, n, h) => t + Math.max(0, n - d.have[h]), 0), 0)) } };
}

const t12 = (m) => { const h = Math.floor(m / 60) % 24, mm = m % 60; return `${h % 12 || 12}${mm ? ":" + String(mm).padStart(2, "0") : ""}${h < 12 ? "a" : "p"}`; };
export function headroomText(out) {
  const t = out.totals;
  return `Totals: ${t.capRoom} h under weekly caps; ${t.legal} h placeable (open day + availability + day limits); ${t.useful} h of that lands on short hours (the role is short ${t.short} h in all).\n`
    + out.rows.map((r) => `${r.name} (${r.part ? "PT" : "FT"}${r.minor ? " MINOR" : ""}) ${r.now}/${r.cap} h: `
      + (r.legal ? `+${r.legal} h — ${r.picks.map((o) => `${DOW[o.di]} ${t12(o.start)}-${t12(o.start + o.len)} (${o.paid} paid, ${o.short} on short hours)`).join(", ")}` : `+0 (${r.why})`)).join("\n");
}
