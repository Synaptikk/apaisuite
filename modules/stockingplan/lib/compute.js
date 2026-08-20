// modules/stockingplan/lib/compute.js
// Pure functions — no DOM, no chrome.*.
//
// Freight math ported from CaseVisibility's own calc.js/config.js (see
// tools/FINDINGS.md). Rates & groupings live in cvRates.js.

import {
  isFoodCons, stockingHours, cphForDept, deptLabel, AISLE_DEPTS,
  ALLOWED_SHIPMENT_TYPES, layoutRank, HIDDEN_DEPTS, groupNameForDept,
} from "./cvRates.js";

// Associate role detection based on CaseVisibility job groups
const ROLE_PATTERNS = {
  stock2: [/stocking\s*2/i, /stock\s*2\s*ta/i],
  stock3: [
    /overnight\s*ta/i, /o\/n\s*ta/i, /stocking\s*3/i, /stock\s*3/i,
    /overnight\s*stock/i, /overnight\s*support/i, /^overnight$/i, /overnight.*assoc/i,
  ],
  modteam: [/mod\s*team/i, /overnight\s*mod/i, /modular/i],
  maintenance: [/overnight.*maintenance/i, /maintenance.*overnight/i, /o\/n.*maintenance/i],
};

// Detect associate role from job descriptions.
export function detectRole(row) {
  const descs = [row.shift1_job_desc, row.shift2_job_desc]
    .filter(Boolean).map((d) => String(d).toLowerCase());
  for (const desc of descs) {
    if (ROLE_PATTERNS.stock2.some((p) => p.test(desc))) return "stock2";
    if (ROLE_PATTERNS.stock3.some((p) => p.test(desc))) return "stock3";
    if (ROLE_PATTERNS.modteam.some((p) => p.test(desc))) return "modteam";
    if (ROLE_PATTERNS.maintenance.some((p) => p.test(desc))) return "maintenance";
  }
  return null;
}

// Detect call-out from a schedule row.
export function isCallOut(row) {
  if (!row) return false;
  if (row.call_off || row.callOff || row.absence_type || row.absenceType) return true;
  if (/absent/i.test(row.status) || /calloff/i.test(row.status)) return true;
  return false;
}

// Canonicalize name from a CV schedule row.
export function displayName(row) {
  const raw = (row.preferred_name || row.fname || "").trim();
  if (!raw) return null;
  return raw.toLowerCase().replace(/(^|[\s\-'])(\S)/g, (_, sep, ch) => sep + ch.toUpperCase());
}

// Parse a CV timestamp string into a Date.
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

// --- Freight rollups (from psn_apiJson loads) -------------------------------

// A "load" = { load_id, shipment_type, shipment_details: [{dept_nbr, full_cases,
//   bkpk_units, gtin_nbr, aisle_loc, ...}] }.

// Convert an ISO timestamp to a store-local yyyy-mm-dd date string.
export function localDateInTz(iso, tz) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  try {
    return d.toLocaleDateString("en-CA", { timeZone: tz || "America/Chicago" });
  } catch (_e) {
    return d.toLocaleDateString("en-CA");
  }
}

// Normalise an arbitrary date value to yyyy-mm-dd (no tz shift). For moved
// trailers, CV compares plain date strings (cmn_getDateString), not tz-adjusted.
function plainDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

// Faithful port of CaseVisibility's psn_checkIncludeInPlanOrNot(loadID, date).
// planMeta: { source: "sfd"|"sds", moved: [{load_id, unload_date}],
//   trailers: [{loadId, status, deliverByTs, tz, hasActual, caseQtyNull,
//   pckQtyDefined}] }
// businessDate: "yyyy-mm-dd". Returns true if the load belongs to that day's plan.
export function shouldIncludeLoad(loadId, businessDate, planMeta) {
  if (!planMeta) return true; // no metadata → keep all (back-compat)
  const want = plainDate(businessDate);

  // 1. Manually-moved trailers win.
  for (const mv of planMeta.moved || []) {
    if (String(mv.load_id) === String(loadId)) {
      if (!mv.unload_date) return false;           // removed from all plans
      return plainDate(mv.unload_date) === want;   // must be unloaded this day
    }
  }

  // 2. Otherwise use the trailer's deliver-by date.
  for (const tr of planMeta.trailers || []) {
    if (String(tr.loadId) !== String(loadId)) continue;
    if (tr.status === "Tender Canceled") return false;
    if (tr.deliverByTs) {
      return localDateInTz(tr.deliverByTs, tr.tz) === want;
    }
    if (tr.hasActual) {
      if (planMeta.source === "sfd" && tr.caseQtyNull) return false;
      if (planMeta.source === "sds" && tr.pckQtyDefined) return false;
    }
  }
  return true;
}

// Filter a loads array to those included in the given plan date.
export function filterLoadsForDate(loads, businessDate, planMeta) {
  if (!planMeta) return loads || [];
  return (loads || []).filter((l) => shouldIncludeLoad(l.load_id, businessDate, planMeta));
}

// Sum cases + inner packs per department across all loads, honouring the
// shipment-type allow-list. Returns array sorted F&C first, then by dept.
export function rollupByDept(loads, liveCph) {
  const map = new Map(); // deptNbr -> { cases, innerPacks }
  for (const load of loads || []) {
    if (!ALLOWED_SHIPMENT_TYPES.has(load.shipment_type)) continue;
    for (const d of load.shipment_details || []) {
      const dept = Number(d.dept_nbr);
      if (!dept) continue;
      const cur = map.get(dept) || { cases: 0, innerPacks: 0 };
      cur.cases += Number(d.full_cases) || 0;
      cur.innerPacks += Number(d.bkpk_units) || 0;
      map.set(dept, cur);
    }
  }

  const tasks = [];
  for (const [dept, v] of map) {
    if (v.cases === 0 && v.innerPacks === 0) continue;
    if (HIDDEN_DEPTS.has(dept)) continue; // 92/95 covered by by-aisle breakdown
    const isFC = isFoodCons(dept);
    const hours = stockingHours(v.cases, dept, liveCph)
                + stockingHours(v.innerPacks, dept, liveCph);
    tasks.push({
      key: `D${dept}`,
      deptNbr: dept,
      label: deptLabel(dept),
      isFC,
      group: groupNameForDept(dept),
      cases: v.cases,
      innerPacks: v.innerPacks,
      cph: cphForDept(dept, liveCph),
      hours,
    });
  }

  // Custom stocking-floor order (not ascending). See FLOOR_LAYOUT in cvRates.js.
  tasks.sort((a, b) => {
    const ra = layoutRank(a.deptNbr);
    const rb = layoutRank(b.deptNbr);
    return ra[0] - rb[0] || ra[1] - rb[1];
  });
  return tasks;
}

// Normalise an aisle_loc string to its PRIMARY aisle label.
// aisle_loc can be a comma-separated list of every facing an item has
// (e.g. "A20, A17" or "GR1, A20, A18"). The first entry is the primary
// stocking location, so items collapse into one bucket instead of spawning
// bogus "A20, A17" rows. Returns "" for blanks.
export function primaryAisle(aisleLoc) {
  if (!aisleLoc) return "";
  const first = String(aisleLoc).split(",")[0].trim();
  return first;
}

// Roll up D92/95 freight by aisle label (zone+aisle, e.g. "A8").
// Prefers the per-row aisle_loc field (98% populated); falls back to the
// UPC->aisle map (locations) for rows missing it.
export function rollupByAisle(loads, liveCph, aisleMap) {
  // Build UPC -> "zone+aisle" fallback lookup from the location map.
  const upcToAisle = new Map();
  if (aisleMap && Array.isArray(aisleMap.locations)) {
    for (const loc of aisleMap.locations) {
      if (!AISLE_DEPTS.has(Number(loc.dept_nbr))) continue;
      upcToAisle.set(Number(loc.upc_nbr), `${loc.zone}${loc.aisle}`);
    }
  }

  const map = new Map(); // aisleLabel -> { cases, innerPacks }
  let unknownCases = 0;

  for (const load of loads || []) {
    if (!ALLOWED_SHIPMENT_TYPES.has(load.shipment_type)) continue;
    for (const d of load.shipment_details || []) {
      const dept = Number(d.dept_nbr);
      if (!AISLE_DEPTS.has(dept)) continue;

      let label = primaryAisle(d.aisle_loc);
      if (!label) {
        const upc = parseInt(d.gtin_nbr, 10);
        label = upcToAisle.get(upc) || "";
      }

      const cases = Number(d.full_cases) || 0;
      const inner = Number(d.bkpk_units) || 0;
      if (cases === 0 && inner === 0) continue;

      if (!label) { unknownCases += cases + inner; continue; }

      const cur = map.get(label) || { cases: 0, innerPacks: 0, deptNbr: dept };
      cur.cases += cases;
      cur.innerPacks += inner;
      map.set(label, cur);
    }
  }

  const pairs = [...map.entries()].map(([label, v]) => ({
    label,
    deptNbr: v.deptNbr,
    totalCases: v.cases,
    totalInnerPacks: v.innerPacks,
    hours: stockingHours(v.cases, v.deptNbr, liveCph)
         + stockingHours(v.innerPacks, v.deptNbr, liveCph),
  }));

  pairs.sort((a, b) => sortAisleLabel(a.label, b.label));
  return { pairs: combineAisles(pairs, liveCph), unknownCases };
}

// Grocery aisles get walked as even/odd pairs starting at this number:
// 8/9, 10/11, 12/13, 14/15 ...  Aisles below it stay individual.
const AISLE_PAIR_FROM = 8;

// Split an aisle label like "A8" into { zone: "A", num: 8 }. Returns null if
// it doesn't parse (unknown / oddly-shaped labels are left untouched).
function splitAisleLabel(label) {
  const m = String(label).match(/^([A-Za-z]*)(\d+)$/);
  if (!m) return null;
  return { zone: m[1], num: parseInt(m[2], 10) };
}

// Merge even aisle N with the following odd N+1 (from AISLE_PAIR_FROM up) into
// a single assignable row labelled e.g. "A8/9", summing cases/inner packs and
// recomputing hours on the combined volume. Unpaired aisles pass through as-is.
function combineAisles(pairs, liveCph) {
  const byLabel = new Map(pairs.map((p) => [p.label, p]));
  const consumed = new Set();
  const out = [];

  for (const p of pairs) {
    if (consumed.has(p.label)) continue;

    const parts = splitAisleLabel(p.label);
    const isEvenPairStart =
      parts && parts.num >= AISLE_PAIR_FROM && parts.num % 2 === 0;

    if (!isEvenPairStart) { out.push(p); continue; }

    const partnerLabel = `${parts.zone}${parts.num + 1}`;
    const partner = byLabel.get(partnerLabel);
    if (!partner) { out.push(p); continue; }

    consumed.add(p.label);
    consumed.add(partnerLabel);

    const cases = p.totalCases + partner.totalCases;
    const inner = p.totalInnerPacks + partner.totalInnerPacks;
    out.push({
      label: `${parts.zone}${parts.num}/${parts.num + 1}`,
      deptNbr: p.deptNbr,
      totalCases: cases,
      totalInnerPacks: inner,
      hours: stockingHours(cases, p.deptNbr, liveCph)
           + stockingHours(inner, p.deptNbr, liveCph),
    });
  }

  out.sort((a, b) => sortAisleLabel(a.label, b.label));
  return out;
}

// Sort aisle labels naturally: zone letter, then numeric aisle (A2 < A10).
// Handles combined labels like "A8/9" by sorting on the first number.
function sortAisleLabel(a, b) {
  const pa = a.match(/^([A-Za-z]*)(\d*)/);
  const pb = b.match(/^([A-Za-z]*)(\d*)/);
  if (!pa || !pb) return a.localeCompare(b);
  if (pa[1] !== pb[1]) return pa[1].localeCompare(pb[1]);
  return (parseInt(pa[2], 10) || 0) - (parseInt(pb[2], 10) || 0);
}

// --- Plan builder -----------------------------------------------------------

// scheduleJson: response from Main.ashx?func=init
// freightData:  { loads: [...], liveCph: [...]|null, aisleMap: {aisles,locations}|null }
// opts: { storeNbr, businessDate, startHour? }
export function buildPlan(scheduleJson, freightData, opts = {}) {
  const sched = (scheduleJson && scheduleJson.schedule) || {};
  const rows = Array.isArray(sched.scheduled_associates) ? sched.scheduled_associates : [];

  const startH = opts.startHour ?? 22;
  const associates = [];
  for (const row of rows) {
    const name = displayName(row);
    if (!name) continue;
    const start = parseTimestamp(row.shift_start_ts);
    const end = parseTimestamp(row.shift_end_ts);
    if (!start || !end) continue;

    const role = detectRole(row);
    const sh = start.getHours();
    const isStock2 = role === "stock2";
    const isOvernight = role === "stock3" || role === "modteam" || role === "maintenance";
    const isOvernightHours = sh >= startH || sh <= 1;

    const includeStock2 = isStock2 && sh >= 13 && sh <= 17;
    const includeOvernight = isOvernight && isOvernightHours;
    const includeFallback = !role && isOvernightHours;

    if (!includeStock2 && !includeOvernight && !includeFallback) continue;

    associates.push({
      name, start, end,
      role: role || (includeFallback ? "stock3" : "other"),
      calledOut: isCallOut(row),
    });
  }
  associates.sort((a, b) => a.start - b.start);

  const loads = (freightData && freightData.loads) || [];
  const liveCph = (freightData && freightData.liveCph) || null;
  const aisleMap = (freightData && freightData.aisleMap) || null;
  const planMeta = (freightData && freightData.planMeta) || null;

  // Drop trailers not part of THIS day's plan (delivered-today/unload-tomorrow,
  // canceled, or moved). Mirrors CV's psn_checkIncludeInPlanOrNot.
  const planLoads = filterLoadsForDate(loads, opts.businessDate, planMeta);
  const excludedCount = loads.length - planLoads.length;

  const deptTasks = rollupByDept(planLoads, liveCph);
  const aisleRollup = rollupByAisle(planLoads, liveCph, aisleMap);
  const aisleSections = aisleRollup.pairs.length
    ? [{ deptNbr: 9295, label: "D92/95", isFC: true, pairs: aisleRollup.pairs,
         unknownCases: aisleRollup.unknownCases }]
    : [];

  return {
    storeNbr: opts.storeNbr || sched.store_nbr || "",
    businessDate: opts.businessDate || sched.business_date || "",
    associates,
    deptTasks,
    aisleSections,
    excludedLoads: excludedCount,
    freightCaptured: !!(deptTasks.length || aisleSections.length),
  };
}
