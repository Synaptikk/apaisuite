// modules/digitalschedule/lib/graph.js
//
// The before / after Hours Guidance graph from the WK 39 page
// (.claude/skills/wfm-schedule/reference/coverage-page.tpl.html), as string
// builders for the module: bars = scheduled per hour coloured blue / short /
// over, the guidance as a smoothed line (like the scheduler's), 12p–4p
// shaded. "after" = with the queued changes applied.

import { DOW, toMin, shiftSpan } from "./coverage.js";

const SHORT = ["sat", "sun", "mon", "tue", "wed", "thu", "fri"];
export const hm = (m) => { m = ((m % 1440) + 1440) % 1440; const h = Math.floor(m / 60), mm = m % 60; return `${h % 12 || 12}${mm ? ":" + String(mm).padStart(2, "0") : ""}${h < 12 ? "a" : "p"}`; };
const rng = (a) => (a ? `${hm(a[0])}–${hm(a[1])}` : "—");
const sum = (a) => a.reduce((x, y) => x + y, 0);
export const f2 = (v) => (Math.round(v * 100) / 100).toString();
const state = (v, n) => (Math.abs(v - n) < 0.01 ? "blue" : v < n ? "under" : "over");
export const dayLabel = (d, long) => new Date(d.date + "T12:00:00").toLocaleDateString("en-US", long ? { weekday: "long", month: "short", day: "numeric" } : { weekday: "short", day: "numeric" });
export function tally(d, k) { const t = { blue: 0, under: 0, over: 0 }; for (let h = 0; h < 24; h++) if (d.need[h] || d[k][h]) t[state(d[k][h], d.need[h])]++; return t; }
export const offBy = (d, k) => sum(d[k].map((v, h) => Math.abs(v - d.need[h])));
export const totals = (d, k) => ({ sched: sum(d[k]), need: sum(d.need) });

/** Who each queued change takes out of / puts into which day and time, for the hover. */
export function movesFromQueue(data, queue) {
  const idx = (x) => { const s = String(x ?? "").toLowerCase(); const i = data.dates.indexOf(s); return i >= 0 ? i : SHORT.indexOf(s.slice(0, 3)); };
  return queue.map((ch) => {
    const w = data.workers.find((x) => x.workerId === ch.workerId || x.name === ch.name);
    const di = idx(ch.day), ti = ch.action === "move" ? idx(ch.toDay) : di;
    const orig = ch.action === "create" ? null : w?.shifts.find((s) => s.day === data.dates[di] && toMin(s.start) === toMin(ch.from));
    const from = orig ? shiftSpan(orig) : null;
    let to = null;
    if (ch.action !== "delete") { const s = ch.start != null ? toMin(ch.start) : from?.[0]; let e = ch.end != null ? toMin(ch.end) : from?.[1]; if (s != null && e != null) { if (e <= s) e += 1440; to = [s, e]; } }
    return { names: [ch.name], fromDay: di, toDay: ti, from, to, action: ch.action };
  });
}

function curve(pts) {
  if (pts.length < 3) return "";
  let s = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) { const [x0, y0] = pts[i], [x1, y1] = pts[i + 1]; s += ` Q${x0},${y0} ${(x0 + x1) / 2},${(y0 + y1) / 2}`; }
  const l = pts.at(-1); return s + ` L${l[0]},${l[1]}`;
}

/** One chart as an SVG string. opt = { W, H, L, B, yMax, axis, hover } */
export function chartSvg(d, key, opt) {
  const { W, H, L, B, yMax, axis, hover } = opt, T = 6, R = 4;
  const x = (h) => L + (h / 24) * (W - L - R), y = (v) => T + (1 - v / yMax) * (H - T - B), bw = Math.max(2, (x(1) - x(0)) * (hover ? 0.62 : 0.5));
  const step = yMax <= 10 ? 2 : yMax <= 30 ? 5 : 10;
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${key === "before" ? "Current" : "With queued changes"} vs guidance, ${dayLabel(d, true)}">`;
  if (axis) for (let v = 0; v <= yMax; v += step) s += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--g-line)"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" font-size="10" fill="var(--g-ink3)">${v}</text>`;
  s += `<rect x="${x(12)}" y="${T}" width="${x(16) - x(12)}" height="${y(0) - T}" fill="var(--g-peak)"/>`;
  s += `<line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" stroke="var(--g-ink3)" stroke-width="1"/>`;
  for (const h of [0, 6, 12, 18, 23]) s += `<text x="${x(h + 0.5)}" y="${H - 4}" text-anchor="middle" font-size="${axis ? 11 : 9}" fill="var(--g-ink3)">${h === 23 ? "11p" : hm(h * 60)}</text>`;
  for (let h = 0; h < 24; h++) { const v = d[key][h]; if (!v) continue; const top = y(v);
    s += `<rect x="${x(h + 0.5) - bw / 2}" y="${top}" width="${bw}" height="${y(0) - top}" rx="${Math.min(2, bw / 2)}" fill="var(--g-${state(v, d.need[h])})"/>`; }
  const pts = []; for (let h = 0; h < 24; h++) pts.push([x(h + 0.5), y(d.need[h])]);
  s += `<path d="${curve(pts)}" fill="none" stroke="var(--g-guide)" stroke-width="2"/>`;
  if (hover) {
    s += `<line class="ds-cx" x1="0" x2="0" y1="${T}" y2="${y(0)}" stroke="var(--g-ink3)" stroke-dasharray="3 3" visibility="hidden"/>`;
    for (let h = 0; h < 24; h++) s += `<rect data-h="${h}" data-x="${x(h + 0.5)}" x="${x(h)}" y="${T}" width="${x(h + 1) - x(h)}" height="${y(0) - T}" fill="transparent"/>`;
  }
  return s + "</svg>";
}

const inHour = (r, h) => (r ? Math.max(0, Math.min(r[1], h * 60 + 60) - Math.max(r[0], h * 60)) : 0);

/** Tooltip HTML for one hour of one day. `esc` escapes names. */
export function hourTip(days, di, h, esc) {
  const d = days[di], n = d.need[h], b = d.before[h], a = d.after[h];
  const word = (v) => { const g = v - n; return Math.abs(g) < 0.01 ? "on guidance" : (g > 0 ? "+" : "") + f2(g); };
  let t = `<div class="h">${dayLabel(d, true)} · ${hm(h * 60)}–${hm(h * 60 + 60)}</div>
    <div class="r"><span>Hours Guidance</span><b>${f2(n)}</b></div>
    <div class="r"><span>Scheduled now</span><span>${f2(b)} <span class="m">(${word(b)})</span></span></div>
    <div class="r"><span>With queue</span><b>${f2(a)} <span class="m">(${word(a)})</span></b></div>`;
  const ins = [], outs = [];
  for (const m of d.moves) {
    const was = m.fromDay === di ? inHour(m.from, h) : 0, now = m.toDay === di ? inHour(m.to, h) : 0;
    const what = m.fromDay === m.toDay ? `${rng(m.from)} → ${rng(m.to)}` : `${DOW[m.fromDay]} ${rng(m.from)} → ${DOW[m.toDay]} ${rng(m.to)}`;
    if (now > was) ins.push(`${esc(m.names.join(" + "))} <span class="m">${what}</span>`);
    else if (was > now) outs.push(`${esc(m.names.join(" + "))} <span class="m">${what}</span>`);
  }
  if (ins.length || outs.length) t += "<hr>" + ins.map((x) => `<div class="in">${x}</div>`).join("") + outs.map((x) => `<div class="out">${x}</div>`).join("");
  else if (Math.abs(a - b) > 0.01) t += `<hr><div class="m">Changed by a lunch that moved with its shift.</div>`;
  return t;
}
