// modules/punchlookup/lib/review_export.js
//
// Day Review outputs for a case: a print-ready HTML day sheet (inline styles,
// standalone window), an Excel record (Days, Entries with who added each
// line, W&H Report) and the wage & hour narrative. Pure.
//
// review: { empId, person: { gtaName, win }, date, punches, entries,
//           caseNo, reviewer, summary, updatedAt }

import { analyzeDay, fmtTime, fmtDuration, punchLine, TYPES } from "./review.js";
import { dayLabel } from "./report.js";
import { buildXlsx } from "./xlsx_write.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const TYPE_COLOR = { Work: "#16a34a", "Non-work": "#dc2626", Unclear: "#64748b" };

/** Rows, the undocumented gaps and the punched meals/breaks, in time order. */
export function timeline(a) {
  const items = [...a.rows.map((r) => ({ kind: "row", at: r.start ?? Infinity, r })),
    ...a.gaps.map((g) => ({ kind: "gap", at: g.from, g })),
    ...(a.breaks || []).map((g) => ({ kind: "break", at: g.from, g }))];
  const rank = { break: 0, row: 1, gap: 2 };
  return items.sort((x, y) => x.at - y.at || rank[x.kind] - rank[y.kind]);
}

/** "Lunch — meal punch" / "Lunch — clocked out" label for a break row. */
export function breakLabel(g) {
  const m = g.to - g.from;
  const what = m >= 30 ? "Lunch" : "Break";
  return `${what} — ${g.status === "meal" ? "meal punch" : "clocked out"} (not paid)`;
}

// User rule (2026-10-08): on-clock time with no note is assumed to be work.
// workOn = documented work + undocumented; the two parts stay visible.
export const ASSUMPTION = "Time on the clock with no documented activity is counted as performing work duties.";
export function totalsOf(a) {
  const t = a.totals;
  return {
    onClock: t.onClock, meal: t.meal,
    workOn: t.byType.Work.on + t.undocumentedOn, workDocumented: t.byType.Work.on,
    nonworkOn: t.byType["Non-work"].on, unclearOn: t.byType.Unclear.on,
    undocumented: t.undocumentedOn,
    offClockWork: t.byType.Work.off, mealWork: t.byType.Work.meal,
  };
}

export function reviewPrintHtml(review) {
  const a = analyzeDay(review.entries, review.punches, review.date);
  const t = totalsOf(a);
  const p = review.person || {};
  const box = (label, val, color = "#111", note = "") => `<td style="border:1px solid #d1d5db;padding:6px 10px;vertical-align:top">
    <div style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.03em">${label}</div>
    <div style="font-size:15px;font-weight:600;color:${color}">${fmtDuration(val)}</div>${note ? `<div style="font-size:10px;color:#888">${note}</div>` : ""}</td>`;
  const pct = (n) => (t.onClock ? `${Math.round((n / t.onClock) * 100)}% of on-clock` : "");

  let n = 0;
  const lines = timeline(a).map((it) => {
    if (it.kind === "break") {
      const c = "padding:3px 6px;color:#1e3a8a;background:#eff6ff;font-weight:600";
      return `<tr><td style="${c}"></td><td style="${c}">${fmtTime(it.g.from)}</td><td style="${c}">${fmtTime(it.g.to)}</td>
        <td style="${c};text-align:right">${it.g.to - it.g.from}</td><td colspan="4" style="${c}">${esc(breakLabel(it.g))}</td></tr>`;
    }
    if (it.kind === "gap") {
      return `<tr><td></td><td style="padding:3px 6px;color:#92400e;font-style:italic">${fmtTime(it.g.from)}</td><td style="padding:3px 6px;color:#92400e;font-style:italic">${fmtTime(it.g.to)}</td>
        <td style="padding:3px 6px;text-align:right;color:#92400e;font-style:italic">${it.g.to - it.g.from}</td><td colspan="4" style="padding:3px 6px;color:#92400e;font-style:italic;background:#fffbeb">No notes — counted as work</td></tr>`;
    }
    const r = it.r; n++;
    const color = TYPE_COLOR[r.type] || TYPE_COLOR.Unclear;
    const warn = r.problems.length ? `<div style="color:#b91c1c;font-size:10px">⚠ ${esc(r.problems.join("; "))}</div>` : "";
    const clockWarn = r.type === "Work" && (r.clock?.off || r.clock?.meal) ? "color:#b91c1c;font-weight:600" : "";
    return `<tr style="border-bottom:1px solid #e5e7eb">
      <td style="padding:4px 6px;color:#888;vertical-align:top">${n}</td>
      <td style="padding:4px 6px;white-space:nowrap;vertical-align:top">${fmtTime(r.start)}</td>
      <td style="padding:4px 6px;white-space:nowrap;vertical-align:top">${fmtTime(r.end)}</td>
      <td style="padding:4px 6px;text-align:right;vertical-align:top">${r.minutes || ""}</td>
      <td style="padding:4px 6px;vertical-align:top;white-space:nowrap"><span style="border-left:4px solid ${color};padding-left:5px;color:${color};font-weight:600">${esc(r.type || "Unclear")}</span></td>
      <td style="padding:4px 6px;vertical-align:top;white-space:nowrap;${clockWarn}">${esc(r.clockLabel || "")}</td>
      <td style="padding:4px 6px;vertical-align:top;white-space:pre-wrap">${esc(r.text)}${warn}</td>
      <td style="padding:4px 6px;vertical-align:top;color:#555">${esc(r.source || "")}</td></tr>`;
  }).join("");

  const th = "text-align:left;padding:5px 6px;background:#1f3a5f;color:#fff;font-size:11px;font-weight:600";
  return `<div style="font-family:Segoe UI,Arial,sans-serif;color:#111;font-size:12px">
  <div style="display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid #1f3a5f;padding-bottom:6px;margin-bottom:10px">
    <div><div style="font-size:18px;font-weight:700">Associate Day Review</div><div style="color:#555">Time &amp; activity documentation against Global Time &amp; Attendance punches</div></div>
    <div style="text-align:right;color:#555;font-size:11px">${review.caseNo ? `Case # <b style="color:#111">${esc(review.caseNo)}</b><br>` : ""}Updated ${esc(new Date(review.updatedAt || Date.now()).toLocaleString())}</div>
  </div>
  <table style="border-collapse:collapse;margin-bottom:10px;font-size:12px">
    <tr><td style="padding:2px 14px 2px 0;color:#666">Associate</td><td style="padding:2px 24px 2px 0"><b>${esc(p.gtaName || "")}</b>${p.win ? ` · WIN ${esc(p.win)}` : ""}</td>
        <td style="padding:2px 14px 2px 0;color:#666">Date</td><td><b>${esc(dayLabel(review.date))}</b></td></tr>
    <tr><td style="padding:2px 14px 2px 0;color:#666">Punches</td><td colspan="3">${esc(punchLine(review.punches, review.date))}</td></tr>
    ${review.reviewer ? `<tr><td style="padding:2px 14px 2px 0;color:#666">Reviewed by</td><td colspan="3">${esc(review.reviewer)}</td></tr>` : ""}
  </table>
  <table style="border-collapse:collapse;margin-bottom:10px"><tr>
    ${box("On the clock", t.onClock)}
    ${box("Work · on clock", t.workOn, "#16a34a", `${pct(t.workOn)}${t.undocumented ? `<br>incl. ${fmtDuration(t.undocumented)} with no notes` : ""}`)}
    ${box("Non-work · on clock", t.nonworkOn, "#dc2626", pct(t.nonworkOn))}
    ${box("Unclear · on clock", t.unclearOn, "#64748b", pct(t.unclearOn))}
    ${t.offClockWork ? box("Work while clocked out", t.offClockWork, "#b91c1c") : ""}
    ${t.mealWork ? box("Work during meal", t.mealWork, "#b91c1c") : ""}
  </tr></table>
  ${a.issues.length ? `<div style="border:1px solid #fecaca;background:#fef2f2;padding:6px 10px;margin-bottom:10px;font-size:11px"><b style="color:#b91c1c">Flags</b><br>${a.issues.map((i) => esc(i.text)).join("<br>")}</div>` : ""}
  <table style="border-collapse:collapse;width:100%;font-size:11.5px;table-layout:fixed">
    <thead><tr><th style="${th};width:3%">#</th><th style="${th};width:8%">Start</th><th style="${th};width:8%">End</th><th style="${th};width:5%;text-align:right">Min</th><th style="${th};width:9%">Type</th><th style="${th};width:13%">Clock</th><th style="${th}">Activity observed</th><th style="${th};width:13%">Source</th></tr></thead>
    <tbody>${lines || `<tr><td colspan="8" style="padding:8px;color:#888">No activity documented yet.</td></tr>`}</tbody>
  </table>
  ${review.summary ? `<div style="margin-top:12px"><div style="font-size:11px;color:#666;text-transform:uppercase">Summary</div><div style="white-space:pre-wrap;border:1px solid #e5e7eb;padding:6px 10px">${esc(review.summary)}</div></div>` : ""}
  <table style="width:100%;margin-top:28px;font-size:11px;color:#555"><tr>
    <td style="width:45%;border-top:1px solid #999;padding-top:3px">Reviewed by (print / sign)</td><td style="width:10%"></td>
    <td style="width:20%;border-top:1px solid #999;padding-top:3px">Date</td><td></td></tr></table>
  <div style="font-size:10px;color:#888;margin-top:8px">Clock status comes from the GTA punches: "On clock" between in and out, "Meal punch" between meal start and meal end. ${ASSUMPTION}</div>
</div>`;
}

// ── Excel ────────────────────────────────────────────────────────────────────
// The case as a record to file or hand on (the case itself lives in OneDrive):
//   Days        — one row per day: punches, on-clock time, lines, who, totals
//   Entries     — every line, in time order, with the day and who added it
//   W&H Report  — the narrative
function daysSheet(sorted) {
  const p = sorted[0]?.person || {};
  const first = 7, last = first + sorted.length - 1;
  const rows = [
    [{ v: "Day Review", s: "title" }],
    [{ v: "Associate", s: "label" }, p.gtaName || "", { v: "WIN", s: "label" }, p.win || ""],
    [{ v: "Case #", s: "label" }, [...new Set(sorted.map((r) => r.caseNo).filter(Boolean))].join(", ")],
    [{ v: "Investigators", s: "label" }, [...new Set(sorted.flatMap((r) => String(r.reviewer || "").split(", ")).filter(Boolean))].join(", ")],
    [],
    ["Date", "Punches", "On the clock (min)", "Non-work (min)", "Work (min)*", "Unclear (min)", "Lines", "By"].map((v) => ({ v, s: "head" })),
  ];
  for (const r of sorted) {
    const t = totalsOf(analyzeDay(r.entries, r.punches, r.date));
    rows.push([
      { v: dayLabel(r.date), s: "label" }, { v: punchLine(r.punches, r.date), s: "wrap" },
      ...[t.onClock, t.nonworkOn, t.workOn, t.unclearOn, r.entries.length].map((v) => ({ v, s: "int" })),
      { v: r.reviewer || "", s: "wrap" },
    ]);
  }
  rows.push([{ v: "Total", s: "total" }, { v: "", s: "total" }, ..."CDEFG".split("").map((c) => ({ f: `SUM(${c}${first}:${c}${last})`, v: 0, s: "totalInt" })), { v: "", s: "total" }]);
  rows.push([], [{ v: `* ${ASSUMPTION}`, s: "sub" }]);
  return { name: "Days", rows, freezeRow: 6, widths: [16, 58, 12, 12, 12, 12, 8, 30], merges: ["A1:H1"] };
}

function entriesSheet(sorted) {
  const rows = [
    [{ v: "Entries", s: "title" }],
    [],
    ["Date", "Start", "End", "Minutes", "Type", "Clock", "Activity observed", "Source / camera", "By"].map((v) => ({ v, s: "head" })),
  ];
  const frac = (min) => (((min % 1440) + 1440) % 1440) / 1440;
  for (const r of sorted) {
    for (const x of analyzeDay(r.entries, r.punches, r.date).rows) {
      const ok = x.start != null && x.end != null;
      rows.push([
        { v: dayLabel(r.date), s: "label" },
        ok ? { v: frac(x.start), t: "time" } : "", ok ? { v: frac(x.end), t: "time" } : "",
        { v: x.minutes || 0, s: "int" },
        { v: x.type || "Unclear", s: x.type === "Work" ? "work" : x.type === "Non-work" ? "nonwork" : "unclear" },
        { v: x.clockLabel || "", s: x.type === "Work" && (x.clock?.off || x.clock?.meal) ? "warn" : "wrap" },
        { v: x.text || "", s: "wrap" }, { v: x.source || "", s: "wrap" }, { v: x.byName || "", s: "wrap" },
      ]);
    }
  }
  if (rows.length === 3) rows.push([{ v: "No lines yet.", s: "sub" }]);
  return { name: "Entries", rows, freezeRow: 3, widths: [16, 11, 11, 9, 11, 16, 70, 18, 22], merges: ["A1:I1"] };
}

/** A case's days → workbook bytes. */
export function reviewsWorkbook(reviews) {
  const sorted = [...reviews].sort((a, b) => a.date.localeCompare(b.date));
  return buildXlsx([daysSheet(sorted), entriesSheet(sorted), whSheet(sorted)]);
}

// ── Wage & hour report ───────────────────────────────────────────────────────
// Per day: each non-work time frame as "7:00-7:42 AM was not performing work
// duties and was <what the log says>." then the day's totals. Only time on
// the clock counts toward "not performing work duties"; a non-work row wholly
// inside a punched meal or after clock-out is left out, and one that
// runs into a punched meal or past clock-out says how much of it did.

const hm = (min) => { const m = ((min % 1440) + 1440) % 1440, h = Math.floor(m / 60) % 12 || 12; return `${h}:${String(m % 60).padStart(2, "0")}`; };
const half = (min) => ((((min % 1440) + 1440) % 1440) < 720 ? "AM" : "PM");
export function rangeText(a, b) {
  return half(a) === half(b) && b - a < 720 ? `${hm(a)}-${hm(b)} ${half(b)}` : `${hm(a)} ${half(a)}-${hm(b)} ${half(b)}`;
}
export function words(min) {
  const n = Math.max(0, Math.round(min || 0)), h = Math.floor(n / 60), m = n % 60;
  return h ? `${h} hr${h > 1 ? "s" : ""}${m ? ` ${m} min` : ""}` : `${m} min`;
}
function activityPhrase(text) {
  let s = String(text || "").trim().replace(/\s+/g, " ").replace(/[.;]+$/, "").replace(/^(was|were)\s+/i, "");
  if (!s) return "__________";
  if (/^[A-Z][a-z]/.test(s)) s = s[0].toLowerCase() + s.slice(1);
  return s;
}
const longDate = (iso) => { const [y, m, d] = iso.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }); };

export function whReport(reviews) {
  const days = [...reviews].sort((a, b) => a.date.localeCompare(b.date)).map((r) => {
    const a = analyzeDay(r.entries, r.punches, r.date);
    const t = totalsOf(a);
    const lines = a.rows.filter((x) => x.type === "Non-work" && x.clock?.on > 0).map((x) => {
      const outside = (x.clock?.meal || 0) + (x.clock?.off || 0);
      const note = outside ? ` (${words(x.clock.on)} of this on the clock; ${words(outside)} during the punched meal or after clocking out)` : "";
      return `${rangeText(x.start, x.end)} was not performing work duties and was ${activityPhrase(x.text)}.${note}`;
    });
    return { date: r.date, heading: longDate(r.date), punches: punchLine(r.punches, r.date), lines, t, person: r.person };
  });
  const sum = (k) => days.reduce((s, d) => s + d.t[k], 0);
  const grand = { onClock: sum("onClock"), nonworkOn: sum("nonworkOn"), workOn: sum("workOn"), unclearOn: sum("unclearOn"), undocumented: sum("undocumented") };
  return { person: days[0]?.person || {}, days, grand };
}

function dayTotalsText(t) {
  return [`Time on the clock: ${words(t.onClock)}.`,
    `Total time not performing work duties: ${words(t.nonworkOn)} (${t.nonworkOn} minutes).`,
    `Total time performing work duties: ${words(t.workOn)}.${t.unclearOn ? ` Unclear: ${words(t.unclearOn)}.` : ""}`];
}
const grandText = (rep) => {
  const g = rep.grand;
  return `All ${rep.days.length} days: ${words(g.nonworkOn)} (${g.nonworkOn} minutes) not performing work duties out of ${words(g.onClock)} on the clock${g.onClock ? ` (${Math.round((g.nonworkOn / g.onClock) * 100)}%)` : ""}.`;
};

export function whText(rep) {
  const out = [`Wage & Hour Review — ${rep.person.gtaName || ""}${rep.person.win ? ` (WIN ${rep.person.win})` : ""}`, ""];
  for (const d of rep.days) {
    out.push(d.heading, `Punches: ${d.punches}`);
    out.push(...(d.lines.length ? d.lines : ["No time frames of non-work were documented."]));
    out.push(...dayTotalsText(d.t), "");
  }
  if (rep.days.length > 1) out.push(grandText(rep), "");
  out.push(ASSUMPTION);
  return out.join("\n");
}

export function whHtml(rep) {
  const p = rep.person;
  const day = (d) => `<div style="margin:0 0 16px;page-break-inside:avoid">
    <div style="font-weight:700;font-size:13px;border-bottom:1px solid #1f3a5f;padding-bottom:2px;margin-bottom:4px">${esc(d.heading)}</div>
    <div style="color:#555;font-size:11px;margin-bottom:6px">Punches: ${esc(d.punches)}</div>
    ${d.lines.length ? `<ol style="margin:0 0 6px 18px;padding:0">${d.lines.map((l) => `<li style="margin:2px 0">${esc(l)}</li>`).join("")}</ol>` : `<div style="margin:0 0 6px;color:#555">No time frames of non-work were documented.</div>`}
    <div style="background:#f1f5f9;border-left:3px solid #1f3a5f;padding:4px 8px">${dayTotalsText(d.t).map((s, i) => (i === 1 ? `<b>${esc(s)}</b>` : esc(s))).join("<br>")}</div></div>`;
  return `<div style="font-family:Segoe UI,Arial,sans-serif;color:#111;font-size:12.5px;line-height:1.45">
  <div style="font-size:18px;font-weight:700">Wage &amp; Hour Review</div>
  <div style="margin-bottom:12px;color:#333">${esc(p.gtaName || "")}${p.win ? ` · WIN ${esc(p.win)}` : ""}</div>
  ${rep.days.map(day).join("")}
  ${rep.days.length > 1 ? `<div style="border-top:2px solid #1f3a5f;padding-top:6px;font-weight:600">${esc(grandText(rep))}</div>` : ""}
  <div style="margin-top:10px;font-size:11px;color:#555">${esc(ASSUMPTION)}</div>
</div>`;
}

function whSheet(reviews) {
  const rep = whReport(reviews);
  const rows = [[{ v: "Wage & Hour Review", s: "title" }], [{ v: `${rep.person.gtaName || ""}${rep.person.win ? `  ·  WIN ${rep.person.win}` : ""}`, s: "label" }], []];
  for (const d of rep.days) {
    rows.push([{ v: d.heading, s: "label" }], [{ v: `Punches: ${d.punches}`, s: "sub" }]);
    for (const l of d.lines.length ? d.lines : ["No time frames of non-work were documented."]) rows.push([{ v: l, s: "wrap" }]);
    dayTotalsText(d.t).forEach((s, i) => rows.push([{ v: s, s: i === 1 ? "total" : "wrap" }]));
    rows.push([]);
  }
  if (rep.days.length > 1) rows.push([{ v: grandText(rep), s: "total" }], []);
  rows.push([{ v: `${ASSUMPTION} This tab is as of export; it is rebuilt when the file is imported back.`, s: "sub" }]);
  return { name: "W&H Report", rows, widths: [130] };
}

export { TYPES };
