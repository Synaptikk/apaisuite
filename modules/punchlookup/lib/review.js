// modules/punchlookup/lib/review.js
//
// Day Review — what an associate was doing, minute by minute, set against
// their punches. Built for wage & hour reviews: every documented minute is
// split by clock status (on the clock / punched meal / clocked out), so the
// totals answer "how much non-work time on the clock" and also the opposite
// risk, "was there work while clocked out or during a meal". Pure.
//
// Times are minutes from midnight of the review day. A time past midnight
// (night shift) is > 1440; the day's punches set the window that decides it.

/** Minutes → "7:42 AM" (with " +1" past midnight). */
export function fmtTime(min) {
  if (min == null || !Number.isFinite(min)) return "";
  const day = Math.floor(min / 1440), m = ((min % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60), mm = String(m % 60).padStart(2, "0");
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${mm} ${h < 12 ? "AM" : "PM"}${day > 0 ? " +1" : ""}`;
}

export function fmtDuration(min) {
  const n = Math.max(0, Math.round(min || 0));
  if (n < 60) return `${n} min`;
  return `${Math.floor(n / 60)}h ${String(n % 60).padStart(2, "0")}m`;
}

/** "07:42" / "20261008074200" punch fields → minutes from the review day. */
function punchMin(p, day) {
  const [h, m] = String(p.time || "0:0").split(":").map(Number);
  const offset = p.date && p.date !== day ? Math.round((Date.parse(p.date) - Date.parse(day)) / 86_400_000) : 0;
  return offset * 1440 + h * 60 + m;
}

/**
 * Punches → the day's window and its clock intervals:
 * { window: [from, to], intervals: [{ from, to, status: "on"|"meal"|"off" }] }
 * In / meal-end start "on", meal-start starts "meal", out starts "off".
 */
export function clockIntervals(punches, day) {
  const ps = (punches || []).map((p) => ({ ...p, at: punchMin(p, day) })).sort((a, b) => a.at - b.at);
  if (!ps.length) return { window: [0, 1440], intervals: [{ from: 0, to: 2880, status: "off" }] };
  const out = [];
  let state = "off", from = Math.min(0, ps[0].at);
  for (const p of ps) {
    const next = p.kind === "in" ? "on" : p.kind === "out" ? "off"
      : p.code === "MEAL" ? "meal" : p.code === "WRK" ? "on" : state;
    if (p.at > from) out.push({ from, to: p.at, status: state });
    state = next; from = p.at;
  }
  out.push({ from, to: Math.max(from, 2880), status: state });
  // The window runs first punch → last punch, the system's midnight
  // carry-overs included, so an overnight shift's minutes count on both days.
  return { window: [ps[0].at, ps.at(-1).at], intervals: out.filter((i) => i.to > i.from) };
}

/**
 * What the investigator typed → minutes, or null. Accepts "742", "7:42",
 * "7:42p", "7.42 pm", "19:42". With no am/pm, picks whichever of h / h+12
 * (and the next day) sits closest to the shift window, so "2:15" on an
 * afternoon shift means 2:15 PM without anyone typing it.
 */
export function parseTime(text, window = [0, 1440]) {
  const s = String(text || "").trim().toLowerCase().replace(/\s+/g, "");
  const m = /^(\d{1,2})(?:[:.]?(\d{2}))?(a|am|p|pm)?(\+1)?$/.exec(s);
  if (!m) return null;
  let h = Number(m[1]); const mm = Number(m[2] || 0);
  if (h > 23 || mm > 59) return null;
  const plus = m[4] ? 1440 : 0;
  if (m[3]) {
    if (h > 12 || h === 0) return null;
    h = (h % 12) + (m[3].startsWith("p") ? 12 : 0);
    return pickNearest([h * 60 + mm + plus], window, !!m[4]);
  }
  const base = h * 60 + mm;
  const options = h <= 12 && h > 0 ? [base, base + 720] : [base];
  return pickNearest(options.map((o) => o + plus), window, !!m[4]);
}

// ── One-line entry ───────────────────────────────────────────────────────────
// "7:15-7:40 on phone", "16:40-16:55 in breakroom @cam 12", "w 7:40-8:10 stocking water".
// Type markers (before or right after the times): w / work → Work,
// nw / non-work → Non-work, ? / u / unclear → Unclear. "@ …" at the end is the source.
const TIME_TOKEN = String.raw`\d{1,2}(?:[:.]?\d{2})?\s*(?:a|am|p|pm)?`;
const QUICK = new RegExp(String.raw`^(${TIME_TOKEN})\s*(?:-|–|—|to)\s*(${TIME_TOKEN})(?=\s|$|[,:;.])[\s,:;.]*(.*)$`, "i");
// The same range written after the note: "on phone 7:15-7:40".
const QUICK_TAIL = new RegExp(String.raw`^(.*?)[\s,:;-]+(${TIME_TOKEN})\s*(?:-|–|—|to)\s*(${TIME_TOKEN})\s*$`, "i");
const TYPE_MARK = /^(w|work|nw|non-?work|\?|u|unclear)(?:\s*[:\-–]\s*|\s+|$)/i;
const markType = (m) => (/^(w|work)$/i.test(m) ? "Work" : /^(nw|non-?work)$/i.test(m) ? "Non-work" : "Unclear");

/**
 * One typed line → { start, end, type, text, source } or null when it does
 * not start with a time range. `defaultType` applies when no marker is given.
 * An am/pm on the end time carries to the start ("7:15-7:40p" is both PM)
 * unless that would put the start after the end ("11:50-12:10p").
 */
export function parseQuickLine(line, window = [0, 1440], defaultType = "Non-work") {
  let s = String(line || "").trim().replace(/^[-•*\d]+[.)]\s+/, "");   // "1. " / "- " list bullets
  let type = null;
  const pre = TYPE_MARK.exec(s);
  if (pre && QUICK.test(s.slice(pre[0].length))) { type = markType(pre[1]); s = s.slice(pre[0].length); }
  let m = QUICK.exec(s);
  if (!m) {
    const t = QUICK_TAIL.exec(s);
    if (!t || !t[1].trim()) return null;
    m = [s, t[2], t[3], t[1]];
  }
  let [a, b] = [m[1].replace(/\s+/g, ""), m[2].replace(/\s+/g, "")];
  let rest = m[3].trim();
  const post = TYPE_MARK.exec(rest);
  if (!type && post) { type = markType(post[1]); rest = rest.slice(post[0].length).trim(); }
  const ampm = /(a|am|p|pm)$/i.exec(b)?.[1];
  if (ampm && !/(a|am|p|pm)$/i.test(a)) {
    const withSuffix = parseTime(a + ampm, window), endT = parseTime(b, window);
    if (withSuffix != null && endT != null && withSuffix <= endT) a += ampm;
  }
  let end = parseTime(b, window);
  let start = parseTime(a, window);
  if (start == null || end == null) return null;
  // Two independent nearest-to-shift guesses can disagree across noon/midnight;
  // the end must follow the start, so pull it into the next 12/24 hours.
  while (end <= start && end + 720 - start <= 1440) end += /(a|am|p|pm)$/i.test(b) ? 1440 : 720;
  let source = "";
  const at = rest.lastIndexOf(" @");
  if (at >= 0 || rest.startsWith("@")) { const i = at >= 0 ? at + 1 : 0; source = rest.slice(i + 1).trim(); rest = rest.slice(0, i).trim(); }
  return { start, end, type: type || defaultType, text: rest.replace(/[.;,]+$/, "").trim(), source };
}

function pickNearest(options, [from, to], fixedDay) {
  const all = fixedDay ? options : options.flatMap((o) => [o, o + 1440]);
  const dist = (t) => (t < from ? from - t : t > to ? t - to : 0);
  return all.sort((a, b) => dist(a) - dist(b) || a - b)[0];
}

export const TYPES = ["Work", "Non-work", "Unclear"];

/** Minutes of [a, b) falling in each clock status. */
function splitByClock(a, b, intervals) {
  const out = { on: 0, meal: 0, off: 0 };
  for (const i of intervals) {
    const lo = Math.max(a, i.from), hi = Math.min(b, i.to);
    if (hi > lo) out[i.status] += hi - lo;
  }
  out.off += Math.max(0, b - a - out.on - out.meal - out.off);   // past the last interval
  return out;
}

/**
 * Entries + punches → everything the editor, print and Excel show.
 * entries: [{ id, start, end, text, type, source }] (start/end in minutes)
 */
export function analyzeDay(entries, punches, day) {
  const { window, intervals } = clockIntervals(punches, day);
  const rows = (entries || [])
    .map((e) => ({ ...e }))
    .sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity) || (a.end ?? 0) - (b.end ?? 0));

  const inWindow = (status) => intervals.filter((i) => i.status === status)
    .reduce((s, i) => s + Math.max(0, Math.min(i.to, window[1]) - Math.max(i.from, window[0])), 0);
  const totals = {
    onClock: inWindow("on"), meal: inWindow("meal"),
    byType: Object.fromEntries(TYPES.map((t) => [t, { on: 0, meal: 0, off: 0, total: 0 }])),
    documentedOn: 0, undocumentedOn: 0,
  };
  const issues = [];
  let prevEnd = null;
  const onCovered = [];   // [a, b) pieces of on-clock time that some entry covers

  for (const r of rows) {
    r.problems = [];
    if (r.start == null || r.end == null) { r.problems.push("needs a start and an end"); r.minutes = 0; continue; }
    if (r.end <= r.start) { r.problems.push("ends before it starts"); r.minutes = 0; continue; }
    r.minutes = r.end - r.start;
    r.clock = splitByClock(r.start, r.end, intervals);
    // One status → its name; a row that crosses a punch → each part's minutes.
    const parts = ["on", "meal", "off"].filter((k) => r.clock[k]);
    const name = { on: "On clock", meal: "Meal punch", off: "Clocked out" };
    r.clockLabel = parts.length === 1 ? name[parts[0]] : parts.map((k) => `${name[k]} ${r.clock[k]}`).join(" / ");
    const t = totals.byType[TYPES.includes(r.type) ? r.type : "Unclear"];
    t.on += r.clock.on; t.meal += r.clock.meal; t.off += r.clock.off; t.total += r.minutes;
    if (prevEnd != null && r.start < prevEnd) r.problems.push(`overlaps the row before by ${prevEnd - r.start} min`);
    if (r.type === "Work" && r.clock.off) issues.push({ kind: "off-clock-work", at: r.start, minutes: r.clock.off, text: `${fmtDuration(r.clock.off)} of work while clocked out (${fmtTime(r.start)}–${fmtTime(r.end)})` });
    if (r.type === "Work" && r.clock.meal) issues.push({ kind: "meal-work", at: r.start, minutes: r.clock.meal, text: `${fmtDuration(r.clock.meal)} of work during the punched meal (${fmtTime(r.start)}–${fmtTime(r.end)})` });
    for (const i of intervals) if (i.status === "on") {
      const lo = Math.max(r.start, i.from), hi = Math.min(r.end, i.to);
      if (hi > lo) onCovered.push([lo, hi]);
    }
    prevEnd = Math.max(prevEnd ?? -Infinity, r.end);
  }

  // On-clock minutes nobody documented, as gaps the editor can point at.
  const merged = onCovered.sort((a, b) => a[0] - b[0]).reduce((acc, [a, b]) => {
    const last = acc.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b); else acc.push([a, b]);
    return acc;
  }, []);
  const gaps = [];
  for (const i of intervals.filter((x) => x.status === "on")) {
    const lo0 = Math.max(i.from, window[0]), hi0 = Math.min(i.to, window[1]);
    let cur = lo0;
    for (const [a, b] of merged) {
      if (b <= cur || a >= hi0) continue;
      if (a > cur) gaps.push({ from: cur, to: a });
      cur = Math.max(cur, b);
    }
    if (cur < hi0) gaps.push({ from: cur, to: hi0 });
  }
  totals.undocumentedOn = gaps.reduce((s, g) => s + g.to - g.from, 0);
  // Punched meals and out→in breaks inside the shift, shown as list rows.
  const breaks = intervals
    .filter((i) => i.status !== "on" && i.from >= window[0] && i.to <= window[1] && i.to > i.from)
    .map((i) => ({ from: i.from, to: i.to, status: i.status }));
  totals.documentedOn = Math.max(0, totals.onClock - totals.undocumentedOn);
  return { rows, gaps, breaks, issues: issues.sort((a, b) => a.at - b.at), totals, window, intervals };
}

/** The day's punches in one readable line: "In 7:00 AM · Meal 11:02 AM–12:01 PM · Out 3:30 PM". */
export function punchLine(punches, day) {
  const ps = (punches || []).filter((p) => !p.system).map((p) => ({ ...p, at: punchMin(p, day) })).sort((a, b) => a.at - b.at);
  const bits = [];
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    if (p.code === "MEAL") {
      const end = ps.slice(i + 1).find((q) => q.code === "WRK" || q.kind === "in");
      bits.push(`Meal ${fmtTime(p.at)}–${end ? fmtTime(end.at) : "?"}`);
      if (end) i = ps.indexOf(end);
    } else bits.push(`${p.kind === "in" ? "In" : p.kind === "out" ? "Out" : p.label} ${fmtTime(p.at)}`);
  }
  return bits.join(" · ") || "No punches";
}
