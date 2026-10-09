// modules/digitalschedule/lib/coverage.js
//
// Pure helpers over the `read` result of lib/page.js:
//   { ctx, dates[7], demand[{roleId,start,fte}], workers[{workerId,name,job,payType,
//     employmentType,minor,availability,exceptions,shifts[{day,dow,start,end,job,breaks}],otherEvents}] }
//
// Coverage math is the scheduler's own: every 15-minute slot an associate is on
// the clock outside an unpaid break counts 0.25 toward that hour; "blue" means
// scheduled EXACTLY equals guidance (checked against all 119 bars of WK 39).

export const ROLES = {
  1000271: "DPS", 1000560: "DPS ON", 1000545: "Digital TL", 1000415: "Digital AT",
  1000270: "Digital DM", 1000635: "Digital Backroom", 1000525: "In Home Delivery",
};
// role -> job codes whose shifts count toward that role's bars
export const ROLE_JOBS = { 1000271: ["1-936-1451"] };
export const IN_HOME_JOB = "1-930-1481";
export const DOW = ["Sat", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri"];
export const SHORT = ["sat", "sun", "mon", "tue", "wed", "thu", "fri"];

export const toMin = (t) => { const m = String(t).match(/(\d{1,2}):(\d\d)/); return m ? +m[1] * 60 + +m[2] : NaN; };
export const fmt = (m) => String(Math.floor((((m % 1440) + 1440) % 1440) / 60)).padStart(2, "0") + ":" + String(((m % 60) + 60) % 60).padStart(2, "0");
export const fmt12 = (m) => { const h = Math.floor((((m % 1440) + 1440) % 1440) / 60), mm = ((m % 60) + 60) % 60;
  return `${h % 12 || 12}${mm ? ":" + String(mm).padStart(2, "0") : ""}${h < 12 ? "a" : "p"}`; };
const EPS = 1e-9;

/** Unpaid break windows of a shift, in minutes from the shift day's midnight. */
export function unpaidWindows(s) {
  const a = toMin(s.start);
  return (s.breaks || []).filter((x) => !x.paid).map((x) => {
    let p = toMin(x.start), q = toMin(x.end); if (p < a) p += 1440; if (q <= p) q += 1440; return [p, q]; });
}
export function shiftSpan(s) { const a = toMin(s.start); let b = toMin(s.end); if (b <= a) b += 1440; return [a, b]; }
export function paidHours(s) {
  const [a, b] = shiftSpan(s);
  return (b - a - unpaidWindows(s).reduce((t, [p, q]) => t + (q - p), 0)) / 60;
}

export function needFor(data, roleId) {
  const need = data.dates.map(() => Array(24).fill(0));
  for (const d of data.demand || []) if (d.roleId === roleId) {
    const di = data.dates.indexOf(String(d.start).slice(0, 10));
    if (di >= 0) need[di][+String(d.start).slice(11, 13)] += d.fte;
  }
  return need;
}

export function coverage(data, roleId, jobs) {
  const need = needFor(data, roleId);
  const days = data.dates.map((date, di) => ({ date, need: need[di], have: Array(24).fill(0) }));
  for (const w of data.workers) for (const s of w.shifts) {
    if (!jobs.includes(s.job)) continue;
    const di = data.dates.indexOf(s.day); if (di < 0) continue;
    const [a, b] = shiftSpan(s), off = unpaidWindows(s);
    for (let m = a; m < b; m += 15) {
      if (off.some(([p, q]) => m >= p && m < q)) continue;
      const dd = di + Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
      if (days[dd]) days[dd].have[h] += 0.25;
    }
  }
  return days;
}

/** "blue" | "under" | "over" | "" (no guidance and nobody on). */
export function hourState(need, have) {
  if (need <= EPS && have <= EPS) return "";
  if (Math.abs(need - have) < EPS) return "blue";
  return have < need ? "under" : "over";
}

export function summarize(days) {
  return days.map((d) => {
    const hs = d.need.map((n, h) => [h, n, d.have[h]]).filter(([, n, v]) => n > 0 || v > 0);
    const under = hs.filter(([, n, v]) => v < n - EPS), over = hs.filter(([, n, v]) => v > n + EPS);
    const low = hs.filter(([, n]) => n > 0).map(([h, n, v]) => [h, v / n]).sort((a, b) => a[1] - b[1])[0] || null;
    return {
      date: d.date, hours: hs.length,
      blue: hs.filter(([, n, v]) => Math.abs(n - v) < EPS).length,
      under: under.length, underHrs: under.reduce((a, [, n, v]) => a + n - v, 0),
      over: over.length, overHrs: over.reduce((a, [, n, v]) => a + v - n, 0),
      guide: d.need.reduce((a, b) => a + b, 0), sched: d.have.reduce((a, b) => a + b, 0),
      low: low && { hour: low[0], pct: low[1] },
    };
  });
}

// ── local preview of a changes list ─────────────────────────────────────────
// Mirrors lib/page.js's builder closely enough to redraw the coverage before
// the validator is asked. The server's answer (validate/save) is the truth.

const dayIdx = (dates, d) => { if (d == null) return -1; const s = String(d).toLowerCase(); const i = dates.indexOf(s); return i >= 0 ? i : SHORT.indexOf(s.slice(0, 3)); };
const findWorker = (data, ch) => data.workers.find((w) => (ch.workerId && w.workerId === ch.workerId) ||
  (ch.name && String(w.name).toLowerCase() === String(ch.name).toLowerCase()));

export function applyChanges(data, changes) {
  const out = { ...data, workers: data.workers.map((w) => ({ ...w, shifts: w.shifts.map((s) => ({ ...s, breaks: (s.breaks || []).map((b) => ({ ...b })) })) })) };
  const problems = [];
  changes.forEach((ch, idx) => {
    const fail = (why) => problems.push({ idx, why });
    const w = findWorker(out, ch); if (!w) return fail("associate not on this week");
    const di = dayIdx(out.dates, ch.day); if (di < 0) return fail("day not in week");
    const ti = ch.action === "move" ? dayIdx(out.dates, ch.toDay) : di; if (ti < 0) return fail("toDay not in week");
    let i = -1;
    if (ch.action !== "create") {
      i = w.shifts.findIndex((s) => s.day === out.dates[di] && (!ch.from || toMin(s.start) === toMin(ch.from)) && (!ch.job || s.job === ch.job));
      if (i < 0) return fail("shift not found");
    }
    if (ch.action === "delete") { w.shifts.splice(i, 1); return; }
    const old = i >= 0 ? w.shifts[i] : null;
    const s0 = ch.start != null ? toMin(ch.start) : toMin(old.start);
    let e0 = ch.end != null ? toMin(ch.end) : toMin(old.end); if (e0 <= s0) e0 += 1440;
    let breaks;
    if (Array.isArray(ch.breaks)) breaks = ch.breaks.map((b) => ({ start: b.start, end: b.end, paid: !!b.paid }));
    else if (ch.lunch === "none" || ch.lunch === null) breaks = [];
    else if (ch.lunch) breaks = [{ start: ch.lunch, end: fmt(toMin(ch.lunch) + 60), paid: false }];
    else if (old) { const delta = s0 - toMin(old.start); breaks = old.breaks.map((b) => ({ ...b, start: fmt(toMin(b.start) + delta), end: fmt(toMin(b.end) + delta) })); }
    else breaks = [];
    const next = { day: out.dates[ti], dow: SHORT[ti], shiftId: old?.shiftId ?? null, job: ch.job || old?.job || w.job, start: fmt(s0), end: fmt(e0), breaks, changed: true, qIdx: idx };
    if (i >= 0) w.shifts.splice(i, 1);
    w.shifts.push(next);
  });
  return { data: out, problems };
}

/** The inverse change list of a save's `applied[]`; saving it puts everything back. */
export function buildUndo(applied) {
  return applied.map((a) =>
    a.action === "edit" ? { name: a.name, workerId: a.workerId, action: "edit", day: a.next.day, from: a.next.start, start: a.orig.start, end: a.orig.end, breaks: a.orig.breaks, noLunchOk: true }
    : a.action === "move" ? { name: a.name, workerId: a.workerId, action: "move", day: a.next.day, from: a.next.start, toDay: a.orig.day, start: a.orig.start, end: a.orig.end, breaks: a.orig.breaks, noLunchOk: true, force: true }
    : a.action === "delete" ? { name: a.name, workerId: a.workerId, action: "create", day: a.orig.day, start: a.orig.start, end: a.orig.end, job: a.orig.job, breaks: a.orig.breaks, noLunchOk: true, force: true }
    : { name: a.name, workerId: a.workerId, action: "delete", day: a.next.day, from: a.next.start, job: a.next.job });
}

/** Which applied changes the server's copy does not show. */
export function readbackMisses(applied, rb) {
  const has = (id, x) => (rb[id] || []).some((s) => s.day === x.day && s.start === x.start && s.end === x.end);
  return applied.filter((a) => (a.next && !has(a.workerId, a.next)) ||
    (a.action !== "edit" && a.orig && has(a.workerId, a.orig) && !(a.next && a.next.day === a.orig.day && a.next.start === a.orig.start)));
}

/** One-line description of a change, for lists. */
export function describe(ch, dates) {
  const d = (x) => { const i = dayIdx(dates || [], x); return i >= 0 ? DOW[i] : x; };
  const t = (s, e) => `${fmt12(toMin(s))}–${fmt12(toMin(e))}`;
  const lunch = ch.lunch && ch.lunch !== "none" ? `, lunch ${fmt12(toMin(ch.lunch))}` : ch.lunch === "none" ? ", no lunch" : "";
  switch (ch.action) {
    case "edit": return `${d(ch.day)} ${ch.from ? fmt12(toMin(ch.from)) + " shift" : "shift"} → ${t(ch.start, ch.end)}${lunch}`;
    case "move": return `${d(ch.day)} ${ch.from ? fmt12(toMin(ch.from)) : ""} → ${d(ch.toDay)} ${t(ch.start, ch.end)}${lunch}`;
    case "delete": return `delete ${d(ch.day)} ${ch.from ? fmt12(toMin(ch.from)) + " " : ""}shift`;
    case "create": return `add ${d(ch.day)} ${t(ch.start, ch.end)}${lunch}`;
    default: return JSON.stringify(ch);
  }
}
