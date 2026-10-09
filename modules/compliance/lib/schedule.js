// modules/compliance/lib/schedule.js
//
// Pure calendar logic. Enviance only creates a task a few days before it is
// due (the weekly eyewash appears Monday, due Thursday; monthly tasks appear
// at the start of their month), so future months are projected from each
// type's own due pattern and marked as such.
//
// The store's rule: monthly work is finished by the 10th even when Enviance
// lets it run to the end of the month. target = the 10th of the due month,
// or the due date itself when that comes first (SPCC is due on the 10th).

export const TARGET_DAY = 10;

const DAY = 86_400_000;
const parse = (s) => (s ? new Date(String(s).replace(/Z$/, "")) : null);   // Enviance local time, no zone
const pad = (n) => String(n).padStart(2, "0");
export const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const lastDayOf = (y, m) => new Date(y, m + 1, 0).getDate();
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes());

// weekly | monthly | other, from the gaps between due dates.
export function cadenceOf(dues) {
  const ds = dues.map(parse).filter(Boolean).sort((a, b) => a - b);
  if (ds.length < 2) return "other";
  const gaps = ds.slice(1).map((d, i) => (d - ds[i]) / DAY).sort((a, b) => a - b);
  const med = gaps[Math.floor(gaps.length / 2)];
  if (med >= 5 && med <= 9) return "weekly";
  if (med >= 26 && med <= 35) return "monthly";
  return "other";
}

// How a monthly task's due day is set: a fixed day (SPCC on the 10th, fire
// extinguishers on the 30th) or the month's last day (safety assessment).
export function monthlyDueRule(dues) {
  const ds = dues.map(parse).filter(Boolean).sort((a, b) => b - a).slice(0, 4);
  if (!ds.length) return null;
  const time = { h: ds[0].getHours(), m: ds[0].getMinutes() };
  if (ds.every((d) => d.getDate() === lastDayOf(d.getFullYear(), d.getMonth())) && ds.some((d) => d.getDate() === 31)) return { last: true, ...time };
  const days = ds.map((d) => d.getDate());
  const day = days.sort((a, b) => b - a)[0];
  return { day, ...time };
}

export function targetFor(due, cadence) {
  const d = parse(due);
  if (!d) return null;
  if (cadence !== "monthly") return d;
  const t = new Date(d.getFullYear(), d.getMonth(), TARGET_DAY, 23, 59);
  return d < t ? d : t;
}

// tasks: [{ id, uid, type, name, due, closed, isopen, … }] for one facility.
// Returns tasks with cadence/target/status, plus projected ones through `until`.
export function buildCalendar(tasks, { now = new Date(), until } = {}) {
  const byType = new Map();
  for (const t of tasks) {
    if (!byType.has(t.type)) byType.set(t.type, []);
    byType.get(t.type).push(t);
  }
  const out = [];
  const end = until || new Date(now.getFullYear(), now.getMonth() + 2, 0, 23, 59);
  for (const [type, list] of byType) {
    const cadence = cadenceOf(list.map((t) => t.due));
    for (const t of list) out.push(decorate(t, cadence, now));
    // Project forward from the latest real instance.
    const latest = list.map((t) => parse(t.due)).filter(Boolean).sort((a, b) => b - a)[0];
    if (!latest || latest < new Date(now.getTime() - 60 * DAY)) continue;   // type retired (OSHA 300 stopped in Feb)
    const sample = list.find((t) => +parse(t.due) === +latest);
    const next = [];
    if (cadence === "weekly") {
      // Calendar days, not 7×24 h: a DST change would shift the hour.
      for (let d = addDays(latest, 7); d <= end; d = addDays(d, 7)) next.push(d);
    } else if (cadence === "monthly") {
      const rule = monthlyDueRule(list.map((t) => t.due));
      for (let i = 1; i < 14; i++) {
        const y = latest.getFullYear(), m = latest.getMonth() + i;
        const ld = lastDayOf(new Date(y, m, 1).getFullYear(), new Date(y, m, 1).getMonth());
        const d = new Date(y, m, rule.last ? ld : Math.min(rule.day, ld), rule.h, rule.m);
        if (d > end) break;
        next.push(d);
      }
    }
    for (const d of next) {
      out.push(decorate({ id: `proj:${type}:${dayKey(d)}`, type, name: sample.name, due: localIso(d), projected: true, isopen: true }, cadence, now));
    }
  }
  return out.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : a.name.localeCompare(b.name)));
}

const localIso = (d) => `${dayKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;

function decorate(t, cadence, now) {
  const due = parse(t.due), closed = parse(t.closed);
  const target = targetFor(t.due, cadence);
  let status;
  if (t.projected) status = "upcoming";
  else if (!t.isopen) status = closed && due && closed > due ? "late" : "done";
  else if (due && due < now) status = "overdue";
  else if (target && target < now) status = "pastTarget";
  else status = "open";
  return {
    ...t,
    cadence,
    target: target ? localIso(target) : null,
    status,
    metTarget: !t.isopen && closed && target ? closed <= new Date(target.getFullYear(), target.getMonth(), target.getDate(), 23, 59, 59) : null,
    daysLeft: due ? Math.ceil((new Date(due.getFullYear(), due.getMonth(), due.getDate()) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / DAY) : null,
  };
}

// Month grid: weeks (Sun..Sat) of { date, inMonth, items: [{task, kind: due|target}] }.
export function monthGrid(year, month, tasks) {
  const first = new Date(year, month, 1);
  const start = new Date(year, month, 1 - first.getDay());
  const byDay = new Map();
  const put = (k, item) => { if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(item); };
  for (const t of tasks) {
    const due = parse(t.due);
    if (due) put(dayKey(due), { task: t, kind: "due" });
    const tg = parse(t.target);
    if (tg && due && dayKey(tg) !== dayKey(due) && t.status !== "done" && t.status !== "late") put(dayKey(tg), { task: t, kind: "target" });
  }
  const weeks = [];
  for (let w = 0; w < 6; w++) {
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + i);
      days.push({ date: dayKey(d), day: d.getDate(), inMonth: d.getMonth() === month, items: byDay.get(dayKey(d)) || [] });
    }
    if (w >= 4 && !days.some((x) => x.inMonth)) break;
    weeks.push(days);
  }
  return weeks;
}
