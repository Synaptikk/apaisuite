// modules/market120/lib/parse_stores_csv.js
//
// Parse the Tableau "CD Store" crosstab export (tab-separated) into
// per-store rows. This is the store-level counterpart to parse_tableau.js:
// where that scraped KPI cards from VizQL (the PNG-tile dead-end), this
// consumes the *crosstab CSV export* — the path that actually yields real,
// machine-readable store-level numbers.
//
// The crosstab export is UTF-16LE with a BOM when it arrives as bytes; by
// the time a content-script capture hands us a JS string it is already
// decoded, so this function accepts a plain string and only strips a leading
// BOM defensively.
//
// CD Store column layout (verified 2026-07-29):
//   BU · Region · Market · Store · Total Clearance Deleted Units ·
//   Total Clearance Deleted $ · Clearance Quantity · Clearance $ ·
//   Deleted Quantity · Deleted $
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
 * @property {number} totalUnits
 * @property {number} totalDollars
 * @property {number} clearanceQty
 * @property {number} clearanceDollars
 * @property {number} deletedQty
 * @property {number} deletedDollars
 */
export function parseStoresCsv(text, opts = {}) {
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
    bu:      col("BU"),
    region:  col("Region"),
    market:  col("Market"),
    store:   col("Store"),
    units:   col("Total Clearance Deleted Units"),
    dollars: col("Total Clearance Deleted $"),
    clrQty:  col("Clearance Quantity"),
    clrDol:  col("Clearance $"),
    delQty:  col("Deleted Quantity"),
    delDol:  col("Deleted $"),
  };

  // Guard against a wrong sheet (e.g. CD Category) being handed in.
  if (idx.store < 0 || idx.market < 0 || idx.dollars < 0) {
    return {
      ok: false,
      rows: [],
      reason: `unexpected columns (need Store/Market/Total Clearance Deleted $); got: ${headers.join(", ")}`,
    };
  }

  const wantMarket = opts.market != null ? String(opts.market).trim() : null;
  const rows = [];

  for (const line of lines.slice(1)) {
    const c = line.split("\t");
    const store = (c[idx.store] ?? "").trim();
    // Skip the grand "Total" summary row and any blank store cell.
    if (!store || store.toLowerCase() === "total") continue;

    const market = (c[idx.market] ?? "").trim();
    if (wantMarket != null && market !== wantMarket) continue;

    rows.push({
      bu:               (c[idx.bu] ?? "").trim(),
      region:           (c[idx.region] ?? "").trim(),
      market,
      store,
      totalUnits:       num(c[idx.units]),
      totalDollars:     num(c[idx.dollars]),
      clearanceQty:     num(c[idx.clrQty]),
      clearanceDollars: num(c[idx.clrDol]),
      deletedQty:       num(c[idx.delQty]),
      deletedDollars:   num(c[idx.delDol]),
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
 * Extract the national grand-"Total" row from the same CD Store crosstab.
 * Tableau emits a single summary row with BU/Region/Market/Store all set to
 * "Total"; it carries the all-markets rollup we use for national context.
 *
 * @param {string} text
 * @returns {{ok:boolean, national?:object, reason?:string}}
 */
export function parseNationalTotal(text) {
  if (!text || typeof text !== "string") return { ok: false, reason: "empty CSV body" };
  const clean = text.replace(/^\uFEFF/, "");
  const lines = clean.split(/\r?\n/).filter((l) => l.length);
  if (lines.length < 2) return { ok: false, reason: "no data rows" };

  const headers = lines[0].split("\t").map((h) => h.trim());
  const col = (name) => headers.indexOf(name);
  const idx = {
    store:   col("Store"),
    units:   col("Total Clearance Deleted Units"),
    dollars: col("Total Clearance Deleted $"),
    clrQty:  col("Clearance Quantity"),
    clrDol:  col("Clearance $"),
    delQty:  col("Deleted Quantity"),
    delDol:  col("Deleted $"),
  };
  if (idx.store < 0 || idx.dollars < 0) return { ok: false, reason: "unexpected columns" };

  for (const line of lines.slice(1)) {
    const c = line.split("\t");
    if ((c[idx.store] ?? "").trim().toLowerCase() !== "total") continue;
    return {
      ok: true,
      national: {
        totalUnits:       num(c[idx.units]),
        totalDollars:     num(c[idx.dollars]),
        clearanceQty:     num(c[idx.clrQty]),
        clearanceDollars: num(c[idx.clrDol]),
        deletedQty:       num(c[idx.delQty]),
        deletedDollars:   num(c[idx.delDol]),
      },
    };
  }
  return { ok: false, reason: "no Total row found" };
}

// Parse a Tableau numeric cell: strips $ , whitespace; supports "(x)"
// accounting-negative notation. Returns 0 for unparseable/empty.
function num(s) {
  if (s == null) return 0;
  let str = String(s).trim();
  const negParen = /^\(.*\)$/.test(str);
  str = str.replace(/[()$,\s]/g, "");
  const n = Number(str);
  if (!Number.isFinite(n)) return 0;
  return negParen ? -Math.abs(n) : n;
}
