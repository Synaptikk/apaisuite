// modules/stockingplan/lib/compute.js
// Pure functions — no DOM, no chrome.*.

import { rollUpShifts, capacityReport, GROUP_META } from "./shifts.js";

const FOOD_CONS_DEPTS = new Set([4, 8, 13, 2, 46, 40, 92, 95, 90, 91]);
const FOOD_CONS_RATE  = 55;   // cases per hour
const GM_RATE         = 45;   // cases per hour
const BP_RATE         = 80;   // breakpacks per hour (all depts)

// Which shift an area's freight normally lands on, taken from the plans store
// 1458 actually sent: GM/Seasonal/Fashion are Stock 2's list ("stock toys",
// "stock sporting goods", "stock automotive", "stock hardware"), the food and
// consumables areas are the overnight list ("stock 90/91/97", "stock grocery",
// "stock 4/8/13/79", "stock 2/40/46", "stock 82").
const AREA_DEFAULT_SHIFT = {
  "General Merchandise": "stock2",
  "Fashion":             "stock2",
  "Seasonal":            "stock2",
  "Frozen/Dairy/Deli":   "stock3",
  "Meat/Produce/Fresh":  "stock3",
  "Food (Non-FDD)":      "stock3",
  "Food":                "stock3",
  "Consumables":         "stock3",
};

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

// CaseVisibility reports stocking time in minutes; plans are written in hours
// to one decimal ("stock home-12.5 hours").
export function minsToHours(min) {
  return Math.round((Number(min) || 0) / 6) / 10;
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

    if (nb !== null && nb === na + 1) {
      pairs.push(makePair(`${na}/${nb}`, [a, b]));
      i += 2;
    } else {
      pairs.push(makePair(`${na}`, [a]));
      i += 1;
    }
  }

  // Append special-label aisles (FT, GR, Z, Unknown) as singletons.
  for (const r of special) pairs.push(makePair(r.aisle_label, [r]));

  return pairs;
}

function makePair(label, rows) {
  const dept  = rows[0].dept_nbr ?? 92;
  const cases = rows.reduce((s, r) => s + (r.case_qty || 0), 0);
  const bps   = rows.reduce((s, r) => s + (r.bp_qty   || 0), 0);
  // Prefer CaseVisibility's own estimate; fall back to our case rates when the
  // aisle view didn't carry a time column.
  const cvMin = rows.reduce((s, r) => s + (r.total_min || 0), 0);
  const byTrailer = mergeTrailers(rows);
  return {
    label,
    aisles:     rows,
    deptNbr:    dept,
    totalCases: cases,
    totalBps:   bps,
    hours:      cvMin ? minsToHours(cvMin) : hoursForTask(cases, bps, dept),
    cvMinutes:  cvMin,
    unknown:    rows.every((r) => r.unknown),
    byTrailer,
  };
}

function mergeTrailers(rows) {
  const m = new Map();
  for (const r of rows) {
    for (const t of r.by_trailer || []) {
      const cur = m.get(t.trailer) || { trailer: t.trailer, case_qty: 0, min: 0 };
      cur.case_qty += t.case_qty || 0;
      cur.min      += t.min || 0;
      m.set(t.trailer, cur);
    }
  }
  return [...m.values()].sort((a, b) => b.case_qty - a.case_qty);
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

// The business date after `iso` — the morning crew a plan hands work to.
export function nextIsoDate(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return "";
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function weekdayLabel(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return "";
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return d.toLocaleDateString(undefined, { weekday: "short", month: "numeric", day: "numeric" });
}

// Trucks for the business day, straight off the schedule payload's `sdl` block.
export function buildTrucks(scheduleJson) {
  const sdl = Array.isArray(scheduleJson?.sdl) ? scheduleJson.sdl : [];
  return sdl
    .map((s) => ({
      type:       s.shipment_type || "?",
      trailer:    String(s.trailer_id ?? ""),
      loadId:     String(s.load_id ?? ""),
      eta:        s.actual_delivery_ts || s.est_delivery_ts || s.sched_delivery_ts || "",
      arrived:    !!s.actual_delivery_ts,
      grocCases:  Number(s.groc_cases || 0),
      gmCases:    Number(s.gm_cases || 0),
      bpCases:    Number(s.breakpack_boxes || 0),
      totalCases: Number(s.total_cases || 0),
      status:     s.actual_delivery_ts ? "Delivered" : "Scheduled",
    }))
    .sort((a, b) => String(a.eta).localeCompare(String(b.eta)));
}

// Build the full plan model from raw CV data.
//
// scheduleJson:     response from Main.ashx?func=init for the business date
// nextScheduleJson: the same for businessDate + 1 (may be null) — the Stock 1
//                   crew that inherits whatever tonight doesn't finish
// freightData:      { areas, depts, areaTimes, aisles, trailers } from the
//                   collect-freight handler. Any key may be missing.
// opts: { storeNbr, businessDate }
export function buildPlan(scheduleJson, freightData, opts = {}) {
  const sched = (scheduleJson && scheduleJson.schedule) || {};
  const rows  = Array.isArray(sched.scheduled_associates) ? sched.scheduled_associates : [];
  const deps  = { displayName, parseTimestamp, isCallOut };

  const businessDate = opts.businessDate || sched.business_date || "";
  const nextDate     = nextIsoDate(businessDate);

  // --- labour ---------------------------------------------------------------
  const tonight = rollUpShifts(rows, deps);

  const nextRows = Array.isArray(opts.nextScheduleJson?.schedule?.scheduled_associates)
    ? opts.nextScheduleJson.schedule.scheduled_associates
    : null;
  const tomorrow = nextRows ? rollUpShifts(nextRows, deps) : null;

  // Flat associate list for the assignment autocomplete. Stocking shifts only
  // (plus the mod team and overnight maintenance, who show on the plan) —
  // the full store schedule is 250+ rows and none of the rest stock freight.
  const PLAN_GROUPS = ["stock2", "stock3", "modteam", "maintenance"];
  const associates = [];
  for (const key of PLAN_GROUPS) {
    for (const m of tonight.groups[key].members) {
      associates.push({
        name:      m.name,
        start:     m.start,
        end:       m.end,
        hours:     m.hours,
        calledOut: m.calledOut,
        jobDesc:   m.jobDesc,
        rank:      m.rank,
        role:      key,                  // view.js groups the name list on this
        group:     key,
        groupLabel: GROUP_META[key].label,
      });
    }
  }
  associates.sort((a, b) => a.start - b.start || a.name.localeCompare(b.name));

  // --- freight --------------------------------------------------------------
  const rawAreas  = (freightData && freightData.areas)  || [];
  const rawDepts  = (freightData && freightData.depts)  || [];
  const rawTimes  = (freightData && freightData.areaTimes) || [];
  const rawAisles = (freightData && freightData.aisles) || [];

  const timeByArea = new Map(rawTimes.map((t) => [t.area_name, t]));

  // Department rows, grouped under their area. This is the breakdown the plan
  // is written in — "stock 4/8/13/79", "stock 3/19/67", "stock 90/91/97".
  const deptTasks = rawDepts.map((d) => ({
    key:        `D${d.dept_nbr}`,
    label:      `D${d.dept_nbr}${d.dept_name ? ` (${d.dept_name})` : ""}`,
    area:       d.area_name,
    deptNbr:    d.dept_nbr,
    deptName:   d.dept_name,
    isFC:       !!d.is_fc,
    cases:      d.case_qty,
    breakpacks: d.bp_qty,
    // CaseVisibility computes this itself, per department, and the store plans
    // against those numbers — prefer them over our own case rates.
    hours:      d.total_min ? minsToHours(d.total_min) : hoursForTask(d.case_qty, d.bp_qty, d.dept_nbr),
    caseHours:  minsToHours(d.case_min),
    bpHours:    minsToHours(d.bp_min),
    cvMinutes:  d.total_min || 0,
    defaultShift: AREA_DEFAULT_SHIFT[d.area_name] || null,
  }));

  // Areas, in the order CaseVisibility lists them, each carrying its dept rows.
  const areaOrder = [];
  for (const d of deptTasks) if (!areaOrder.includes(d.area)) areaOrder.push(d.area);
  for (const a of rawAreas) if (!areaOrder.includes(a.area_name)) areaOrder.push(a.area_name);

  const areaSections = areaOrder.map((name) => {
    const rollUp = rawAreas.find((a) => a.area_name === name);
    const times  = timeByArea.get(name);
    const own    = deptTasks.filter((d) => d.area === name);
    const cases  = times?.case_qty ?? rollUp?.case_qty ?? own.reduce((s, d) => s + d.cases, 0);
    const bps    = times?.bp_qty   ?? rollUp?.bp_qty   ?? own.reduce((s, d) => s + d.breakpacks, 0);
    const mins   = times?.total_min ?? 0;
    return {
      name,
      isFC:       rollUp ? !!rollUp.is_fc : (own[0]?.isFC ?? false),
      cases,
      breakpacks: bps,
      hours:      mins ? minsToHours(mins) : own.reduce((s, d) => s + d.hours, 0),
      cvMinutes:  mins,
      defaultShift: AREA_DEFAULT_SHIFT[name] || null,
      depts:      own,
    };
  });

  // D92/95 by aisle — a breakdown of two departments already counted above,
  // never an addition to the store total.
  const aisleSections = rawAisles.length
    ? [{
        deptNbr: 9295,
        label:   "D92/95 by aisle",
        isFC:    true,
        pairs:   pairAisles(rawAisles),
        trailers: (freightData && freightData.trailers) || [],
      }]
    : [];

  // Required stocking hours = the area totals. Aisles and departments are both
  // breakdowns of the same freight, so only one level may be summed.
  const requiredMinutes = rawTimes.reduce((s, t) => s + (t.total_min || 0), 0);
  const requiredHours = requiredMinutes
    ? minsToHours(requiredMinutes)
    : Math.round(areaSections.reduce((s, a) => s + a.hours, 0) * 10) / 10;
  const requiredBasis = requiredMinutes ? "cv" : (areaSections.length ? "rates" : "none");

  const capacity = capacityReport(
    tonight.groups,
    tomorrow ? tomorrow.groups : null,
    requiredHours,
    { requiredBasis },
  );

  return {
    storeNbr:     opts.storeNbr     || sched.store_nbr     || "",
    businessDate,
    nextDate,
    dateLabel:     weekdayLabel(businessDate),
    nextDateLabel: weekdayLabel(nextDate),

    associates,
    shifts:      tonight.groups,
    nextShifts:  tomorrow ? tomorrow.groups : null,
    capacity,

    areaSections,
    deptTasks,
    aisleSections,
    trucks:      buildTrucks(scheduleJson),

    requiredHours,
    requiredBasis,
    freightCaptured: !!(rawAreas.length || rawDepts.length || rawAisles.length),
  };
}
