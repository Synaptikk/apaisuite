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
 * The `Total` row drives the store card. The per-department rows are returned
 * as `depts` and drive the card's "Show details" breakdown — they cost nothing
 * extra to obtain, since the export downloads them either way and the
 * expensive part is the per-store export cycle, not the row count.
 *
 * `depts` is FILTERED to departments with something to say: a store carries
 * many departments with no suggested picks and no expected cases, and Tableau
 * reports Pick % as 100% for them (0 of 0 done). Listing those would put a
 * wall of meaningless 100% rows in front of the reader and bloat the stored
 * snapshot. `deptCount` still counts every row, so the view can say how many
 * were left out.
 *
 * @param {string} text
 * @returns {{ok:boolean, total?:object, depts?:DeptRow[], deptCount?:number, reason?:string}}
 *
 * @typedef {object} DeptRow
 * @property {string} dept
 * @property {number} suggestedPicks
 * @property {number} suggestedPicksCompleted
 * @property {number} pickPct
 * @property {number} casesSeen
 * @property {number} casesExpected
 * @property {number} casesSeenPct
 * @property {number} overstockExceptions
 */
export function parseDeptBreakout(text) {
  if (!text || typeof text !== "string") return { ok: false, reason: "empty body" };
  const clean = text.replace(/^﻿/, "");
  const lines = clean.split(/\r?\n/).filter((l) => l.length);
  if (lines.length < 2) return { ok: false, reason: "no data rows" };

  const headers = lines[0].split("\t").map((h) => h.trim());
  const col = (n) => headers.indexOf(n);
  // First header that is actually present wins.
  //
  // Tableau republished this workbook on 2026-08-22 and renamed two columns:
  //   "Suggested Picks"           -> "Suggested Picks Seen"
  //   "Suggested Picks Done" replacing "Suggested Picks Completed"
  // (alongside an on-dashboard banner announcing a change to Pick % itself).
  // The exact-match lookup then failed the required-column guard below, so
  // EVERY store in the market failed to parse and the Today crawl captured
  // nothing at all — while the Yesterday summary sheet, which has neither
  // column, carried on working and masked the cause.
  //
  // Both spellings are accepted rather than simply swapping to the new one:
  // stored fixtures still have to parse, a reverted workbook must not break
  // us again, and renaming columns is evidently something this source does.
  const colAny = (...names) => {
    for (const nm of names) { const i = col(nm); if (i >= 0) return i; }
    return -1;
  };
  const idx = {
    dept:            col("Dept"),
    suggested:       colAny("Suggested Picks Seen", "Suggested Picks"),
    completed:       colAny("Suggested Picks Done", "Suggested Picks Completed"),
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
    // Name what is MISSING, not just what arrived. The old message dumped the
    // whole header row and left the reader to spot the difference — which is
    // precisely the step that made a column rename look like a broken capture.
    const missing = [
      idx.dept < 0 && "Dept",
      idx.suggested < 0 && "Suggested Picks Seen / Suggested Picks",
      idx.casesExpected < 0 && "Cases Expected",
    ].filter(Boolean);
    return { ok: false, reason: `missing column(s) [${missing.join("; ")}]; got: ${headers.join(", ")}` };
  }

  let total = null;
  let deptCount = 0;
  const depts = [];
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
      const suggestedPicks = num(c[idx.suggested]);
      const casesExpected  = num(c[idx.casesExpected]);
      // Nothing suggested AND nothing expected means the department simply is
      // not in play today. Its percentages are 0-of-0 artefacts, not results.
      if (suggestedPicks <= 0 && casesExpected <= 0) continue;
      depts.push({
        dept,
        suggestedPicks,
        suggestedPicksCompleted: num(c[idx.completed]),
        pickPct:                 num(c[idx.pickPct]),
        casesSeen:               num(c[idx.casesSeen]),
        casesExpected,
        casesSeenPct:            num(c[idx.casesSeenPct]),
        overstockExceptions:     num(c[idx.overstockExc]),
      });
    }
  }

  if (!total) return { ok: false, reason: "no Total row in department breakout" };
  return { ok: true, total, depts, deptCount };
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
  const clean = text.replace(/^\ufeff/, "");
  const lines = clean.split(/\r?\n/).filter((l) => l.length);
  if (lines.length < 2) return { ok: false, reason: "no data rows" };
  return parseDonutHealthRows(lines.map((l) => l.split("\t")));
}

// ── Donut sheets, row form ──────────────────────────────────────────────────
//
// The crosstab arrives as raw TSV here, but MetricShot's export path yields
// rows already split (string[][]). These row-form functions are the single
// implementation both use — MetricShot briefly carried its own copy, and two
// parsers of one Tableau sheet is a drift waiting to happen.
//
// Two shapes of the real export that break naive parsing:
//
//   "New VizPick " carries a TRAILING SPACE, and sits beside "New VizPick
//   Remaining" — so headers are matched trimmed, and "remaining" excluded.
//
//   Tableau renders a donut as two arcs, so every value is a row PAIR: a
//   background row with the percent columns blank, then the real row. Picking
//   the first data row silently reads the background arc.

function donutCols(headerRow) {
  const norm = (headerRow || []).map((h) => String(h ?? "").trim().toLowerCase());
  const at = (i) => (i >= 0 ? i : null);
  // EXACT (trimmed) names, not substrings. The donut sheet's columns are
  // "New Location %" / "New Pick %" / "New VizPick", while the stores sheet
  // has "Location %" / "Pick %" / "VizPick" — so a substring match accepts the
  // stores sheet as a donut sheet and reads the wrong columns off it. Trimming
  // is what absorbs the trailing space in "New VizPick ", and matching "new
  // vizpick" exactly is what keeps "New VizPick Remaining" out.
  const exact = (name) => at(norm.indexOf(name));
  return {
    cases:     exact("cases seen %"),
    location:  exact("new location %"),
    pick:      exact("new pick %"),
    overstock: exact("new overstock %"),
    vizpick:   exact("new vizpick"),
    group:     exact("department group"),
  };
}

// The real row is the one carrying percentages; its partner is the background
// arc and has them blank.
function isDonutValueRow(row, c) {
  for (const i of [c.cases, c.location, c.pick, c.overstock]) {
    if (i != null && String(row[i] ?? "").trim()) return true;
  }
  return false;
}

/**
 * @param {string[][]} rows  "VizPick Donut Health" rows (row 0 = headers).
 * @returns {{ok:boolean, reason?:string, health?:{casesSeenPct:number|null,
 *            locationPct:number|null, overstockPct:number|null,
 *            pickPct:number|null, vizpick:number|null}}}
 */
export function parseDonutHealthRows(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return { ok: false, reason: "no data rows" };
  const c = donutCols(rows[0]);
  if (c.location == null || c.vizpick == null) {
    return { ok: false, reason: `unexpected columns; got: ${(rows[0] || []).join(", ")}` };
  }
  const row = rows.slice(1).find((r) => isDonutValueRow(r, c));
  if (!row) return { ok: false, reason: "no populated donut-health row" };
  const at = (i) => (i == null ? null : num(row[i]));
  return {
    ok: true,
    health: {
      casesSeenPct: at(c.cases),
      locationPct:  at(c.location),
      overstockPct: at(c.overstock),
      pickPct:      at(c.pick),
      vizpick:      at(c.vizpick),
    },
  };
}

/**
 * The three department-group rings (Fresh / F&C / GM).
 *
 * "Department Group" is a real Tableau dimension carrying its own
 * pre-aggregated score — there is no numeric department column in this export,
 * and a department-number-to-group mapping must never be inferred to fake one.
 *
 * @param {string[][]} rows  "Department Groups Donuts Health" rows.
 * @returns {Array<{group:string, vizpick:number|null}>}  dashboard order kept
 */
export function parseDepartmentGroupRows(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return [];
  const c = donutCols(rows[0]);
  if (c.group == null || c.vizpick == null) return [];

  const out = [];
  const seen = new Set();
  for (const row of rows.slice(1)) {
    if (!isDonutValueRow(row, c)) continue;      // background arc
    const group = String(row[c.group] ?? "").trim();
    if (!group || seen.has(group)) continue;
    seen.add(group);
    out.push({ group, vizpick: num(row[c.vizpick]) });
  }
  return out.slice(0, 3);
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

/**
 * Parse the VizPickDetails "Department Groups Donuts Health" sheet — the
 * Fresh / F&C / GM wheels exactly as Tableau computes them.
 *
 * Captured live 2026-08-22 (store 1). The sheet emits TWO rows per group: one
 * carrying only the score and its remainder, one carrying the component
 * percentages. Both must be merged or half the numbers go missing:
 *
 *   Department Group  Cases Seen %  New Location %  New Overstock %  New Pick %  New VizPick   New VizPick Remaining
 *   Fresh                                                                        66            34.308400693
 *   Fresh             25%           48%             95%              91%         66
 *
 * WHY THIS SHEET RATHER THAN COMPUTING IT LOCALLY
 * -----------------------------------------------
 * metricshot derived these from the department breakout, because a third
 * export cost 5-8s per store through the crosstab dialog. That derivation can
 * only use Cases % and Pick % — the breakout carries no Location or Overstock
 * per department — and Tableau weights those two at just 70% of the score.
 * Measured on the same store at the same moment:
 *
 *   local proxy   Fresh 57.9   F&C  8.2   GM  0.05
 *   Tableau       Fresh 66     F&C 28     GM 20
 *
 * Not close, and low in a way that reads as a failing store rather than a
 * different formula. The export replay (lib/sources/tableau_export_replay.js)
 * brought a sheet export down to ~700ms, so the reason for deriving it is gone.
 *
 * Note Tableau's header has a trailing space — "New VizPick " — so the lookup
 * below compares trimmed names rather than trusting it.
 */
export function parseDepartmentGroups(text) {
  if (!text || typeof text !== "string") return { ok: false, reason: "empty body" };
  const clean = text.replace(/^﻿/, "");
  const lines = clean.split(/\r?\n/).filter((l) => l.length);
  if (lines.length < 2) return { ok: false, reason: "no data rows" };

  const headers = lines[0].split("\t").map((h) => h.trim());
  const find = (...names) => {
    for (const nm of names) {
      const i = headers.findIndex((h) => h.toLowerCase() === nm.toLowerCase());
      if (i >= 0) return i;
    }
    return -1;
  };
  const idx = {
    group:     find("Department Group"),
    score:     find("New VizPick", "VizPick"),
    cases:     find("Cases Seen %"),
    location:  find("New Location %", "Location %"),
    overstock: find("New Overstock %", "Overstock %"),
    pick:      find("New Pick %", "Pick %"),
  };
  if (idx.group < 0 || idx.score < 0) {
    return {
      ok: false,
      reason: `missing column(s) [Department Group; New VizPick]; got: ${headers.join(", ")}`,
    };
  }

  // Merge the split rows. A blank cell means "this row does not carry that
  // field", NOT zero — writing 0 would render a real 0% and a missing value
  // identically, which is the failure this whole area keeps producing.
  const byGroup = new Map();
  const fields = {
    value: idx.score, casesSeenPct: idx.cases, locationPct: idx.location,
    overstockPct: idx.overstock, pickPct: idx.pick,
  };
  for (const line of lines.slice(1)) {
    const c = line.split("\t");
    const label = (c[idx.group] ?? "").trim();
    if (!label) continue;
    const cur = byGroup.get(label) || { label };
    for (const [key, i] of Object.entries(fields)) {
      if (i < 0) continue;
      const raw = (c[i] ?? "").trim();
      if (raw === "") continue;
      cur[key] = num(raw);
    }
    byGroup.set(label, cur);
  }

  const groups = [...byGroup.values()].filter((g) => Number.isFinite(g.value));
  if (!groups.length) return { ok: false, reason: "no group rows carried a score" };
  return { ok: true, groups };
}

/**
 * Parse the VizPickDetails "Download Location Details" sheet.
 *
 * Two things this gives us that no other sheet does:
 *   · Locations Seen % per DEPARTMENT — the location code is "<dept>/<bin>",
 *     so grouping by its prefix yields the numerator and denominator behind a
 *     metric that otherwise only exists per store and per group.
 *   · Which bins still hold un-pulled suggested picks, and who last scanned
 *     them.
 *
 * Per Tableau's own Metric Definitions sheet: "Suggested Picks are pulled once
 * daily at 9am for all departments… This is a baseline of work to be
 * completed." So `Suggested Picks Seen` is assigned work, not an incidental
 * count, and Seen > Done is genuine outstanding work at that location.
 *
 * ATTRIBUTION IS AN INFERENCE, NOT A SYSTEM FACT. The pick system assigns work
 * to LOCATIONS, never to people. `Max. user_id` is whoever last scanned the
 * bin. On a floor where scanning a bin means picking it and nobody backtracks,
 * that is a sound inference — but it is still an inference, which is why
 * `lastSeenAt` is carried through unchanged: a late scan has to stay visible so
 * an attribution can be checked rather than taken on trust.
 *
 * COLUMN SELECTION IS BY CONTENT, NOT BY NAME. The export has 27 columns and
 * repeats "Status" and "Location" several times with differing trailing
 * whitespace (Tableau emits one per shelf that references the field). Matching
 * on the header alone picks an arbitrary one of the duplicates; matching on
 * the shape of the values picks the one that actually holds the data.
 */
export function parseLocationDetails(text, { allScans = false } = {}) {
  if (!text || typeof text !== "string") return { ok: false, reason: "empty body" };
  const clean = text.replace(/^﻿/, "");
  const lines = clean.split(/\r?\n/).filter((l) => l.length);
  if (lines.length < 2) return { ok: false, reason: "no data rows" };

  const headers = lines[0].split("\t").map((h) => h.trim());
  const rows = lines.slice(1).map((l) => l.split("\t"));

  // Pick the column whose VALUES look right, preferring ones whose header
  // also matches. Returns -1 when nothing fits.
  const byContent = (headerRe, valueRe, minHits = 3) => {
    const named = headers
      .map((h, i) => (headerRe.test(h) ? i : -1))
      .filter((i) => i >= 0);
    const candidates = named.length ? named : headers.map((_, i) => i);
    let best = -1, bestHits = 0;
    for (const i of candidates) {
      let hits = 0;
      for (const c of rows) if (valueRe.test(String(c[i] ?? "").trim())) hits++;
      if (hits > bestHits) { best = i; bestHits = hits; }
    }
    return bestHits >= minHits ? best : -1;
  };

  const iLoc  = byContent(/^location$/i, /^\d+\s*\/\s*\d+$/);
  const iSeen = byContent(/^seen today$/i, /^(yes|no)$/i);
  const iDone = headers.findIndex((h) => /^suggested picks done$/i.test(h));
  const iSug  = headers.findIndex((h) => /^suggested picks seen$/i.test(h));
  const iWin  = headers.findIndex((h) => /user_id/i.test(h));
  const iTs   = headers.findIndex((h) => /last_seen_timestamp/i.test(h));

  if (iLoc < 0) {
    return { ok: false, reason: `no column holds "<group>/<bin>" location codes; got: ${headers.join(", ")}` };
  }

  // NOT a department. Corrected 2026-08-22 on the analyst's call: the leading
  // segment of a location code is a BIN GROUP — the bins beginning 002 are
  // "the 002s", which has nothing to do with department 2. This export carries
  // no department column at all (the Department Breakout sheet is the only
  // source of real dept numbers), so a location cannot be attributed to a
  // department from this data.
  //
  // The old name was `byDept`/`dept` and it was wrong everywhere it appeared.
  // Nothing consumed byDept, so the only thing that shipped mislabelled was
  // the pick list's group headings — but the field name is what made that
  // mistake easy to write, so it is the field name that changed.
  const byLocGroup = {};
  const gaps = [];
  const scans = [];
  const num = (v) => {
    const n = Number(String(v ?? "").replace(/[^0-9.\-]/g, ""));
    return Number.isFinite(n) ? n : 0;
  };

  for (const c of rows) {
    const loc = String(c[iLoc] ?? "").trim();
    const m = loc.match(/^(\d+)\s*\/\s*(\d+)$/);
    if (!m) continue;
    const locGroup = String(parseInt(m[1], 10));

    const d = (byLocGroup[locGroup] ??= { locsTotal: 0, locsSeen: 0, picksSeen: 0, picksDone: 0 });
    d.locsTotal++;
    if (iSeen >= 0 && /^yes$/i.test(String(c[iSeen] ?? "").trim())) d.locsSeen++;

    const sug = iSug >= 0 ? num(c[iSug]) : 0;
    const done = iDone >= 0 ? num(c[iDone]) : 0;
    const ts = iTs >= 0 ? String(c[iTs] ?? "").trim() || null : null;
    d.picksSeen += sug;
    d.picksDone += done;

    // Every scanned location, kept ONLY when the caller asks for it.
    //
    // metricshot's "Un-scanned locations" section ranks all scanned bins by
    // staleness, which is a wider set than `gaps` below — a bin scanned twelve
    // hours ago with nothing outstanding belongs in that list and not in this
    // one. Rather than have metricshot re-export the same sheet to get it, the
    // full list is available here on request, and vizpick's Today crawl asks
    // for it for the user's OWN store only. Market-wide it would be thousands
    // of rows per day for a section that only ever covers one store.
    //
    // Two fields, no more: the location and when it was last touched. Hours
    // are deliberately NOT computed here — staleness grows after capture, so
    // it has to be derived at read time or the number is wrong by however long
    // the snapshot has been sitting.
    if (allScans && ts) scans.push({ location: loc, lastSeenAt: ts });

    // Only outstanding work is retained per-bin. Keeping every location would
    // put thousands of rows per market into the snapshot for no benefit — the
    // per-bin-group rollup above already covers Location %.
    if (sug > done) {
      gaps.push({
        locGroup,
        location: loc,
        picksSeen: sug,
        picksDone: done,
        skipped: sug - done,
        win: iWin >= 0 ? String(c[iWin] ?? "").trim() || null : null,
        lastSeenAt: ts,
      });
    }
  }

  if (!Object.keys(byLocGroup).length) return { ok: false, reason: "no parseable location rows" };
  return { ok: true, byLocGroup, gaps, scans: allScans ? scans : null, locationCount: rows.length };
}

/**
 * Roll un-pulled picks up by whoever last scanned the bin.
 *
 * Bins with no scanner are returned separately rather than dropped or lumped
 * into an "unknown" associate — nobody scanned them, so they are a different
 * problem (work not started) from an associate leaving picks behind, and
 * merging the two would inflate whoever happens to sort last.
 */
export function rollUpSkippedByAssociate(gaps) {
  const byWin = new Map();
  const unattributed = [];
  for (const g of gaps || []) {
    // Drop malformed entries outright. `!g?.win` is also true for null, so
    // without this a null slips into `unattributed` and is dereferenced when
    // the skipped total is summed.
    if (!g || typeof g !== "object") continue;
    if (!g.win) { unattributed.push(g); continue; }
    const cur = byWin.get(g.win) || { win: g.win, skipped: 0, bins: [] };
    cur.skipped += g.skipped;
    cur.bins.push(g);
    byWin.set(g.win, cur);
  }
  const associates = [...byWin.values()].sort(
    (a, b) => b.skipped - a.skipped || a.win.localeCompare(b.win)
  );
  for (const a of associates) {
    a.bins.sort((x, y) => y.skipped - x.skipped || x.location.localeCompare(y.location));
  }
  return {
    associates,
    unattributed,
    unattributedSkipped: unattributed.reduce((n, g) => n + g.skipped, 0),
  };
}
