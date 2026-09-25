// modules/costinventory/lib/itr.js
//
// Sales (row 13) and Purchases (row 15) from the Ops Portal Fresh Inventory
// Tracker. The portal is a React app, but every figure it draws comes from one
// tRPC endpoint that answers plain cookie-authenticated GETs, so nothing here
// drives a tab.
//
// Row 13 is labelled "Sales (Retail)" and that is what it wants:
// `salesAmt_Ty454`, not `salesCostAmt_Ty454`. COGS on the worksheet is built
// from cost figures (beginning inventory + purchases - the count), so only
// retail sales make `Sales - COGS` a gross profit rather than roughly zero.

const TRPC = "https://hoops.wal-mart.com/ops-portal/v1/trpc/analysis.fresh.freshInventoryTracker";

const BU_TYPE_STORE = 6;
const TIME_TYPE_DAY = 100;

export class ItrError extends Error {}

/** Daily rows for one department, oldest first. */
export async function fetchDeptDays(storeNbr, deptNbr) {
  const input = encodeURIComponent(JSON.stringify({
    json: {
      buId: Number(storeNbr),
      buType: BU_TYPE_STORE,
      timeType: TIME_TYPE_DAY,
      deptNumber: [Number(deptNbr)],
    },
  }));

  const res = await fetch(TRPC + "?input=" + input, { credentials: "include" });
  if (!res.ok) {
    throw new ItrError("ITR " + res.status + " for dept " + deptNbr + " (SSO expired? open hoops.wal-mart.com)");
  }

  const payload = (await res.json())?.result?.data?.json;
  const columns = payload?.meta?.columns;
  const rows = payload?.rows;
  if (!Array.isArray(columns) || !Array.isArray(rows)) {
    throw new ItrError("ITR returned no grid for dept " + deptNbr);
  }

  // Array-mode rows: the column list is the only key to them.
  const idx = Object.fromEntries(columns.map((c, i) => [c, i]));
  return rows
    .map((r) => ({
      date:            r[idx.timeText],
      purchasesCost:   num(r[idx.purchasesCostAmt_Ty454]),
      purchasesRetail: num(r[idx.purchasesAmt_Ty454]),
      salesCost:       num(r[idx.salesCostAmt_Ty454]),
      salesRetail:     num(r[idx.salesAmt_Ty454]),
      inventory:       num(r[idx.inventoryAmt_Ty454]),
    }))
    .filter((r) => r.date)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * Sum one department over the inventory window, inclusive of both ends.
 *
 * The ITR publishes through YESTERDAY, so a window ending today is always one
 * day short. `coverage.missingTail` reports that instead of hiding it, because
 * the store is reconciling to the dollar and deserves to know the last day is
 * not in yet.
 */
export function sumWindow(days, start, end) {
  const inWindow = days.filter((d) => d.date >= start && d.date <= end);

  const totals = inWindow.reduce((acc, d) => ({
    purchasesCost:   acc.purchasesCost   + d.purchasesCost,
    purchasesRetail: acc.purchasesRetail + d.purchasesRetail,
    salesCost:       acc.salesCost       + d.salesCost,
    salesRetail:     acc.salesRetail     + d.salesRetail,
  }), { purchasesCost: 0, purchasesRetail: 0, salesCost: 0, salesRetail: 0 });

  const last = inWindow[inWindow.length - 1];
  return {
    ...round(totals),
    coverage: {
      days:        inWindow.length,
      firstDate:   inWindow[0]?.date ?? null,
      lastDate:    last?.date ?? null,
      missingTail: last ? daysBetween(last.date, end) : null,
    },
  };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round(o) {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v * 100) / 100]));
}

function daysBetween(a, b) {
  return Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 86400000);
}
