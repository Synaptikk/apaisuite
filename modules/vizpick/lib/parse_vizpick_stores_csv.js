// modules/vizpick/lib/parse_vizpick_stores_csv.js
//
// Parse the Tableau VizPick "Download Summary by Store" crosstab export
// (tab-separated) into per-store rows. Mirrors market120's
// lib/parse_stores_csv.js for the Clearance/Deleted "CD Store" sheet, but
// against VizPick's own column layout.
//
// Column layout (verified live 2026-08-16, sheet-thumbnail-2 = "Download
// Summary by Store" in the VizPick workbook's crosstab dialog):
//   Store · BU · Region · Market · VizPick · Cases Seen % · Location % ·
//   Total Picked · Overstock % · Pick %
// Plus a "Grand Total" summary row (blank Store/BU/Region/Market) carrying
// the all-markets rollup.
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
      },
    };
  }
  return { ok: false, reason: "no Grand Total row found" };
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
