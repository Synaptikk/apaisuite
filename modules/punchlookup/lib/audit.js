// modules/punchlookup/lib/audit.js
//
// Store-wide punch-edit review. Pure: store-day punch lists in, per-associate
// patterns out. Runs in the shell page.
//
// How a punch's source is told apart (probed live 2026-10-08, store 1458,
// 968 punches on 2026-10-06). Every punch carries a `data` query string:
//   device   PN + Actiontime + the live-clock flags O=/W=/VA=. The kept time is
//            the minute the button was pressed (sometimes +1).
//   app-set  PN + Actiontime but NO live-clock flags, written in another key
//            order. The kept time is one the person chose; Actiontime is when
//            they submitted it (e.g. kept 11:00, submitted 11:13:47). This is
//            an associate putting in or correcting their own punch from the app.
//   edited   ClockTag=E. Changed after the fact; ActionTime is when the change
//            was made (often days later). The original time is not in the data.
//   entered  ActionTime with no device (PN) and no ClockTag — put in on the
//            timesheet by someone, stamped.
//   keyed    nothing but DKT/TZ/TCODE — keyed on the timesheet, no record of
//            who or when.
//   system   ClockTag=P — the midnight split; not a person's punch.
// Who approved an app-set punch is NOT in this data (the ETA report has it).
//
// User rules (2026-10-08): 9 minutes is the grace period — a clock-in up to 8
// minutes after the scheduled start accrues no occurrence. The pattern asked
// for: clock-ins actually made 9+ (especially 20+) minutes late whose kept
// time was set back to within grace. Kept times exactly on the hour, for a
// large share of someone's clock-ins, are unusual too.

export const GRACE = 8;           // kept ≤ start + 8 → no occurrence
export const BIG_LATE = 20;
export const ON_HOUR_FLAG = 0.5;  // ≥ 50% of clock-ins kept at :00
export const MIN_INS_FOR_RATE = 5;

/** Minutes since local midnight of `day` (YYYY-MM-DD) for a YYYYMMDDHHMM[SS] stamp. */
export function stampMin(stamp, day) {
  const s = String(stamp || "");
  if (!/^\d{12}/.test(s)) return null;
  const d = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  const days = Math.round((Date.parse(d) - Date.parse(day)) / 86_400_000);
  return days * 1440 + Number(s.slice(8, 10)) * 60 + Number(s.slice(10, 12)) + Number(s.slice(12, 14) || 0) / 60;
}

/** One raw clock → the compact punch the review keeps (no GPS). */
export function classifyClock(type, time, data) {
  const q = {};
  for (const kv of String(data || "").split("&")) {
    if (!kv) continue;
    const i = kv.indexOf("=");
    q[i < 0 ? kv : kv.slice(0, i)] = i < 0 ? "" : kv.slice(i + 1);
  }
  const at = q.Actiontime || q.ActionTime || null;
  let source;
  if (q.ClockTag === "P") source = "system";
  else if (q.ClockTag === "E") source = "edited";
  else if (q.PN && at) source = "O" in q || "W" in q || "VA" in q ? "device" : "app-set";
  else if (at) source = "entered";
  else source = "keyed";
  return { type: Number(type), time: String(time).slice(0, 12), source, at: at ? String(at).slice(0, 14) : null,
    code: q.TCODE ? q.TCODE.split("~")[0] : null, app: q.PN || null };
}

export const SOURCE_LABEL = {
  device: "Clocked live", "app-set": "Time set in app", edited: "Edited after the fact",
  entered: "Entered on timesheet", keyed: "Keyed (no device)", system: "Midnight split",
};

/** "LAST, FIRST M" or "FIRST LAST" → a key both spellings share. */
export function nameKey(name) {
  const s = String(name || "").toUpperCase().replace(/[^A-Z, ]/g, "").trim();
  let last, first;
  if (s.includes(",")) { [last, first] = s.split(",").map((x) => x.trim()); first = first.split(/\s+/)[0]; }
  else { const t = s.split(/\s+/); first = t[0]; last = t.slice(1).join(" "); }
  return `${(last || "").replace(/\s+/g, " ")}|${first || ""}`;
}

/** "7:00am" / "12:30pm" → minutes. */
export function parseShiftStart(s) {
  const m = /^(\d{1,2}):(\d{2})\s*([ap])m?$/i.exec(String(s || "").trim());
  if (!m) return null;
  return (Number(m[1]) % 12) * 60 + Number(m[2]) + (m[3].toLowerCase() === "p" ? 720 : 0);
}

const fmt = (min) => {
  if (min == null) return "";
  const m = Math.round(((min % 1440) + 1440) % 1440);
  const h = Math.floor(m / 60), mm = m % 60;
  return `${h % 12 || 12}:${String(mm).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};
export { fmt as fmtMin };

/**
 * days: [{ date, rows: [{ name, punches: [compact] }] }]
 * starts: { [date]: { [nameKey]: shiftStartMin } }   (may be empty)
 * → { people: [...], events: [...], store: {...} }
 */
export function analyzeStore(days, starts = {}) {
  const people = new Map();
  const events = [];
  const store = { ins: 0, insOnHour: 0, deviceIns: 0, deviceOnHour: 0, punches: 0, nonDevice: 0, days: days.length, withSchedule: 0 };

  const person = (name) => {
    if (!people.has(name)) people.set(name, {
      name, shifts: 0, scheduledShifts: 0, punches: 0, nonDevice: 0, bySource: {},
      ins: 0, insOnHour: 0, insOnHourNonDevice: 0, insChanged: 0,
      lateRescued: 0, lateRescuedBig: 0, rescuedMinutes: 0, insEditedInGrace: 0,
      lateKept: 0, events: [],
    });
    return people.get(name);
  };

  for (const day of days) {
    const sched = starts[day.date] || {};
    for (const row of day.rows || []) {
      const p = person(row.name);
      const ps = (row.punches || []).filter((x) => x.source !== "system")
        .map((x) => ({ ...x, kept: stampMin(x.time, day.date), pressed: x.source === "device" || x.source === "app-set" ? stampMin(x.at, day.date) : null }))
        .filter((x) => x.kept != null && x.kept >= 0 && x.kept < 1440)
        .sort((a, b) => a.kept - b.kept);
      if (!ps.length) continue;
      p.shifts++;
      for (const x of ps) {
        p.punches++; store.punches++;
        p.bySource[x.source] = (p.bySource[x.source] || 0) + 1;
        if (x.source !== "device") { p.nonDevice++; store.nonDevice++; }
      }

      const first = ps.find((x) => x.type === 1);
      const start = sched[nameKey(row.name)] ?? null;
      if (start != null) { p.scheduledShifts++; store.withSchedule++; }
      // User rule (2026-10-08): only lates matter. A clock-in made at or before
      // the scheduled start (4:55 for a 5:00 shift), or at or before the time it
      // was kept as (pressed 4:55, kept 5:00), is never counted anywhere. With no
      // press time (edited/keyed) only a kept time before the start is early.
      const early = !!first && (first.pressed != null
        ? first.pressed <= first.kept || (start != null && first.pressed <= start)
        : start != null && first.kept < start);

      // Every non-device punch is an event; the first clock-in carries the
      // schedule comparison.
      for (const x of ps) {
        if (x.source === "device") continue;
        const isFirstIn = x === first;
        if (isFirstIn && early) continue;
        const ev = {
          name: row.name, date: day.date, type: x.type, code: x.code, source: x.source,
          kept: x.kept, pressed: x.pressed, at: x.at, start: isFirstIn ? start : null,
          shift: x.pressed != null ? Math.round(x.pressed - x.kept) : null,
        };
        if (isFirstIn && start != null) {
          ev.keptLate = Math.round(x.kept - start);
          ev.pressedLate = x.pressed != null ? Math.floor(x.pressed - start) : null;
        }
        events.push(ev); p.events.push(ev);
      }

      if (!first) continue;
      p.ins++; store.ins++;
      if (early) continue;
      const onHour = Math.round(first.kept) % 60 === 0;
      if (onHour) { p.insOnHour++; store.insOnHour++; }
      if (first.source === "device") { store.deviceIns++; if (onHour) store.deviceOnHour++; }
      else {
        p.insChanged++;
        if (onHour) p.insOnHourNonDevice++;
      }
      if (start == null) continue;
      const keptLate = first.kept - start;
      if (keptLate > GRACE) p.lateKept++;
      if (first.source === "device" || keptLate > GRACE) continue;
      // Kept inside grace, but not clocked live.
      if (first.pressed != null) {
        const pressedLate = first.pressed - start;
        if (pressedLate >= GRACE + 1) {
          p.lateRescued++;
          p.rescuedMinutes += Math.round(first.pressed - first.kept);
          if (pressedLate >= BIG_LATE) p.lateRescuedBig++;
        }
      } else p.insEditedInGrace++;   // edited/keyed: the real time is not recorded
    }
  }

  const list = [...people.values()].map((p) => ({
    ...p,
    onHourRate: p.ins ? p.insOnHour / p.ins : 0,
    changedRate: p.ins ? p.insChanged / p.ins : 0,
    flags: [
      p.lateRescued >= 2 ? `${p.lateRescued} late clock-ins set back inside grace` : null,
      p.ins >= MIN_INS_FOR_RATE && p.insOnHour / p.ins >= ON_HOUR_FLAG ? `${Math.round((p.insOnHour / p.ins) * 100)}% of clock-ins exactly on the hour` : null,
      p.ins >= MIN_INS_FOR_RATE && p.insChanged / p.ins >= 0.5 ? `${p.insChanged} of ${p.ins} clock-ins not clocked live` : null,
    ].filter(Boolean),
  }));
  list.sort((a, b) => b.lateRescued - a.lateRescued || b.flags.length - a.flags.length || b.insChanged - a.insChanged || a.name.localeCompare(b.name));
  return { people: list, events: events.sort((a, b) => a.date.localeCompare(b.date) || a.kept - b.kept), store };
}

/** Per-associate CSV. */
export function auditCsv(result) {
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const head = ["Associate", "Shifts", "Shifts with schedule", "Clock-ins", "Late, set back inside grace", "…of which 20+ min late",
    "Minutes set back", "Clock-ins not clocked live", "Edited/keyed clock-ins inside grace (real time unknown)",
    "Clock-ins on the hour", "% on the hour", "Non-device punches", "Flags"];
  const rows = result.people.map((p) => [p.name, p.shifts, p.scheduledShifts, p.ins, p.lateRescued, p.lateRescuedBig, p.rescuedMinutes,
    p.insChanged, p.insEditedInGrace, p.insOnHour, Math.round(p.onHourRate * 100), p.nonDevice, p.flags.join("; ")]);
  const ev = [["Date", "Associate", "Punch", "Source", "Scheduled start", "Kept", "Pressed/submitted", "Minutes moved", "Late by (pressed)", "Late by (kept)"],
    ...result.events.map((e) => [e.date, e.name, punchName(e), SOURCE_LABEL[e.source] || e.source, fmt(e.start), fmt(e.kept),
      e.pressed != null ? fmt(e.pressed) : e.at ? `changed ${e.at.slice(4, 6)}/${e.at.slice(6, 8)} ${fmt(stampMin(e.at, e.at.slice(0, 4) + "-" + e.at.slice(4, 6) + "-" + e.at.slice(6, 8)))}` : "",
      e.shift ?? "", e.pressedLate ?? "", e.keptLate ?? ""])];
  return [head, ...rows].map((r) => r.map(q).join(",")).join("\r\n") + "\r\n\r\n" + ev.map((r) => r.map(q).join(",")).join("\r\n");
}

export function punchName(e) {
  if (e.type === 1) return "In";
  if (e.type === 2) return "Out";
  return e.code === "MEAL" ? "Meal start" : e.code === "WRK" ? "Meal end" : "Switch";
}
