// modules/closinglist/lib/parse.js
//
// Verbatim port of ClosingList's lib/parse.js. Pure functions only — no DOM,
// no chrome.*. Exported as an ES module (the original was an IIFE namespace
// + a module.exports for Node testability). Generic helpers (parseTimestamp,
// titleCase, formatShiftRange) will be considered for extraction to
// shared/dates.js + shared/strings.js in Phase 4, once a second consumer
// validates the API surface (per docs/MIGRATION_PLAN.md::Phase 4).

// --- Timestamp parsing ----------------------------------------------------
// CaseVisibility shift_*_ts strings are length 16. We've inferred the format
// is "YYYY/MM/DD HH:MM" but accept several common alternates.
export function parseTimestamp(ts) {
  if (!ts || typeof ts !== "string") return null;
  const trimmed = ts.trim();
  // Try ISO with T first ("2026-05-22T13:00", "2026-05-22T13:00:00", "...Z")
  let d = new Date(trimmed);
  if (!isNaN(d.getTime())) return d;
  // Try "YYYY/MM/DD HH:MM" or "YYYY-MM-DD HH:MM"
  let m = trimmed.match(/^(\d{4})[/-](\d{2})[/-](\d{2})[ T](\d{1,2}):(\d{2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  // Try "MM/DD/YYYY HH:MM"
  m = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/);
  if (m) return new Date(+m[3], +m[1] - 1, +m[2], +m[4], +m[5]);
  // Try "MM/DD/YYYY HH:MM AM/PM"
  m = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (m) {
    let h = +m[4];
    if (/PM/i.test(m[6]) && h < 12) h += 12;
    if (/AM/i.test(m[6]) && h === 12) h = 0;
    return new Date(+m[3], +m[1] - 1, +m[2], h, +m[5]);
  }
  return null;
}

export function formatTime12h(d) {
  if (!d || isNaN(d.getTime())) return "??";
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")} ${ampm}`;
}

function _shortPart(d) {
  if (!d || isNaN(d.getTime())) return { hm: "??", ampm: "" };
  const h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "pm" : "am";
  const h12 = h % 12 || 12;
  const minutes = m === 0 ? "" : ":" + String(m).padStart(2, "0");
  return { hm: `${h12}${minutes}`, ampm };
}
// Compact form: "8am-5pm" when different ampm; "1:30-10:30pm" when same.
// Whole hours drop the ":00".
export function formatShiftRange(start, end) {
  const s = _shortPart(start);
  const e = _shortPart(end);
  if (s.ampm && e.ampm && s.ampm === e.ampm) {
    return `${s.hm}-${e.hm}${e.ampm}`;
  }
  return `${s.hm}${s.ampm}-${e.hm}${e.ampm}`;
}

// --- Display name ---------------------------------------------------------
export function titleCase(s) {
  if (!s) return "";
  return String(s).toLowerCase().replace(/(^|[\s\-'])(\S)/g, (_, sep, ch) => sep + ch.toUpperCase());
}
export function displayName(assoc) {
  const raw = (assoc.preferred_name || assoc.fname || "").trim();
  if (!raw) return null;
  return titleCase(raw);
}

// --- IVR cross-reference --------------------------------------------------
// IVR names come in "LAST, FIRST" all-caps form. CaseVisibility rows have
// fname + lname + preferred_name. We match on (fname OR preferred_name) +
// lname, case-insensitive.
function normaliseKey(first, last) {
  return `${String(first || "").trim().toLowerCase()}|${String(last || "").trim().toLowerCase()}`;
}
export function parseIvrName(raw) {
  if (!raw) return { first: "", last: "" };
  const parts = String(raw).split(",");
  if (parts.length < 2) return { first: "", last: String(raw).trim() };
  return {
    last: parts[0].trim(),
    first: parts.slice(1).join(",").trim().split(/\s+/)[0],
  };
}
export function isTrueAbsence(absenceType) {
  if (!absenceType) return false;
  return /absence/i.test(absenceType) && !/tardy/i.test(absenceType);
}
export function buildIvrAbsenceMap(ivrRows) {
  const map = new Map();
  if (!Array.isArray(ivrRows)) return map;
  for (const r of ivrRows) {
    if (!isTrueAbsence(r.absence_type)) continue;
    const { first, last } = parseIvrName(r.associate);
    if (!first || !last) continue;
    const key = normaliseKey(first, last);
    map.set(key, {
      rawName: r.associate,
      reason: r.absence_reason,
      callTime: r.call_date_time,
    });
  }
  return map;
}
function findIvrMatch(assoc, ivrMap) {
  if (!ivrMap || ivrMap.size === 0) return null;
  const lname = (assoc.lname || "").trim();
  const candidates = [assoc.fname, assoc.preferred_name].filter(Boolean);
  for (const first of candidates) {
    const hit = ivrMap.get(normaliseKey(first, lname));
    if (hit) return hit;
  }
  return null;
}

// --- Afternoon/evening filter --------------------------------------------
export function passesAfternoonFilter(start, end, cutoff) {
  if (!cutoff) cutoff = { startHour: 13, endHour: 17 };
  if (start && start.getHours() >= cutoff.startHour) return true;
  if (end && end.getHours() >= cutoff.endHour) return true;
  // edge case: shift ending at exactly midnight or after means evening
  if (end && (end.getHours() === 0 || end.getHours() >= cutoff.endHour)) return true;
  return false;
}

export function isOvernight(start, end) {
  if (!start || !end) return false;
  return start.toDateString() !== end.toDateString();
}

export function parseExcludePatterns(text) {
  if (!text) return [];
  return String(text).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function matchesExclusion(assoc, patternsLower) {
  if (!patternsLower || patternsLower.length === 0) return null;
  const descs = [];
  if (assoc.shift1_job_desc) descs.push(String(assoc.shift1_job_desc).toLowerCase());
  if (assoc.shift2_job_desc) descs.push(String(assoc.shift2_job_desc).toLowerCase());
  for (const p of patternsLower) {
    for (const d of descs) {
      if (d.includes(p)) return p;
    }
  }
  return null;
}

// --- Build the email model -----------------------------------------------
export function build(apiResponse, opts) {
  opts = opts || {};
  const cutoff = opts.cutoff || { startHour: 13, endHour: 17 };
  const excludeOvernight = opts.excludeOvernight !== false;
  const excludeJobPatterns = parseExcludePatterns(opts.excludeJobs || "");
  const ivrMap = buildIvrAbsenceMap(opts.ivrRows || []);
  const sched = (apiResponse && apiResponse.schedule) || {};
  const rows = Array.isArray(sched.scheduled_associates) ? sched.scheduled_associates : [];

  const included = [];
  const jobDescCounts = new Map();
  let skippedNoName = 0;
  let skippedNoShift = 0;
  let skippedNotAfternoon = 0;
  let skippedOvernight = 0;
  let skippedByJobFilter = 0;

  for (const a of rows) {
    for (const desc of [a.shift1_job_desc, a.shift2_job_desc]) {
      if (desc) jobDescCounts.set(desc, (jobDescCounts.get(desc) || 0) + 1);
    }
    const name = displayName(a);
    if (!name) { skippedNoName++; continue; }
    const start = parseTimestamp(a.shift_start_ts);
    const end   = parseTimestamp(a.shift_end_ts);
    if (!start || !end) { skippedNoShift++; continue; }
    if (!passesAfternoonFilter(start, end, cutoff)) { skippedNotAfternoon++; continue; }
    if (excludeOvernight && isOvernight(start, end)) { skippedOvernight++; continue; }
    const matched = matchesExclusion(a, excludeJobPatterns);
    if (matched) { skippedByJobFilter++; continue; }
    const jobLabel = a.shift1_job_desc || a.shift2_job_desc || "";
    const calledOff = findIvrMatch(a, ivrMap);
    included.push({ name, start, end, jobLabel, calledOff });
  }

  included.sort((a, b) => a.start - b.start);

  const uniqueJobDescs = [...jobDescCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([desc, count]) => ({ desc, count }));

  const matchedKeys = new Set();
  for (const a of rows) {
    if (findIvrMatch(a, ivrMap)) {
      const key = normaliseKey(a.fname || a.preferred_name, a.lname);
      matchedKeys.add(key);
    }
  }
  const unmatchedIvr = [];
  for (const [key, val] of ivrMap.entries()) {
    if (!matchedKeys.has(key)) unmatchedIvr.push(val);
  }

  return {
    storeNbr: sched.store_nbr || null,
    businessDate: sched.business_date || null,
    totalScheduled: rows.length,
    includedCount: included.length,
    skipped: { skippedNoName, skippedNoShift, skippedNotAfternoon, skippedOvernight, skippedByJobFilter },
    cutoff,
    excludeOvernight,
    excludeJobPatterns,
    associates: included,
    uniqueJobDescs,
    ivrTotalAbsences: ivrMap.size,
    ivrUnmatched: unmatchedIvr,
  };
}

// --- Render to email text -------------------------------------------------
export function render(model, opts) {
  opts = opts || {};
  const store = model.storeNbr || opts.storeNbr || "";
  const date = model.businessDate || opts.businessDate || "";
  const lines = [];
  lines.push(`Closing List — Store ${store} — ${date}`);
  lines.push("");
  if (model.associates.length === 0) {
    lines.push("(no associates matched the filters)");
  } else {
    const groups = new Map();
    for (const a of model.associates) {
      const key = a.jobLabel || "(no job)";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(a);
    }
    const groupKeys = [...groups.keys()].sort((a, b) => a.localeCompare(b));
    for (const key of groupKeys) {
      const members = groups.get(key).slice().sort((a, b) => a.start - b.start);
      lines.push(key);
      for (const a of members) {
        const suffix = a.calledOff
          ? " CALLED OFF" + (a.calledOff.reason && a.calledOff.reason !== "None" ? ` (${a.calledOff.reason})` : "")
          : "";
        lines.push(`  ${a.name}: ${formatShiftRange(a.start, a.end)}:${suffix}`);
      }
      lines.push("");
    }
  }
  if (model.ivrUnmatched && model.ivrUnmatched.length) {
    lines.push("IVR absences with no scheduled match in CaseVisibility:");
    for (const u of model.ivrUnmatched) {
      lines.push(`  ${u.rawName}${u.reason && u.reason !== "None" ? " (" + u.reason + ")" : ""}`);
    }
    lines.push("");
  }
  if (opts.showJobTitles && model.uniqueJobDescs.length) {
    lines.push("— Job titles seen in today's data (for tuning the exclude filter) —");
    for (const j of model.uniqueJobDescs) {
      lines.push(`  ${j.desc}  (${j.count})`);
    }
  }
  return lines.join("\n");
}
