// modules/punchlookup/lib/report.js
//
// One punch report, three outputs: HTML with INLINE styles (so it survives a
// paste into Outlook and a standalone print window), plain text, and CSV.
// Pure — `data` is service.js::load's result plus { person }.

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function dayLabel(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${String(m).padStart(2, "0")}/${String(d).padStart(2, "0")}/${y}`;
}
const mdy = (iso) => { const [y, m, d] = iso.split("-"); return `${m}/${d}/${y}`; };

/** "7:54" → 474 */
const toMin = (hm) => { const m = /^(\d+):(\d{2})$/.exec(hm || ""); return m ? Number(m[1]) * 60 + Number(m[2]) : 0; };
const fromMin = (n) => `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;

export function gpsLink(g) {
  return g ? `https://www.google.com/maps?q=${g.lat},${g.lon}` : null;
}

/** Days the report shows, after the view's options. */
export function visibleDays(data, { hideEmpty = true, hideCarry = false } = {}) {
  return (data.days || [])
    .map((d) => ({ ...d, punches: hideCarry ? d.punches.filter((p) => !p.system) : d.punches }))
    .filter((d) => !hideEmpty || d.punches.length || d.worked || d.scheduled);
}

export function summarize(data) {
  const days = data.days || [];
  const punches = days.flatMap((d) => d.punches);
  const real = punches.filter((p) => !p.system);
  const count = (arr) => [...arr.reduce((m, v) => m.set(v, (m.get(v) || 0) + 1), new Map())].sort((a, b) => b[1] - a[1]);
  return {
    daysWorked: days.filter((d) => d.worked || d.punches.some((p) => !p.system)).length,
    daysScheduled: days.filter((d) => d.scheduled).length,
    worked: fromMin(days.reduce((s, d) => s + toMin(d.worked), 0)),
    scheduled: fromMin(days.reduce((s, d) => s + toMin(d.scheduled), 0)),
    punches: real.length,
    meals: real.filter((p) => p.code === "MEAL").length,
    keyed: real.filter((p) => p.keyed).length,
    withGps: real.filter((p) => p.gps).length,
    apps: count(real.map((p) => p.app).filter(Boolean)),
    accessPoints: count(real.map((p) => p.accessPoint).filter(Boolean)),
    flags: count(days.flatMap((d) => d.flags.map((f) => f.code))),
  };
}

const uniq = (a) => [...new Set(a.filter(Boolean))];
function dayFacts(d) {
  const bits = [];
  if (d.scheduled) bits.push(`Scheduled ${d.scheduled}`);
  if (d.worked) bits.push(`Worked ${d.worked}`);
  if (d.timeCodes.length) bits.push(d.timeCodes.map((c) => `${c.code} ${c.hours}`).join(", "));
  const pay = d.hourTypes.filter((c) => !/^AT_/.test(c.code));
  if (pay.length) bits.push(pay.map((c) => `${c.code} ${c.hours}`).join(", "));
  const jobs = uniq(d.segments.map((s) => s.job)), depts = uniq(d.segments.map((s) => s.dept));
  if (jobs.length) bits.push(`Job ${jobs.join(", ")}`);
  if (depts.length) bits.push(`Dept ${depts.join(", ")}`);
  if (d.status) bits.push(d.status);
  return bits;
}
// AT_* are attendance events (late out, absent…); the rest are pay codes (PTO, PSL) kept as written.
const flagText = (code) => /^AT_/.test(code) ? code.slice(3).replace(/_/g, " ").toLowerCase() : code.replace(/_/g, " ");

/** Inline-styled HTML table — the email/print body. */
export function reportHtml(data, opts = {}) {
  const p = data.person || {};
  const days = visibleDays(data, opts);
  const s = summarize({ ...data, days: visibleDays(data, { ...opts, hideEmpty: false }) });
  const th = "text-align:left;padding:4px 8px;border-bottom:1px solid #999;font-size:12px;color:#333;white-space:nowrap";
  const td = "padding:3px 8px;border-bottom:1px solid #e3e3e3;font-size:12px;vertical-align:top";
  const muted = "color:#888";

  const rows = [];
  for (const d of days) {
    const flags = d.flags.length ? ` <span style="color:#b45309">⚑ ${esc(d.flags.map((f) => flagText(f.code)).join(", "))}</span>` : "";
    rows.push(`<tr data-day="${esc(d.date)}"><td colspan="7" style="padding:8px 8px 4px;background:#f2f4f7;border-bottom:1px solid #ccc;font-size:12px">
      <b>${esc(dayLabel(d.date))}</b> &nbsp;<span style="color:#555">${esc(dayFacts(d).join(" · "))}</span>${flags}</td></tr>`);
    if (!d.punches.length) {
      rows.push(`<tr><td colspan="7" style="${td};${muted}">No punches</td></tr>`);
      continue;
    }
    for (const x of d.punches) {
      const st = x.system ? `;${muted}` : "";
      const nextDay = x.date && x.date !== d.date ? ` <span style="${muted}">(${esc(mdy(x.date).slice(0, 5))})</span>` : "";
      const pressed = x.exact && x.exact.slice(0, 5) !== x.time ? `<b style="color:#b45309">${esc(x.exact)}</b>` : esc(x.exact || "");
      const gps = x.gps ? `<a href="${esc(gpsLink(x.gps))}">${x.gps.lat.toFixed(5)}, ${x.gps.lon.toFixed(5)}</a>` : "";
      const on = x.keyed ? `<i style="color:#b45309">no device data</i>` : esc(x.app || "");
      rows.push(`<tr>
        <td style="${td}${st};white-space:nowrap"><b>${esc(x.time || "")}</b>${nextDay}</td>
        <td style="${td}${st}">${esc(x.label)}</td>
        <td style="${td}${st};white-space:nowrap">${pressed}</td>
        <td style="${td}${st}">${on}</td>
        <td style="${td}${st}">${esc(x.accessPoint || "")}</td>
        <td style="${td}${st}">${gps}</td>
        <td style="${td}${st}">${esc(x.store || "")}</td></tr>`);
    }
  }

  const top = (arr) => arr.slice(0, 6).map(([k, n]) => `${esc(k)} (${n})`).join(", ") || "—";
  return `<div style="font-family:Segoe UI,Arial,sans-serif;color:#111">
  <div style="font-size:16px;font-weight:600">${esc(p.gtaName || "Associate")}${p.win ? ` <span style="font-weight:400;color:#555">· WIN ${esc(p.win)}</span>` : ""}</div>
  <div style="font-size:12px;color:#555;margin:2px 0 8px">Time-clock punches ${esc(mdy(data.from))} – ${esc(mdy(data.to))} · Global Time &amp; Attendance · pulled ${esc(new Date(data.pulledAt || Date.now()).toLocaleString())}</div>
  <table style="border-collapse:collapse;font-size:12px;margin-bottom:10px"><tr>
    <td style="padding:2px 14px 2px 0"><b>${s.daysWorked}</b> days worked</td>
    <td style="padding:2px 14px 2px 0"><b>${s.worked}</b> hours worked / ${s.scheduled} scheduled</td>
    <td style="padding:2px 14px 2px 0"><b>${s.punches}</b> punches (${s.meals} meals)</td>
    <td style="padding:2px 14px 2px 0"><b>${s.withGps}</b> with GPS</td>
    ${s.keyed ? `<td style="padding:2px 14px 2px 0;color:#b45309"><b>${s.keyed}</b> without device data</td>` : ""}
  </tr></table>
  <div style="font-size:12px;color:#555;margin-bottom:8px">Clocked on: ${top(s.apps)}<br>Access points: ${top(s.accessPoints)}${s.flags.length ? `<br>Attendance &amp; pay codes: ${s.flags.map(([k, n]) => `${esc(flagText(k))} (${n})`).join(", ")}` : ""}</div>
  <table style="border-collapse:collapse;width:100%">
    <thead><tr><th style="${th}">Time</th><th style="${th}">Punch</th><th style="${th}">Pressed at</th><th style="${th}">Clocked on</th><th style="${th}">Access point</th><th style="${th}">GPS</th><th style="${th}">Store</th></tr></thead>
    <tbody>${rows.join("")}</tbody>
  </table>
  <div style="font-size:11px;color:#777;margin-top:8px">Time = the time GTA kept for the punch; Pressed at = the second the punch was made (bold when it differs). Grey "carry-over" punches are GTA's own midnight split, not the associate. "No device data" = the punch has no device record (keyed in, typically an edit).</div>
</div>`;
}

/** Plain text for anything that ignores HTML. */
export function reportText(data, opts = {}) {
  const p = data.person || {};
  const lines = [`${p.gtaName || "Associate"}${p.win ? ` — WIN ${p.win}` : ""}`,
    `Time-clock punches ${mdy(data.from)} – ${mdy(data.to)}`, ""];
  for (const d of visibleDays(data, opts)) {
    lines.push(`${dayLabel(d.date)}  ${dayFacts(d).join(" · ")}${d.flags.length ? `  [${d.flags.map((f) => flagText(f.code)).join(", ")}]` : ""}`);
    if (!d.punches.length) lines.push("    no punches");
    for (const x of d.punches) {
      const extra = [x.exact && x.exact.slice(0, 5) !== x.time ? `pressed ${x.exact}` : "", x.keyed ? "no device data" : x.app,
        x.accessPoint, x.gps ? `GPS ${x.gps.lat.toFixed(5)},${x.gps.lon.toFixed(5)}` : ""].filter(Boolean).join(" · ");
      lines.push(`    ${(x.time || "").padEnd(5)}  ${x.label.padEnd(26)} ${extra}`);
    }
  }
  return lines.join("\n");
}

const csvCell = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

export function reportCsv(data, opts = {}) {
  const p = data.person || {};
  const head = ["name", "win", "day", "scheduled", "worked", "time_codes", "hour_types", "jobs", "departments", "teams", "flags",
    "punch_date", "punch_time", "punch", "pressed_at", "clocked_on", "access_point", "gps_lat", "gps_lon", "store", "no_device_data", "system_split", "other"];
  const out = [head.join(",")];
  for (const d of visibleDays(data, opts)) {
    const day = [p.gtaName, p.win, d.date, d.scheduled, d.worked,
      d.timeCodes.map((c) => `${c.code} ${c.hours}`).join("; "), d.hourTypes.map((c) => `${c.code} ${c.hours}`).join("; "),
      uniq(d.segments.map((s) => s.job)).join("; "), uniq(d.segments.map((s) => s.dept)).join("; "),
      uniq(d.segments.map((s) => s.team)).join("; "), d.flags.map((f) => f.code).join("; ")];
    if (!d.punches.length) { out.push([...day, ...Array(12).fill("")].map(csvCell).join(",")); continue; }
    for (const x of d.punches) {
      out.push([...day, x.date, x.time, x.label, x.exact, x.app, x.accessPoint, x.gps?.lat, x.gps?.lon, x.store,
        x.keyed ? "Y" : "", x.system ? "Y" : "", x.other].map(csvCell).join(","));
    }
  }
  return out.join("\r\n");
}
