// node modules/boblisa/lib/tests/nearest_sales.test.mjs
//
// pairs.js::nearestSales — the register-day sales around a typed time.
import assert from "node:assert/strict";
import { nearestSales } from "../pairs.js";

const sale = (t, op, tr, extra = {}) => ({ t, time: `t${t}`, reg: 17, op, tr, items: [{ cents: 100 }], total: 100, tender: "CASH", isSale: true, isTraining: false, ...extra });
const tx = [
  sale(36000 - 4000, "1", "1"),            // outside 30 min
  sale(36000 - 300, "2920", "10"),
  sale(36000 - 60, "2920", "11"),
  sale(36000 - 30, "9052", "12", { isTraining: true }),   // training: never a candidate
  sale(36000 - 20, "2920", "13", { isSale: false }),      // void / no-sale
  sale(36000 + 45, "5638", "14"),
  sale(36000 + 900, "5638", "15"),
];
const got = nearestSales(tx, 36000);
assert.deepEqual(got.map((x) => x.tr), ["14", "11", "10", "15"], "nearest first, before and after, sales only, inside 30 min");
assert.equal(got[0].deltaSec, 45); assert.equal(got[1].deltaSec, -60);
assert.equal(got[0].items, 1, "item count, not the item list");
assert.deepEqual(nearestSales(tx, 36000, { each: 1 }).map((x) => x.tr), ["14", "11"]);
assert.deepEqual(nearestSales([], 36000), []);
console.log("nearest_sales: ok");
