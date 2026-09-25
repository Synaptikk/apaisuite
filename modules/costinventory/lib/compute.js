// modules/costinventory/lib/compute.js
//
// The worksheet's arithmetic, kept pure so it can be tested without a browser.
//
// The sheet is four departments across three divisions. Three of its input
// rows are always zero now and are carried as zeros so the exported workbook's
// formulas stay intact:
//
//   row 8  Warehouse Truck Invoices  — last night's MP/FDD freight is NOT part
//                                      of the counted ending inventory. It is
//                                      reported on its own, as "Unfinalized
//                                      Trailer totals", and never added here.
//   row 9  Claims                    — the Cost Inventory App handles it
//   row 10 Fuel Station/Convenience  — no longer counted
//
// So ending inventory is the counted number alone, and the trailer panel is
// information the store reads beside the sheet rather than into it.

/** Worksheet column layout, left to right as the sheet prints. */
export const DEPARTMENTS = Object.freeze([
  { dept: 93, name: "Meat/Seafood", division: 24, divisionName: "Meat",    column: "C" },
  { dept: 80, name: "Deli",         division: 24, divisionName: "Meat",    column: "D" },
  { dept: 94, name: "Produce",      division: 25, divisionName: "Produce", column: "G" },
  { dept: 98, name: "Bakery",       division: 27, divisionName: "Bakery",  column: "J" },
]);

export const DEPT_NUMBERS = Object.freeze(DEPARTMENTS.map((d) => d.dept));

/**
 * Assemble one column per department.
 *
 * `counted` is the only figure a human types: the Cost Inventory App total,
 * read off a phone on the day. Everything else is pulled.
 */
export function buildWorksheet({ counted = {}, beginningInventory = {}, itrByDept = {} }) {
  const columns = DEPARTMENTS.map((d) => {
    const countedAmt = num(counted[d.dept]);
    const truck      = 0;   // always — see the note at the top of this file
    const claims     = 0;   // retired — handled in the Cost Inventory App
    const fuel       = 0;   // retired — Deli column only, no longer counted

    const ending    = round(countedAmt + truck + claims + fuel);
    const beginning = round(num(beginningInventory[d.dept]));
    const itr       = itrByDept[d.dept] ?? {};
    const purchases = round(num(itr.purchasesCost));
    const sales     = round(num(itr.salesRetail));

    const cogs = round(beginning + purchases - ending);
    const gp   = round(sales - cogs);

    return {
      ...d,
      counted: countedAmt,
      truck,
      claims,
      fuel,
      ending,
      beginning,
      purchases,
      sales,
      cogs,
      grossProfit: gp,
      grossProfitPct: sales ? round4(gp / sales) : 0,
      hasCount: counted[d.dept] !== undefined && counted[d.dept] !== null && counted[d.dept] !== "",
    };
  });

  // Column E on the sheet: division 24 only (Meat + Deli), not a grand total.
  const div24 = columns.filter((c) => c.division === 24);
  const division24Total = sumColumns(div24);

  return { columns, division24Total, allTotal: sumColumns(columns) };
}

function sumColumns(cols) {
  const t = cols.reduce((acc, c) => ({
    counted:   acc.counted   + c.counted,
    truck:     acc.truck     + c.truck,
    ending:    acc.ending    + c.ending,
    beginning: acc.beginning + c.beginning,
    purchases: acc.purchases + c.purchases,
    sales:     acc.sales     + c.sales,
    cogs:      acc.cogs      + c.cogs,
    grossProfit: acc.grossProfit + c.grossProfit,
  }), { counted: 0, truck: 0, ending: 0, beginning: 0, purchases: 0, sales: 0, cogs: 0, grossProfit: 0 });

  const rounded = Object.fromEntries(Object.entries(t).map(([k, v]) => [k, round(v)]));
  return { ...rounded, grossProfitPct: rounded.sales ? round4(rounded.grossProfit / rounded.sales) : 0 };
}

/**
 * "Unfinalized Trailer totals" — last night's fresh trailers, each broken down
 * by department, subtotalled by shipment type.
 *
 * Trailers CaseVisibility did not label MP or FDD are dropped entirely, by
 * design: the small fresh amounts that ride in on grocery trailers (DC
 * 6006/6095) are not what the store reconciles here.
 *
 * @param loads     from casevisibility.fetchFreshLoads — the MP/FDD labels
 * @param costRows  from gdp.fetchTrailerCosts — the money
 */
export function buildTrailerPanel(loads = [], costRows = []) {
  const typeOf = new Map(loads.map((l) => [String(l.trailer), l.type]));
  const metaOf = new Map(loads.map((l) => [String(l.trailer), l]));

  const byTrailer = new Map();
  for (const row of costRows) {
    const trailer = String(row.trailer);
    const type = typeOf.get(trailer);
    if (!type) continue;                       // unlabelled trailer — not ours

    let entry = byTrailer.get(trailer);
    if (!entry) {
      const meta = metaOf.get(trailer) ?? {};
      entry = {
        trailer,
        type,
        arrived:   meta.actual ?? null,
        scheduled: meta.scheduled ?? null,
        invoiceDates: [],
        byDept: Object.fromEntries(DEPT_NUMBERS.map((d) => [d, 0])),
        total: 0,
      };
      byTrailer.set(trailer, entry);
    }

    if (row.invoiceDate && !entry.invoiceDates.includes(row.invoiceDate)) {
      entry.invoiceDates.push(row.invoiceDate);
    }
    if (entry.byDept[row.dept] === undefined) entry.byDept[row.dept] = 0;
    entry.byDept[row.dept] += row.cost;
    entry.total += row.cost;
  }

  const trailers = [...byTrailer.values()]
    .map((t) => ({
      ...t,
      invoiceDates: t.invoiceDates.sort(),
      byDept: Object.fromEntries(Object.entries(t.byDept).map(([k, v]) => [k, round(v)])),
      total: round(t.total),
    }))
    .sort((a, b) => a.type.localeCompare(b.type) || a.trailer.localeCompare(b.trailer));

  // Subtotal per shipment type, in the order the store says them: MP, then FDD.
  const typeOrder = ["MP", "MPDD", "FDD"];
  const byType = typeOrder
    .map((type) => {
      const members = trailers.filter((t) => t.type === type);
      if (!members.length) return null;
      return {
        type,
        trailers: members.map((m) => m.trailer),
        byDept: sumByDept(members),
        total: round(members.reduce((s, m) => s + m.total, 0)),
      };
    })
    .filter(Boolean);

  // Trailers CV listed but GDP has no invoice for yet — usually a load that
  // arrived after its invoice was cut, and the reason a department can read
  // $0.00 on a night it clearly received freight.
  const missing = loads
    .filter((l) => !byTrailer.has(String(l.trailer)))
    .map((l) => ({ trailer: String(l.trailer), type: l.type, arrived: l.actual ?? null }));

  return {
    trailers,
    byType,
    byDept: sumByDept(trailers),
    total: round(trailers.reduce((s, t) => s + t.total, 0)),
    missingInvoices: missing,
  };
}

function sumByDept(entries) {
  const out = Object.fromEntries(DEPT_NUMBERS.map((d) => [d, 0]));
  for (const e of entries) {
    for (const [dept, amt] of Object.entries(e.byDept)) {
      out[dept] = round((out[dept] ?? 0) + amt);
    }
  }
  return out;
}

function num(v) {
  const n = Number(String(v ?? "").toString().replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function round(n)  { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }
