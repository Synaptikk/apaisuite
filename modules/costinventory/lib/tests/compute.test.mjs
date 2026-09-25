import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWorksheet, buildTrailerPanel } from "../compute.js";

// Real figures from store 1458, night of 2026-09-21 / window 2026-08-25..09-22.
const LOADS = [
  { type: "MP",  trailer: "322594", actual: "2026-09-21 19:50", scheduled: "2026-09-21 23:21" },
  { type: "FDD", trailer: "309178", actual: "2026-09-21 17:48", scheduled: "2026-09-21 23:44" },
];

const COST_ROWS = [
  { invoiceDate: "2026-09-21", trailer: "322594", dept: 93, cost: 13677.29 },
  { invoiceDate: "2026-09-21", trailer: "322594", dept: 80, cost: 526.26 },
  { invoiceDate: "2026-09-21", trailer: "322594", dept: 94, cost: 9259.14 },
  { invoiceDate: "2026-09-20", trailer: "309178", dept: 93, cost: 1677.35 },
  { invoiceDate: "2026-09-20", trailer: "309178", dept: 80, cost: 656.85 },
  { invoiceDate: "2026-09-20", trailer: "309178", dept: 94, cost: 55.68 },
  { invoiceDate: "2026-09-20", trailer: "309178", dept: 98, cost: 1164.65 },
];

test("trailer panel subtotals by shipment type and department", () => {
  const panel = buildTrailerPanel(LOADS, COST_ROWS);

  assert.equal(panel.trailers.length, 2);
  assert.equal(panel.total, 27017.22);

  const mp = panel.byType.find((t) => t.type === "MP");
  const fdd = panel.byType.find((t) => t.type === "FDD");
  assert.equal(mp.total, 23462.69);
  assert.equal(fdd.total, 3554.53);

  // Row 8 of the worksheet is the per-department total across both trailers.
  assert.equal(panel.byDept[93], 15354.64);
  assert.equal(panel.byDept[98], 1164.65);
});

test("a trailer invoiced on a different date than it arrived is still counted", () => {
  const panel = buildTrailerPanel(LOADS, COST_ROWS);
  const fdd = panel.trailers.find((t) => t.trailer === "309178");
  assert.deepEqual(fdd.invoiceDates, ["2026-09-20"]);   // arrived on the 21st
  assert.equal(fdd.arrived, "2026-09-21 17:48");
});

test("unlabelled trailers are dropped, not totalled", () => {
  const rows = [...COST_ROWS, { invoiceDate: "2026-09-21", trailer: "175057", dept: 94, cost: 49.2 }];
  const panel = buildTrailerPanel(LOADS, rows);
  assert.equal(panel.trailers.length, 2);
  assert.equal(panel.total, 27017.22);
});

test("a CV trailer with no invoice yet is reported, not silently zero", () => {
  const loads = [...LOADS, { type: "FDD", trailer: "318607", actual: null }];
  const panel = buildTrailerPanel(loads, COST_ROWS);
  assert.deepEqual(panel.missingInvoices, [{ trailer: "318607", type: "FDD", arrived: null }]);
});

test("worksheet math matches the sheet's own formulas", () => {
  const ws = buildWorksheet({
    counted:            { 93: 70000, 80: 15000, 94: 38000, 98: 27000 },
    beginningInventory: { 93: 71320.61, 80: 14929.09, 94: 38781.29, 98: 27599.94 },
    itrByDept: {
      93: { purchasesCost: 388001.77, salesRetail: 478479.34 },
      80: { purchasesCost: 50000, salesRetail: 70000 },
      94: { purchasesCost: 120000, salesRetail: 160000 },
      98: { purchasesCost: 40000, salesRetail: 60000 },
    },
  });

  const meat = ws.columns.find((c) => c.dept === 93);
  assert.equal(meat.ending, 70000);                          // the count alone
  assert.equal(meat.cogs, 389322.38);                        // begin + purchases - ending
  assert.equal(meat.grossProfit, 89156.96);                  // sales - COGS
  assert.equal(meat.grossProfitPct, 0.1863);

  // Column E is division 24 only (Meat + Deli), not every department.
  assert.equal(ws.division24Total.ending, 85000);
  assert.equal(ws.division24Total.sales, 548479.34);
});

test("rows 8, 9 and 10 are always zero — freight is reported, never added", () => {
  const ws = buildWorksheet({
    counted: { 93: 70000 },
    beginningInventory: { 93: 71320.61 },
    itrByDept: { 93: { purchasesCost: 1000, salesRetail: 2000 } },
    // Even when a caller passes freight, it must not reach the sheet.
    truckByDept: { 93: 15354.64 },
  });
  const meat = ws.columns.find((c) => c.dept === 93);
  assert.equal(meat.truck, 0);
  assert.equal(meat.claims, 0);
  assert.equal(meat.fuel, 0);
  assert.equal(meat.ending, 70000);
});

test("a department with no count typed in is flagged rather than assumed zero", () => {
  const ws = buildWorksheet({ counted: { 93: 100 }, beginningInventory: {}, itrByDept: {}, truckByDept: {} });
  assert.equal(ws.columns.find((c) => c.dept === 93).hasCount, true);
  assert.equal(ws.columns.find((c) => c.dept === 80).hasCount, false);
});
