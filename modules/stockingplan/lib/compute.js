// modules/stockingplan/lib/compute.js
// Pure functions — no DOM, no chrome.*.

const FOOD_CONS_DEPTS = new Set([4, 8, 13, 2, 46, 40, 92, 95, 90, 91]);
const FOOD_CONS_RATE  = 55;   // cases per hour
const GM_RATE         = 45;   // cases per hour
const BP_RATE         = 80;   // breakpacks per hour (all depts)

// Round a raw hour value up to the nearest 30-minute mark.
function roundUpHalf(raw) {
  return Math.ceil(raw * 2) / 2;
}

export function hoursForTask(cases, breakpacks, deptNbr) {
  const rate = FOOD_CONS_DEPTS.has(Number(deptNbr)) ? FOOD_CONS_RATE : GM_RATE;
  const raw  = (cases || 0) / rate + (breakpacks || 0) / BP_RATE;
  return roundUpHalf(raw);
}

export function isFoodCons(deptNbr) {
  return FOOD_CONS_DEPTS.has(Number(deptNbr));
}

// Format hours as "1.5h", "2h", "0.5h".
export function formatHours(h) {
  if (!h) return "0h";
  return h % 1 === 0 ? `${h}h` : `${h}h`;
}

// Pair aisle rows where adjacent numbers differ by exactly 1 (8+9, 10+11, …).
// Non-A-labelled aisles (FT1, GR1, Z1 etc.) and unpaired aisles are singletons.
export function pairAisles(aisleRows) {
  if (!Array.isArray(aisleRows) || aisleRows.length === 0) return [];

  // Separate standard A-aisles from special labels.
  const standard = aisleRows.filter((r) => r.aisle_nbr != null)
    .sort((a, b) => a.aisle_nbr - b.aisle_nbr);
  const special  = aisleRows.filter((r) => r.aisle_nbr == null);

  const pairs = [];
  let i = 0;
  while (i < standard.length) {
    const a  = standard[i];
    const b  = standard[i + 1];
    const na = a.aisle_nbr;
    const nb = b?.aisle_nbr ?? null;
    const dept = a.dept_nbr ?? 92;

    if (nb !== null && nb === na + 1) {
      // Consecutive pair — two sides of the same physical aisle.
      const cases = (a.case_qty || 0) + (b.case_qty || 0);
      const bps   = (a.bp_qty   || 0) + (b.bp_qty   || 0);
      pairs.push({
        label:      `${na}/${nb}`,
        aisles:     [a, b],
        deptNbr:    dept,
        totalCases: cases,
        totalBps:   bps,
        hours:      hoursForTask(cases, bps, dept),
      });
      i += 2;
    } else {
      const cases = a.case_qty || 0;
      const bps   = a.bp_qty   || 0;
      pairs.push({
        label:      `${na}`,
        aisles:     [a],
        deptNbr:    dept,
        totalCases: cases,
        totalBps:   bps,
        hours:      hoursForTask(cases, bps, dept),
      });
      i += 1;
    }
  }

  // Append special-label aisles (FT, GR, Z, etc.) as singletons.
  for (const r of special) {
    const dept  = r.dept_nbr ?? 92;
    const cases = r.case_qty || 0;
    const bps   = r.bp_qty   || 0;
    pairs.push({
      label:      r.aisle_label,
      aisles:     [r],
      deptNbr:    dept,
      totalCases: cases,
      totalBps:   bps,
      hours:      hoursForTask(cases, bps, dept),
    });
  }

  return pairs;
}

// Detect call-out from a schedule row. CV's exact field name is unverified —
// check several candidates so we're resilient to whatever the API returns.
export function isCallOut(row) {
  if (!row) return false;
  if (row.call_off)                  return true;
  if (row.callOff)                   return true;
  if (row.absence_type)              return true;
  if (row.absenceType)               return true;
  if (/absent/i.test(row.status))    return true;
  if (/calloff/i.test(row.status))   return true;
  return false;
}

// Canonicalize name from a CV schedule row (mirrors closinglist's displayName).
export function displayName(row) {
  const raw = (row.preferred_name || row.fname || "").trim();
  if (!raw) return null;
  return raw.toLowerCase().replace(/(^|[\s\-'])(\S)/g, (_, sep, ch) => sep + ch.toUpperCase());
}

// Parse a CV timestamp string into a Date. Mirrors closinglist's parseTimestamp.
export function parseTimestamp(ts) {
  if (!ts || typeof ts !== "string") return null;
  const t = ts.trim();
  let d = new Date(t);
  if (!isNaN(d.getTime())) return d;
  let m = t.match(/^(\d{4})[/-](\d{2})[/-](\d{2})[ T](\d{1,2}):(\d{2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/);
  if (m) return new Date(+m[3], +m[1] - 1, +m[2], +m[4], +m[5]);
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

function shortPart(d) {
  if (!d || isNaN(d.getTime())) return { hm: "??", ampm: "" };
  const h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "pm" : "am";
  const h12 = h % 12 || 12;
  const mins = m === 0 ? "" : ":" + String(m).padStart(2, "0");
  return { hm: `${h12}${mins}`, ampm };
}

export function formatShiftRange(start, end) {
  const s = shortPart(start);
  const e = shortPart(end);
  if (s.ampm && e.ampm && s.ampm === e.ampm) return `${s.hm}–${e.hm}${e.ampm}`;
  return `${s.hm}${s.ampm}–${e.hm}${e.ampm}`;
}

// Build the full plan model from raw CV data.
// scheduleJson: response from Main.ashx?func=init
// freightData:  { byDept: [{dept_nbr, case_qty, bp_qty, ...}],
//                 byAisle: [{dept_nbr, aisle_nbr, case_qty, bp_qty, ...}] }
//               Either key may be null/undefined if capture failed.
// opts: { storeNbr, businessDate, startHour? }
export function buildPlan(scheduleJson, freightData, opts = {}) {
  const sched = (scheduleJson && scheduleJson.schedule) || {};
  const rows  = Array.isArray(sched.scheduled_associates) ? sched.scheduled_associates : [];

  // startHour: include shifts that start at or after this hour (24h clock).
  // Midnight-crossing shifts (start 0 or 1) are also included to catch
  // associates who came in at midnight as part of the overnight crew.
  const startH = opts.startHour ?? 22;

  const associates = [];
  for (const row of rows) {
    const name  = displayName(row);
    if (!name) continue;
    const start = parseTimestamp(row.shift_start_ts);
    const end   = parseTimestamp(row.shift_end_ts);
    if (!start || !end) continue;

    const sh = start.getHours();
    // Stocking shift: started at or after startH (e.g. 22 = 10pm),
    // OR started at/near midnight (hour 0 or 1) as part of the same overnight run.
    if (sh < startH && sh > 1) continue;

    associates.push({
      name,
      start,
      end,
      calledOut: isCallOut(row),
    });
  }
  associates.sort((a, b) => a.start - b.start);

  // Build dept tasks. Supports two row shapes from the scraper:
  //   category-name format: { category_name, is_fc, case_qty, bp_qty }
  //   dept-number format:   { dept_nbr, case_qty, bp_qty }  (legacy / fallback)
  const rawDeptRows = (freightData && freightData.byDept) || [];
  const deptTasks = rawDeptRows
    .map((r) => {
      const cases      = Number(r.case_qty ?? r.cases ?? r.caseQty ?? 0);
      const breakpacks = Number(r.bp_qty ?? r.breakpacks ?? r.bpQty ?? 0);
      if (r.category_name) {
        const isFC = !!r.is_fc;
        return {
          key:        r.category_name,
          label:      r.category_name,
          isFC,
          cases,
          breakpacks,
          hours:      hoursForTask(cases, breakpacks, isFC ? 4 : 1),
        };
      }
      const deptNbr = Number(r.dept_nbr ?? r.deptNbr ?? r.dept ?? 0);
      if (!deptNbr) return null;
      return {
        key:        `D${deptNbr}`,
        label:      `Dept ${deptNbr}`,
        isFC:       isFoodCons(deptNbr),
        cases,
        breakpacks,
        hours:      hoursForTask(cases, breakpacks, deptNbr),
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      // F&C first, then alphabetical within each group.
      if (a.isFC !== b.isFC) return a.isFC ? -1 : 1;
      return a.label.localeCompare(b.label);
    });

  // Build aisle tasks. The aisle page is always D92/95 combined; all rows
  // have dept_nbr:92 set by the scraper. Show as one section labelled D92/95.
  const rawAisleRows = (freightData && freightData.byAisle) || [];
  const aisleSections = rawAisleRows.length
    ? [{ deptNbr: 9295, label: "D92/95", isFC: true, pairs: pairAisles(rawAisleRows) }]
    : [];

  return {
    storeNbr:      opts.storeNbr      || sched.store_nbr    || "",
    businessDate:  opts.businessDate  || sched.business_date || "",
    associates,
    deptTasks,
    aisleSections,
    freightCaptured: !!(rawDeptRows.length || rawAisleRows.length),
  };
}
