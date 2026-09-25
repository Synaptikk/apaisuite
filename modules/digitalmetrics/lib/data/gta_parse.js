// modules/digitalmetrics/lib/data/gta_parse.js
//
// Parse what Global Time & Attendance returns (see sources/gta_timesheet.js
// for how it is fetched). Pure.
//
// Lookup body: a JSON array whose first element is a header and the rest
// { data: ["379159~|~379159", "101639354~|~<span>101639354</span>",
//          "SCOTT, TOM ~|~<span>SCOTT, TOM </span>"] } — empId, WIN, name.
//
// Timesheet HTML: one <tr id="tsRowN"> per employee-day, carrying
//   <span class="textMedium">ABRAHAM, STEYSHAWN - 229107070</span>
//   <div class="wb_tsschedhrsui" empid="12637072" workdate="1790053200000">
//   wb_tsclocks({name:'c_1',baseDate:'20260922',clocks:[
//     {type:'1',time:'20260922050900',data:'…'},   1 = clock in
//     {type:'6',time:'20260922100300',data:'TCODE=MEAL…'},  6 = code switch
//     {type:'2',time:'20260922141100',data:'…'}]})  2 = clock out

const PUNCH_TYPES = { 1: "in", 2: "out", 6: "switch" };

/** "20260922050900" → { date: "2026-09-22", min: 309 } */
function stamp(s) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(String(s));
  if (!m) return null;
  return { date: `${m[1]}-${m[2]}-${m[3]}`, min: parseInt(m[4], 10) * 60 + parseInt(m[5], 10) };
}

export function hhmm(min) {
  if (min == null) return null;
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

/** Lookup JSON → [{ empId, win, gtaName }]. Tolerates junk (returns []). */
export function parseLookupRows(text) {
  let arr;
  try { arr = JSON.parse(text); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const val = (cell) => String(cell ?? "").split("~|~")[0].trim();
  return arr.slice(1).map((r) => r?.data).filter((d) => Array.isArray(d) && d.length >= 3)
    .map((d) => ({ empId: val(d[0]), win: val(d[1]), gtaName: val(d[2]).replace(/\s+/g, " ") }))
    .filter((r) => r.empId && r.gtaName);
}

const letters = (s) => String(s || "").toUpperCase().replace(/[^A-Z\s,'-]/g, "").trim();

/**
 * Pick the GTA person for a board name ("KIRA JUNE", "Kira M June").
 * GTA holds "LAST, FIRST M". A match needs the same surname and first name;
 * failing that, the only person with that surname whose first name is a
 * prefix of the board's or the other way round ("CHRIS" ↔ "CHRISTOPHER").
 * Anything more ambiguous is left unmatched — a wrong clock-in is worse than
 * a missing one.
 */
export function matchLookup(name, rows) {
  const parts = letters(name).split(/\s+/).filter(Boolean);
  if (parts.length < 2 || !rows?.length) return null;
  const first = parts[0], last = parts.at(-1);
  const people = rows.map((r) => {
    const [l, rest = ""] = letters(r.gtaName).split(",");
    return { ...r, last: l.trim(), given: rest.trim(), first: rest.trim().split(/\s+/)[0] || "" };
  }).filter((r) => r.last === last || r.last.replace(/[\s'-]/g, "") === last.replace(/[\s'-]/g, ""));

  let exact = people.filter((r) => r.first === first);
  // Two "QUANG NGO"s: the board's middle name ("QUANG HIEN NGO") settles it
  // when GTA's given names ("QUANG HIEN" vs "QUANG HIEP") differ there.
  if (exact.length > 1 && parts.length > 2) {
    const given = parts.slice(0, -1).join(" ");
    const full = exact.filter((r) => r.given === given || r.given.startsWith(`${given} `));
    if (full.length) exact = full;
  }
  const prefix = people.filter((r) => r.first && (r.first.startsWith(first) || first.startsWith(r.first)));
  const pick = exact.length === 1 ? exact[0]
    : exact.length === 0 && prefix.length === 1 ? prefix[0] : null;
  return pick ? { empId: pick.empId, win: pick.win, gtaName: pick.gtaName } : null;
}

/**
 * Timesheet HTML → one entry per employee-day:
 * { empId, win, gtaName, date, clockIn, clockOut, punches:[{ kind, at, code }] }
 * `clockIn`/`clockOut` are minutes since midnight of `date` (a punch after
 * midnight counts past 1440).
 */
export function parseTimesheetRows(html) {
  const out = [];
  const chunks = String(html || "").split(/<tr[^>]*\bid=["']tsRow\d+["']/).slice(1);
  for (const c of chunks) {
    const clocksM = /wb_tsclocks\(\{[^}]*?baseDate:'(\d{8})'[^[]*clocks:\[(.*?)\]\s*\}\)/s.exec(c);
    if (!clocksM) continue;
    const who = /class="textMedium">([^<]+?)\s+-\s+(\d{6,})<\/span>/.exec(c);
    const empId = (/\bempid="(\d+)"/i.exec(c) || /wbempid="(\d+)"/.exec(c) || [])[1] || null;
    const wd = /workdate="(\d{12,})"/.exec(c);
    let date;
    if (wd) {
      const d = new Date(Number(wd[1]));
      date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    } else {
      const b = clocksM[1];
      date = `${b.slice(0, 4)}-${b.slice(4, 6)}-${b.slice(6, 8)}`;
    }
    const dayStart = Date.parse(`${date}T00:00:00Z`);

    const punches = [];
    for (const p of clocksM[2].matchAll(/\{type:'(\d+)',time:'(\d{12,14})'(?:,data:'([^']*)')?/g)) {
      const s = stamp(p[2]);
      if (!s) continue;
      const dayOffset = Math.round((Date.parse(`${s.date}T00:00:00Z`) - dayStart) / 86_400_000);
      const code = (/TCODE=([A-Z_]+)/.exec(p[3] || "") || [])[1] || null;
      punches.push({ kind: PUNCH_TYPES[p[1]] || `t${p[1]}`, min: s.min + dayOffset * 1440, code });
    }
    punches.sort((a, b) => a.min - b.min);
    const ins = punches.filter((p) => p.kind === "in"), outs = punches.filter((p) => p.kind === "out");

    out.push({
      empId, win: who?.[2] || null, gtaName: who?.[1]?.trim() || null, date,
      clockIn: ins.length ? ins[0].min : null,
      clockOut: outs.length ? outs.at(-1).min : null,
      punches: punches.map((p) => ({ kind: p.kind, at: hhmm(p.min), code: p.code })),
    });
  }
  return out;
}
