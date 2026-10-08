// modules/punchlookup/lib/parse.js
//
// Parse what Global Time & Attendance returns for ONE associate over a date
// range (see gta.js for how it is fetched). Pure; runs in the service worker,
// so regex only — no DOMParser.
//
// ── Shapes (probed live 2026-10-08) ─────────────────────────────────────────
// Timesheet page: one <tr id='tsRowN'> per day (N is global across pages,
// 7 rows a page). After the name cell the visible cells are
//   scheduled "08:00" | worked "07:54" | — | time codes "WRK 7:54 , MEAL 1:03"
//   | hour types "REG 7:54" | punch block | — | WIN | status "Confirmed"
// and the row embeds wb_tsclocks({baseDate:'20261007',clocks:[{type,time,data}]}).
// Hidden inputs after the row carry OVR_EMP_ID_N (the employee) and
// SUMMARY_ID_N.
//
// Punch `data` is a query string:
//   Actiontime=20261007215700   the second the punch was made
//   PN=Allspark                 what it was made on
//   AP=APUS-1458-009            the store access point the device was on
//   g=34.93…,-85.21…            device GPS (only some punches)
//   DKT=01458                   store the punch went to
//   TCODE=MEAL|WRK              on a type-6 (code switch) punch
//   ClockTag=P&ActionTime=…     the system's midnight split, not a person
//   W, VL, VA, O, Dst, TZ, TZNAME   flags GTA does not document; kept raw
//
// Inline details (action=LoadInlineDetailsAction&WRKS_INDEX=N): rows of
//   class 'detail'  start | end | time code | hour type | job | dept | division | facility | team
//   class 'premium' code | hour type | job | dept | division | facility | team
// (premium rows are attendance flags like AT_EXTENDED_LATE_OUT).

const PUNCH_KIND = { 1: "in", 2: "out", 6: "switch" };

const strip = (s) => String(s || "")
  .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
  .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

/** "20261007215741" → { date: "2026-10-07", hm: "21:57", hms: "21:57:41" } */
export function splitStamp(s) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?/.exec(String(s || ""));
  if (!m) return null;
  return { date: `${m[1]}-${m[2]}-${m[3]}`, hm: `${m[4]}:${m[5]}`, hms: `${m[4]}:${m[5]}:${m[6] || "00"}` };
}

/** Punch data query string → plain object (keys as GTA writes them). */
export function parsePunchData(data) {
  const out = {};
  for (const part of String(data || "").split("&")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

/** One wb_tsclocks clock → a punch the report can show. */
export function decodePunch(type, time, data) {
  const at = splitStamp(time);
  const d = parsePunchData(data);
  const kind = PUNCH_KIND[type] || `t${type}`;
  const code = d.TCODE ? d.TCODE.split("~")[0] : null;
  const system = d.ClockTag === "P";
  const exact = splitStamp(d.Actiontime || d.ActionTime);
  // A punch with no device record at all (only TZ=0) was keyed in, not
  // clocked on a device — usually a manager's edit.
  const keyed = !system && !d.PN && !d.Actiontime && !d.AP && !d.g;
  let gps = null;
  const g = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(d.g || "");
  if (g) gps = { lat: Number(g[1]), lon: Number(g[2]) };

  let label = kind === "in" ? "In" : kind === "out" ? "Out" : "Code switch";
  if (kind === "switch") label = code === "MEAL" ? "Meal start" : code === "WRK" ? "Meal end" : `Switch to ${code || "?"}`;
  if (system) label = kind === "in" ? "Carry-over in (midnight)" : kind === "out" ? "Carry-over out (midnight)" : label;

  const known = new Set(["Actiontime", "ActionTime", "PN", "AP", "g", "DKT", "TCODE", "ClockTag"]);
  const other = Object.entries(d).filter(([k]) => !known.has(k)).map(([k, v]) => `${k}=${v}`).join(" ");

  return {
    kind, label, code, system, keyed,
    date: at?.date || null, time: at?.hm || null,
    // The second the button was pressed. The system's midnight split stamps
    // when it was written, which is not a punch time, so it is left out.
    exact: system ? null : (exact?.hms || null),
    exactDate: system ? null : (exact?.date || null),
    app: d.PN || null, accessPoint: d.AP || null, store: d.DKT || null, gps,
    other,
  };
}

/** All the type/time/data clocks inside one wb_tsclocks(...) call. */
function parseClocks(block) {
  const out = [];
  for (const m of block.matchAll(/\{type:'(\d+)',time:'(\d{12,14})'(?:,data:'([^']*)')?/g)) {
    out.push(decodePunch(m[1], m[2], m[3]));
  }
  return out.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
}

/** "WRK 7:54 , MEAL 1:03" → [{ code: "WRK", hours: "7:54" }, …] */
function parseCodeList(s) {
  return [...String(s || "").matchAll(/([A-Z][A-Z0-9_]*)\s+(\d+:\d{2})/g)].map((m) => ({ code: m[1], hours: m[2] }));
}

/**
 * One timesheet page → { page, of, rows: [{ index, empId, gtaName, win, date,
 * scheduled, worked, timeCodes, hourTypes, status, punches }] }.
 */
export function parseTimesheetPage(html) {
  const h = String(html || "");
  const flat = strip(h);
  const pm = /Page\s+(\d+)\s+of\s+(\d+)/.exec(flat);
  const rows = [];
  const parts = h.split(/<tr[^>]*\bid=["']tsRow(\d+)["']/);
  // split with a capture group: [before, idx0, chunk0, idx1, chunk1, …]
  for (let i = 1; i < parts.length; i += 2) {
    const index = Number(parts[i]);
    const chunk = parts[i + 1] || "";
    const clocksM = /wb_tsclocks\(\{[^}]*?baseDate:'(\d{8})'[^[]*clocks:\[(.*?)\]\s*\}\)/s.exec(chunk);
    const who = /class=["']textMedium["']>([^<]+?)\s+-\s+(\d{6,})<\/span>/.exec(chunk);
    const empId = (/name=['"]OVR_EMP_ID_\d+['"]\s+value=['"](\d+)['"]/.exec(chunk) || /\bempid="(\d+)"/i.exec(chunk) || [])[1] || null;

    const rowBody = chunk.split(/<\/tr>\s*<input/)[0]
      .replace(/<script[\s\S]*?<\/script>/g, "")
      .replace(/<table[\s\S]*?<\/table>/g, "[T]");
    const cells = [...rowBody.matchAll(/<td[^>]*>([\s\S]*?)(?=<td|$)/g)].map((m) => strip(m[1]));
    // Anchor on the date cell ("09/10/2026 Thu", one-associate view) or the
    // name cell (the 2nd nested table, team view); the same columns follow both.
    let a = cells.findIndex((c) => /^\d{2}\/\d{2}\/\d{4}\b/.test(c));
    if (a < 0) {
      let seen = 0;
      for (let k = 0; k < cells.length; k++) if (cells[k] === "[T]" && ++seen === 2) { a = k; break; }
    }
    const cell = (n) => (a >= 0 ? cells[a + n] : "") || "";

    let date = null;
    if (clocksM) { const b = clocksM[1]; date = `${b.slice(0, 4)}-${b.slice(4, 6)}-${b.slice(6, 8)}`; }
    else {
      const wd = /name=['"]OVR_WORK_DATE_\d+['"]\s+value=['"](\d{8})/.exec(chunk);
      if (wd) date = `${wd[1].slice(0, 4)}-${wd[1].slice(4, 6)}-${wd[1].slice(6, 8)}`;
    }
    if (!date) continue;

    rows.push({
      index, empId, date,
      gtaName: who ? who[1].replace(/\s+/g, " ").trim() : null,
      win: who ? who[2] : (/^\d{6,}$/.test(cell(8)) ? cell(8) : null),
      scheduled: /^\d+:\d{2}$/.test(cell(1)) ? cell(1) : null,
      worked: /^\d+:\d{2}$/.test(cell(2)) ? cell(2) : null,
      timeCodes: parseCodeList(cell(4)),
      hourTypes: parseCodeList(cell(5)),
      status: /^[A-Za-z ]+$/.test(cell(9)) ? cell(9) : null,
      punches: clocksM ? parseClocks(clocksM[2]) : [],
    });
  }
  return { page: pm ? Number(pm[1]) : null, of: pm ? Number(pm[2]) : null, rows, none: /No Associates found/i.test(flat) };
}

/** Inline details block → { segments: [...], flags: [...] } */
export function parseDetails(html) {
  const segments = [], flags = [];
  const h = String(html || "").replace(/<script[\s\S]*?<\/script>/g, "");
  for (const tr of h.split(/<tr\b/).slice(1)) {
    const cls = (/^[^>]*class=['"]([^'"]*)['"]/.exec(tr) || [])[1] || "";
    // Positional: a cell can be blank (Facility often is), so blanks are kept.
    const cells = [...tr.matchAll(/<t[hd][^>]*>([\s\S]*?)(?=<t[hd]|<\/tr|$)/g)].map((m) => strip(m[1]));
    if (/\bdetail\b/.test(cls)) {
      const i = cells.findIndex((c) => /^\d{1,2}:\d{2}$/.test(c));
      if (i < 0 || !/^\d{1,2}:\d{2}$/.test(cells[i + 1] || "")) continue;
      const [start, end, timeCode, hourType, job, dept, division, facility, team] = cells.slice(i, i + 9);
      segments.push({ start, end, timeCode, hourType, job, dept, division, facility, team });
    } else if (/\bpremium\b/.test(cls)) {
      // Some premium rows lead with two blank cells (no start/end).
      const [code, hourType] = cells.filter(Boolean);
      if (code) flags.push({ code, hourType: hourType || null });
    }
  }
  // GTA repeats each premium row; one of each is enough.
  const seen = new Set();
  return { segments, flags: flags.filter((f) => !seen.has(f.code) && seen.add(f.code)) };
}

/**
 * Search box text → how to ask GTA. Digits = WIN; otherwise the longest word
 * goes to the server as a %contains% search on the full name ("LAST, FIRST M")
 * and every word must then appear in the name.
 */
export function planSearch(q) {
  const raw = String(q || "").trim();
  if (/^\d{5,}$/.test(raw)) return { by: "win", term: raw, words: [] };
  const words = raw.toUpperCase().replace(/[^A-Z\s'-]/g, " ").split(/\s+/).filter((w) => w.length >= 2);
  if (!words.length) return null;
  const term = [...words].sort((a, b) => b.length - a.length)[0];
  return { by: "name", term, words };
}

/** Keep lookup rows whose name holds every word of the search. */
export function filterMatches(rows, plan) {
  if (!plan || plan.by === "win") return rows;
  return rows.filter((r) => {
    const n = String(r.gtaName || "").toUpperCase();
    return plan.words.every((w) => n.includes(w));
  });
}
