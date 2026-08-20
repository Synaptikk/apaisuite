// modules/market120/lib/breakdown.js
//
// Pure aggregation layer for the Market 120 Clearance/Deleted breakdown.
// Turns the raw per-store rows (from parseStoresCsv) + the national Total row
// (from parseNationalTotal) into the same slice the flat HTML report computes:
// market rollup, national context %, clearance/deleted split, top stores, and
// executive insight sentences.
//
// Pure functions only — no chrome, no DOM, no network. This is the single
// source of truth shared by the module UI and the unit tests (DRY).

/**
 * @typedef {import("./parse_stores_csv.js").StoreRow} StoreRow
 *
 * @param {StoreRow[]} rows          Per-store rows for the market.
 * @param {object|null} national     National Total row (parseNationalTotal.national) or null.
 * @param {object} [opts]
 * @param {string} [opts.market="120"]
 * @param {number} [opts.topN=10]
 * @returns {object} breakdown
 */
export function computeBreakdown(rows, national = null, opts = {}) {
  const market = opts.market != null ? String(opts.market) : "120";
  const topN = opts.topN ?? 10;

  const m = rows.reduce(
    (a, r) => {
      a.units += n(r.totalUnits);
      a.dollars += n(r.totalDollars);
      a.clrQty += n(r.clearanceQty);
      a.clrDol += n(r.clearanceDollars);
      a.delQty += n(r.deletedQty);
      a.delDol += n(r.deletedDollars);
      return a;
    },
    { units: 0, dollars: 0, clrQty: 0, clrDol: 0, delQty: 0, delDol: 0 }
  );
  m.storeCount = rows.length;

  // National context (guard against a missing Total row).
  const nat = national
    ? {
        units: n(national.totalUnits),
        dollars: n(national.totalDollars),
        clrDol: n(national.clearanceDollars),
        delDol: n(national.deletedDollars),
      }
    : null;

  const pctUnits = nat && nat.units ? (m.units / nat.units) * 100 : null;
  const pctDollars = nat && nat.dollars ? (m.dollars / nat.dollars) * 100 : null;
  const delShareDol = m.dollars ? (m.delDol / m.dollars) * 100 : 0;
  const clrShareDol = m.dollars ? (m.clrDol / m.dollars) * 100 : 0;

  const topStores = [...rows]
    .map((r) => ({
      store: r.store,
      region: r.region,
      bu: r.bu,
      dollars: n(r.totalDollars),
      units: n(r.totalUnits),
      delDol: n(r.deletedDollars),
      clrDol: n(r.clearanceDollars),
    }))
    .sort((a, b) => b.dollars - a.dollars)
    .slice(0, topN);

  const top3Dollars = topStores.slice(0, 3).reduce((s, x) => s + x.dollars, 0);

  const insights = buildInsights({ market, m, nat, pctDollars, delShareDol, topStores, top3Dollars });

  return {
    market,
    market120: m,
    national: nat,
    pctUnits,
    pctDollars,
    delShareDol,
    clrShareDol,
    topStores,
    top3Dollars,
    insights,
  };
}

function buildInsights({ market, m, nat, pctDollars, delShareDol, topStores, top3Dollars }) {
  const out = [];
  if (nat && pctDollars != null) {
    out.push(
      `Market ${market} carries <b>${money(m.dollars)}</b> in Clearance+Deleted value across ` +
        `<b>${int(m.storeCount)}</b> stores — <b>${pctDollars.toFixed(1)}%</b> of the national <b>${money(nat.dollars)}</b>.`
    );
  } else {
    out.push(
      `Market ${market} carries <b>${money(m.dollars)}</b> in Clearance+Deleted value across ` +
        `<b>${int(m.storeCount)}</b> stores.`
    );
  }
  out.push(
    `Deleted inventory drives <b>${delShareDol.toFixed(0)}%</b> of Market ${market}'s Clearance+Deleted dollars ` +
      `(${money(m.delDol)} of ${money(m.dollars)}) — the bigger lever vs. clearance markdowns.`
  );
  if (topStores[0]) {
    out.push(
      `Top store <b>#${topStores[0].store}</b> alone accounts for <b>${money(topStores[0].dollars)}</b>; ` +
        `the top 3 stores represent <b>${money(top3Dollars)}</b>.`
    );
  }
  return out;
}

// ── formatting (shared vocabulary with the flat report) ──────────────
export function money(v) {
  return "$" + Math.round(n(v)).toLocaleString("en-US");
}
export function int(v) {
  return Math.round(n(v)).toLocaleString("en-US");
}
function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}
