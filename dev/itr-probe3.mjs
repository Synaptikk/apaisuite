import puppeteer from "puppeteer-core";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const page = await browser.newPage();
await page.goto("https://hoops.wal-mart.com/ops-portal/analysis/inventory/fresh-inventory-tracker?bu=1458&buType=6&timeType=100", { waitUntil: "domcontentloaded", timeout: 120000 });
await new Promise(r => setTimeout(r, 5000));
const out = await page.evaluate(async () => {
  const call = async (input) => {
    const url = "/ops-portal/v1/trpc/analysis.fresh.freshInventoryTracker?input=" + encodeURIComponent(JSON.stringify({ json: input }));
    const j = await (await fetch(url, { credentials: "include" })).json();
    return j?.result?.data?.json;
  };
  const res = await call({ buId: 1458, buType: 6, timeType: 100, deptNumber: [93] });
  const cols = res.meta.columns;
  const keep = cols.filter(c => /^(timeText|timeInt|timeOffset|purchasesCostAmt_Ty454|purchasesAmt_Ty454|salesCostAmt_Ty454|salesAmt_Ty454|inventoryAmt_Ty454)$/.test(c));
  const idx = keep.map(k => cols.indexOf(k));
  const rows = res.rows.map(r => Object.fromEntries(keep.map((k, i) => [k, r[idx[i]]])));
  rows.sort((a,b) => a.timeText < b.timeText ? -1 : 1);
  // sum Aug 25 .. today for the 93 dept
  const win = rows.filter(r => r.timeText >= "2026-08-25");
  const sum = (k) => +win.reduce((s, r) => s + (r[k] || 0), 0).toFixed(2);
  return {
    allColumns: cols,
    dateSpan: [rows[0]?.timeText, rows[rows.length-1]?.timeText, rows.length],
    windowRows: win.length,
    sums93: { purchasesCost: sum("purchasesCostAmt_Ty454"), purchasesRetail: sum("purchasesAmt_Ty454"),
              salesCost: sum("salesCostAmt_Ty454"), salesRetail: sum("salesAmt_Ty454") },
    lastRows: rows.slice(-4),
    inventoryLatest: rows[rows.length-1]?.inventoryAmt_Ty454,
  };
});
console.log(JSON.stringify(out, null, 1).slice(0, 4500));
await page.close(); await browser.disconnect();
