// modules/digitalschedule/lib/areas.js
//
// Open-to-close areas: departments with their own register (Electronics,
// Sporting Goods, Jewelry) must have somebody on the floor every minute the
// store is open. An area is { id, name, open "HH:MM", close "HH:MM", jobs[],
// people[] }: a shift counts toward it when its job code is in `jobs` or the
// associate is named in `people` (any job). Unpaid lunch is off
// the floor. Pure helpers over the read result (lib/page.js).

import { toMin, fmt, shiftSpan, unpaidWindows, applyChanges } from "./coverage.js";
import { nameKey } from "./rules.js";

export const SLOT = 15;
export const GAP_LABEL = { nobody: "nobody on", lunch: "lunch overlap", solo: "no lunch cover" };
const NS = 96;

// Defaults for a Supercenter. Store hours are not in the scheduler's data;
// Jewelry has no job code of its own; it defaults to the Fashion team jobs.
export const DEFAULT_AREAS = [
  { id: "electronics", name: "Electronics", open: "06:00", close: "23:00", jobs: ["1-640-7410", "1-640-7210"], people: [] },
  { id: "sporting", name: "Sporting Goods", open: "06:00", close: "23:00", jobs: ["1-640-7411", "1-640-7200"], people: [] },
  // Jewelry has no job code of its own: any Fashion associate can cover the counter.
  { id: "jewelry", name: "Jewelry", open: "06:00", close: "23:00", jobs: ["1-625-7400", "1-625-7420", "1-625-7200", "1-27-237", "1-27-238", "1-615-7401", "1-625-8410", "1-625-8210"], people: [] },
];

export const isSetUp = (a) => !a.off && (a.jobs?.length || 0) + (a.people?.length || 0) > 0;

/** Does this shift (of this worker) count toward the area? */
export function inArea(area, workerName, job) {
  if ((area.jobs || []).includes(job)) return true;
  const k = nameKey(workerName);
  return (area.people || []).some((p) => nameKey(p) === k);
}

/** 15-minute slot counts for one area: on[di][i] (on the floor) and sched[di][i] (incl. lunch). */
export function areaSlots(data, area) {
  const on = data.dates.map(() => new Int16Array(NS)), sched = data.dates.map(() => new Int16Array(NS));
  for (const w of data.workers) for (const s of w.shifts) {
    if (!inArea(area, w.name, s.job)) continue;
    const di = data.dates.indexOf(s.day); if (di < 0) continue;
    const [a, b] = shiftSpan(s), off = unpaidWindows(s);
    for (let m = a; m < b; m += SLOT) {
      const dd = di + Math.floor(m / 1440), i = Math.floor((m % 1440) / SLOT);
      if (!on[dd]) continue;
      sched[dd][i]++;
      if (!off.some(([p, q]) => m >= p && m < q)) on[dd][i]++;
    }
  }
  return { on, sched };
}

const openSlots = (area) => {
  const a = Math.floor(toMin(area.open) / SLOT); let b = Math.ceil(toMin(area.close) / SLOT);
  if (!(b > a)) b = NS;   // "00:00" close = midnight
  return [Math.max(0, a), Math.min(NS, b)];
};

/**
 * Gaps per day between open and close.
 * → [{ date, gaps:[{ from, to, kind:"nobody"|"lunch"|"solo" }], gapMin, thin:[{from,to}] }]
 * "lunch" = two or more scheduled, all on unpaid lunch at once (staggering fixes it);
 * "solo"  = the only person scheduled is on lunch (somebody has to overlap them);
 * "thin" = exactly one person on the floor (informational).
 */
export function areaGaps(data, area) {
  const { on, sched } = areaSlots(data, area), [lo, hi] = openSlots(area);
  return data.dates.map((date, di) => {
    const gaps = [], thin = [];
    for (let i = lo; i < hi; i++) {
      const kind = on[di][i] > 0 ? (on[di][i] === 1 ? "thin" : null) : sched[di][i] > 1 ? "lunch" : sched[di][i] === 1 ? "solo" : "nobody";
      if (!kind) continue;
      const list = kind === "thin" ? thin : gaps, last = list.at(-1);
      if (last && last.to === fmt((i) * SLOT) && (kind === "thin" || last.kind === kind)) last.to = fmt((i + 1) * SLOT);
      else list.push(kind === "thin" ? { from: fmt(i * SLOT), to: fmt((i + 1) * SLOT) } : { from: fmt(i * SLOT), to: fmt((i + 1) * SLOT), kind });
    }
    const gapMin = gaps.reduce((t, g) => t + ((toMin(g.to) || 1440) - toMin(g.from)), 0);
    return { date, gaps, gapMin, thin };
  });
}

/** Gap minutes the queue adds (or removes) per area: [{ area, days:[{date, before, after, added:[gaps]}] }]. */
export function areaDelta(before, after, areas) {
  return areas.filter(isSetUp).map((area) => {
    const a = areaGaps(before, area), b = areaGaps(after, area);
    return { area, days: b.map((d, i) => ({ date: d.date, before: a[i].gapMin, after: d.gapMin,
      added: d.gaps.filter((g) => !a[i].gaps.some((x) => x.from <= g.from && x.to >= g.to && x.kind === g.kind)) })) };
  });
}

/** Clean up an edited area list (from storage or the editor). */
export function normalizeAreas(list) {
  const t = (v, d) => (/^\d{1,2}:\d\d$/.test(String(v || "").trim()) ? fmt(toMin(v)) : d);
  const split = (v) => (Array.isArray(v) ? v : String(v || "").split(/[,\n]/)).map((s) => String(s).trim()).filter(Boolean);
  return (Array.isArray(list) ? list : []).map((a, i) => ({ id: a.id || `area${Date.now()}${i}`, name: String(a.name || "").trim() || "Area",
    open: t(a.open, "06:00"), close: t(a.close, "23:00"), jobs: split(a.jobs), people: split(a.people), off: !!a.off }));
}

/**
 * Stagger overlapping lunches so no area is left empty while its people eat.
 * Only lunches move (same shift, same day): the new start stays 3–4 h into the
 * shift (validator 10017/10054), whole hours preferred, today and earlier never
 * touched, shifts already in the queue left alone. Greedy: take the change that
 * removes the most gap minutes without opening a gap in any area, repeat.
 * → { changes[] (lib/page.js edit format), fixedMin, leftMin }
 */
export function staggerLunches(data, areas, { editableFrom = null } = {}) {
  const live = areas.filter(isSetUp);
  const total = (d) => live.reduce((t, a) => t + areaGaps(d, a).reduce((u, x) => u + x.gapMin, 0), 0);
  const perDay = (d) => live.map((a) => areaGaps(d, a).map((x) => x.gapMin));
  const changes = [], startMin = total(data);
  let cur = data;
  for (let round = 0; round < 50; round++) {
    const gapsNow = perDay(cur), base = gapsNow.flat().reduce((a, b) => a + b, 0);
    if (!base) break;
    let best = null;
    for (const w of cur.workers) for (const s of w.shifts) {
      if (s.changed || (editableFrom && s.day < editableFrom)) continue;
      const di = cur.dates.indexOf(s.day); if (di < 0) continue;
      if (!live.some((a, ai) => gapsNow[ai][di] > 0 && inArea(a, w.name, s.job))) continue;
      const lunch = (s.breaks || []).filter((b) => !b.paid); if (lunch.length !== 1) continue;
      const st = toMin(s.start), cur0 = toMin(lunch[0].start);
      for (let off = 180; off <= 240; off += 15) {
        const t = st + off; if (t === cur0 || ((t - cur0 + 1440) % 1440) === 0) continue;
        const ch = { name: w.name, workerId: w.workerId, action: "edit", day: s.day, from: s.start, expectEnd: s.end, job: s.job, start: s.start, end: s.end, lunch: fmt(t) };
        const next = applyChanges(cur, [ch]).data, g = perDay(next);
        if (g.some((row, ai) => row.some((m, d) => m > gapsNow[ai][d]))) continue;   // never open or widen a gap
        const gain = base - g.flat().reduce((a, b) => a + b, 0); if (gain <= 0) continue;
        const score = gain * 10 - (t % 60 ? 3 : 0) - Math.abs(t - cur0) / 60;
        if (!best || score > best.score) best = { score, ch, next };
      }
    }
    if (!best) break;
    changes.push(best.ch);
    cur = best.next;
    // later rounds must not edit the same shift again
    for (const w of cur.workers) for (const s of w.shifts) if (w.workerId === best.ch.workerId && s.day === best.ch.day) s.changed = true;
  }
  const leftMin = total(cur);
  return { changes, fixedMin: startMin - leftMin, leftMin };
}
