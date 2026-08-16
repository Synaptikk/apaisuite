// modules/vizpick/lib/parse_vizpick_stores_csv.js
//
// Parse the Tableau VizPick "Download Summary by Store" crosstab export
// (tab-separated) into per-store rows. Mirrors market120's
// lib/parse_stores_csv.js for the Clearance/Deleted "CD Store" sheet, but
// against VizPick's own column layout.
//
// Column layout (verified live 2026-08-16 by dev/probe-vizpick-source.mjs,
// sheet-thumbnail-2 = "Download Summary by Store"). The export carries 17
// columns, not the 10 that are rendered on the dashboard:
//   Store · BU · Region · Market · VizPick · Cases Seen % · Location % ·
//   Total Picked · Overstock % · Pick % · Cases Seen · Cases Expected ·
//   pallets_seen · pallets_expected · clearance_picked_tags ·
//   deleted_picked_tags · Pallets %
// Plus a "Grand Total" summary row carrying the all-markets rollup.
//
// The trailing seven columns are the raw numerators/denominators behind the
// rounded percentages, which is what lets the UI show a real "x / y" instead
// of a derived guess. Verified against live rows:
//   Cases Seen % = Cases Seen / Cases Expected
//       store 1: 10,658 / 11,164 = 95.47% → "95%"   ✓
//   Pallets %    = pallets_seen / pallets_expected
//       store 1:      282 /    294 = 95.92% → "95.92%" ✓
//
// NOTE ON Pick %: this sheet does NOT contain the Pick % denominator. The
// VizPickDetails workbook proves the real definition is
//   Pick % = Suggested Picks Completed / Suggested Picks   (343/739 = 46%)
// and that "Total Picked" is a DIFFERENT measure (452 in the same row). So
// deriving a denominator as `Total Picked / (Pick % / 100)` is wrong — it
// would have produced 982 against a true 739. Total Picked is therefore
// presented as a plain count, never as the numerator of a ratio.
//
// The crosstab export is UTF-16LE with a BOM when it arrives as bytes; by
// the time a content-script capture hands us a JS string it is already
// decoded, so this function accepts a plain string and only strips a
// leading BOM defensively.
//
// Read-only: pure function, no I/O, no network.

/**
 * @param {string} text  Tab-separated crosstab body (UTF-16 already decoded).
 * @param {object} [opts]
 * @param {string} [opts.market]  If set, keep only rows for this Market.
 * @returns {{ ok: boolean, rows: StoreRow[], reason?: string }}
 *
 * @typedef {object} StoreRow
 * @property {string} bu
 * @property {string} region
 * @property {string} market
 * @property {string} store
 * @property {number} vizpick        VizPick health score (0-100).
 * @property {number} casesSeenPct
 * @property {number} locationPct
 * @property {number} totalPicked
 * @property {number} overstockPct
 * @property {number} pickPct
 * @property {number} casesSeen        Numerator behind Cases Seen %.
 * @property {number} casesExpected    Denominator behind Cases Seen %.
 * @property {number} palletsSeen      Numerator behind Pallets %.
 * @property {number} palletsExpected  Denominator behind Pallets %.
 * @property {number} clearanceTags
 * @property {number} deletedTags
 * @property {number} palletsPct
 */
export function parseVizpickStoresCsv(text, opts = {}) {
  if (!text || typeof text !== "string") {
    return { ok: false, rows: [], reason: "empty CSV body" };
  }

  const clean = text.replace(/^\uFEFF/, "");
  const lines = clean.split(/\r?\n/).filter((l) => l.length);
  if (lines.length < 2) {
    return { ok: false, rows: [], reason: "no data rows" };
  }

  const headers = lines[0].split("\t").map((h) => h.trim());
  const col = (name) => headers.indexOf(name);

  const idx = {
    store:    col("Store"),
    bu:       col("BU"),
    region:   col("Region"),
    market:   col("Market"),
    vizpick:  col("VizPick"),
    cases:    col("Cases Seen %"),
    location: col("Location %"),
    picked:   col("Total Picked"),
    overstock:col("Overstock %"),
    pick:     col("Pick %"),
    // Raw numerators/denominators (present in the export, absent from the
    // rendered dashboard). Missing on an older/other layout → col() = -1,
    // which num(undefined) turns into 0 and hasRatio() then suppresses.
    casesSeen:     col("Cases Seen"),
    casesExpected: col("Cases Expected"),
    palletsSeen:     col("pallets_seen"),
    palletsExpected: col("pallets_expected"),
    clearanceTags:   col("clearance_picked_tags"),
    deletedTags:     col("deleted_picked_tags"),
    palletsPct:      col("Pallets %"),
  };

  // Guard against a wrong sheet being handed in.
  if (idx.store < 0 || idx.market < 0 || idx.vizpick < 0) {
    return {
      ok: false,
      rows: [],
      reason: `unexpected columns (need Store/Market/VizPick); got: ${headers.join(", ")}`,
    };
  }

  const wantMarket = opts.market != null ? String(opts.market).trim() : null;
  const rows = [];

  for (const line of lines.slice(1)) {
    const c = line.split("\t");
    const store = (c[idx.store] ?? "").trim();
    // Skip the "Grand Total" summary row and any blank store cell.
    if (!store || store.toLowerCase().includes("total")) continue;

    const market = (c[idx.market] ?? "").trim();
    if (wantMarket != null && market !== wantMarket) continue;

    rows.push({
      bu:           (c[idx.bu] ?? "").trim(),
      region:       (c[idx.region] ?? "").trim(),
      market,
      store,
      vizpick:      num(c[idx.vizpick]),
      casesSeenPct: num(c[idx.cases]),
      locationPct:  num(c[idx.location]),
      totalPicked:  num(c[idx.picked]),
      overstockPct: num(c[idx.overstock]),
      pickPct:      num(c[idx.pick]),
      casesSeen:       num(c[idx.casesSeen]),
      casesExpected:   num(c[idx.casesExpected]),
      palletsSeen:     num(c[idx.palletsSeen]),
      palletsExpected: num(c[idx.palletsExpected]),
      clearanceTags:   num(c[idx.clearanceTags]),
      deletedTags:     num(c[idx.deletedTags]),
      palletsPct:      num(c[idx.palletsPct]),
    });
  }

  if (!rows.length) {
    return {
      ok: false,
      rows: [],
      reason: wantMarket != null ? `no rows for Market ${wantMarket}` : "no store rows parsed",
    };
  }
  return { ok: true, rows };
}

/**
 * Extract the "Grand Total" row from the same crosstab — carries the
 * all-markets rollup we can use for national context, same role as
 * market120's parseNationalTotal.
 *
 * @param {string} text
 * @returns {{ok:boolean, national?:object, reason?:string}}
 */
export function parseGrandTotal(text) {
  if (!text || typeof text !== "string") return { ok: false, reason: "empty CSV body" };
  const clean = text.replace(/^\uFEFF/, "");
  const lines = clean.split(/\r?\n/).filter((l) => l.length);
  if (lines.length < 2) return { ok: false, reason: "no data rows" };

  const headers = lines[0].split("\t").map((h) => h.trim());
  const col = (name) => headers.indexOf(name);
  const idx = {
    store:    col("Store"),
    vizpick:  col("VizPick"),
    cases:    col("Cases Seen %"),
    location: col("Location %"),
    picked:   col("Total Picked"),
    overstock:col("Overstock %"),
    pick:     col("Pick %"),
    casesSeen:       col("Cases Seen"),
    casesExpected:   col("Cases Expected"),
    palletsSeen:     col("pallets_seen"),
    palletsExpected: col("pallets_expected"),
    palletsPct:      col("Pallets %"),
  };
  if (idx.store < 0 || idx.vizpick < 0) return { ok: false, reason: "unexpected columns" };

  for (const line of lines.slice(1)) {
    const c = line.split("\t");
    if (!(c[idx.store] ?? "").trim().toLowerCase().includes("total")) continue;
    return {
      ok: true,
      national: {
        vizpick:      num(c[idx.vizpick]),
        casesSeenPct: num(c[idx.cases]),
        locationPct:  num(c[idx.location]),
        totalPicked:  num(c[idx.picked]),
        overstockPct: num(c[idx.overstock]),
        pickPct:      num(c[idx.pick]),
        casesSeen:       num(c[idx.casesSeen]),
        casesExpected:   num(c[idx.casesExpected]),
        palletsSeen:     num(c[idx.palletsSeen]),
        palletsExpected: num(c[idx.palletsExpected]),
        palletsPct:      num(c[idx.palletsPct]),
      },
    };
  }
  return { ok: false, reason: "no Grand Total row found" };
}

/**
 * Parse the workbook's "Last update" crosstab sheet — the authoritative
 * source-refresh stamp, which is what the UI must show rather than the
 * browser's own capture time.
 *
 * The two views format it differently (verified live 2026-08-16):
 *   VizPick (yesterday summary) → "8/16/2026"            — date only
 *   VizPickDetails (current day) → "2026-08-16 10:26:07" — full timestamp
 *
 * @param {string} text
 * @returns {{ok:boolean, raw?:string, iso?:string, hasTime?:boolean, reason?:string}}
 */
export function parseLastUpdate(text) {
  if (!text || typeof text !== "string") return { ok: false, reason: "empty body" };
  const clean = text.replace(/^﻿/, "");

  // The sheet is a single cell; take the first non-empty tab/line-delimited
  // token that actually looks like a date.
  const tokens = clean.split(/[\t\r\n]+/).map((t) => t.trim()).filter(Boolean);

  for (const t of tokens) {
    // "2026-08-16 10:26:07" (with optional seconds / T separator)
    let m = t.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (m) {
      const [, y, mo, d, h, mi, s] = m;
      return { ok: true, raw: t, hasTime: true, iso: localIso(+y, +mo, +d, +h, +mi, +(s || 0)) };
    }
    // "8/16/2026 9:43:02 AM"
    m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
    if (m) {
      const [, mo, d, y, h, mi, s, ap] = m;
      let hh = +h;
      if (ap) {
        if (/pm/i.test(ap) && hh !== 12) hh += 12;
        if (/am/i.test(ap) && hh === 12) hh = 0;
      }
      return { ok: true, raw: t, hasTime: true, iso: localIso(+y, +mo, +d, hh, +mi, +(s || 0)) };
    }
    // "8/16/2026" — date only
    m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) {
      const [, mo, d, y] = m;
      return { ok: true, raw: t, hasTime: false, iso: localIso(+y, +mo, +d, 0, 0, 0) };
    }
    // "2026-08-16" — date only
    m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) {
      const [, y, mo, d] = m;
      return { ok: true, raw: t, hasTime: false, iso: localIso(+y, +mo, +d, 0, 0, 0) };
    }
  }
  return { ok: false, reason: `no date found in ${JSON.stringify(clean.slice(0, 120))}` };
}

/**
 * Parse the VizPickDetails "Download Department Breakout (Current Day)"
 * crosstab — the current-day figures for the ONE store the workbook's Store
 * parameter is currently set to.
 *
 * Columns (verified live 2026-08-16):
 *   Dept · Suggested Picks · Suggested Picks Completed · Pick % ·
 *   Total Picked · Cases Seen · Cases Expected · Cases Seen % ·
 *   Overstock Exceptions · Clearance Cases · Modular Deleted Cases
 * Row "Total" is the store-level rollup.
 *
 * @param {string} text
 * @returns {{ok:boolean, total?:object, deptCount?:number, reason?:string}}
 */
export function parseDeptBreakout(text) {
  if (!text || typeof text !== "string") return { ok: false, reason: "empty body" };
  const clean = text.replace(/^﻿/, "");
  const lines = clean.split(/\r?\n/).filter((l) => l.length);
  if (lines.length < 2) return { ok: false, reason: "no data rows" };

  const headers = lines[0].split("\t").map((h) => h.trim());
  const col = (n) => headers.indexOf(n);
  const idx = {
    dept:            col("Dept"),
    suggested:       col("Suggested Picks"),
    completed:       col("Suggested Picks Completed"),
    pickPct:         col("Pick %"),
    totalPicked:     col("Total Picked"),
    casesSeen:       col("Cases Seen"),
    casesExpected:   col("Cases Expected"),
    casesSeenPct:    col("Cases Seen %"),
    overstockExc:    col("Overstock Exceptions"),
    clearanceCases:  col("Clearance Cases"),
    deletedCases:    col("Modular Deleted Cases"),
  };
  if (idx.dept < 0 || idx.suggested < 0 || idx.casesExpected < 0) {
    return { ok: false, reason: `unexpected columns; got: ${headers.join(", ")}` };
  }

  let total = null;
  let deptCount = 0;
  for (const line of lines.slice(1)) {
    const c = line.split("\t");
    const dept = (c[idx.dept] ?? "").trim();
    if (!dept) continue;
    if (dept.toLowerCase() === "total") {
      total = {
        suggestedPicks:          num(c[idx.suggested]),
        suggestedPicksCompleted: num(c[idx.completed]),
        pickPct:                 num(c[idx.pickPct]),
        totalPicked:             num(c[idx.totalPicked]),
        casesSeen:               num(c[idx.casesSeen]),
        casesExpected:           num(c[idx.casesExpected]),
        casesSeenPct:            num(c[idx.casesSeenPct]),
        overstockExceptions:     num(c[idx.overstockExc]),
        clearanceCases:          num(c[idx.clearanceCases]),
        deletedCases:            num(c[idx.deletedCases]),
      };
    } else {
      deptCount++;
    }
  }

  if (!total) return { ok: false, reason: "no Total row in department breakout" };
  return { ok: true, total, deptCount };
}

/**
 * Parse the VizPickDetails "VizPick Donut Health" crosstab — the current-day
 * equivalents of the dashboard's five rings for the ONE store the Store
 * parameter is set to. This is the only place the current-day Location %,
 * Overstock % and VizPick composite are exportable; the department breakout
 * carries neither.
 *
 * Columns (verified live 2026-08-16):
 *   Cases Seen % · New Location % · New Overstock % · New Pick % ·
 *   New VizPick · New VizPick Remaining
 *
 * The sheet emits a spacer row whose percentage cells are blank and only
 * "New VizPick"/"Remaining" are filled, so we take the first row that
 * actually has a Location % value.
 *
 * @param {string} text
 * @returns {{ok:boolean, health?:object, reason?:string}}
 */
export function parseDonutHealth(text) {
  if (!text || typeof text !== "string") return { ok: false, reason: "empty body" };
  const clean = text.replace(/^﻿/, "");
  const lines = clean.split(/\r?\n/).filter((l) => l.length);
  if (lines.length < 2) return { ok: false, reason: "no data rows" };

  const headers = lines[0].split("\t").map((h) => h.trim());
  const col = (n) => headers.indexOf(n);
  const idx = {
    cases:     col("Cases Seen %"),
    location:  col("New Location %"),
    overstock: col("New Overstock %"),
    pick:      col("New Pick %"),
    vizpick:   col("New VizPick"),
  };
  if (idx.location < 0 || idx.vizpick < 0) {
    return { ok: false, reason: `unexpected columns; got: ${headers.join(", ")}` };
  }

  for (const line of lines.slice(1)) {
    const c = line.split("\t");
    const loc = (c[idx.location] ?? "").trim();
    if (!loc) continue; // spacer row
    return {
      ok: true,
      health: {
        casesSeenPct: num(c[idx.cases]),
        locationPct:  num(c[idx.location]),
        overstockPct: num(c[idx.overstock]),
        pickPct:      num(c[idx.pick]),
        vizpick:      num(c[idx.vizpick]),
      },
    };
  }
  return { ok: false, reason: "no populated donut-health row" };
}

// Build an ISO-8601 string in LOCAL time (Tableau reports store-local wall
// clock; treating it as UTC would shift the displayed time by the offset).
function localIso(y, mo, d, h, mi, s) {
  return new Date(y, mo - 1, d, h, mi, s).toISOString();
}

// Parse a Tableau numeric cell: strips $ , % whitespace; supports "(x)"
// accounting-negative notation. Returns 0 for unparseable/empty.
function num(s) {
  if (s == null) return 0;
  let str = String(s).trim();
  const negParen = /^\(.*\)$/.test(str);
  str = str.replace(/[()$%,\s]/g, "");
  const n = Number(str);
  if (!Number.isFinite(n)) return 0;
  return negParen ? -Math.abs(n) : n;
}
