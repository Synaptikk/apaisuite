import puppeteer from "puppeteer-core";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const page = await browser.newPage();
await page.goto("https://hoops.wal-mart.com/ops-portal/analysis/inventory/fresh-inventory-tracker?bu=1458&buType=6&timeType=100", { waitUntil: "domcontentloaded", timeout: 120000 });
await new Promise(r => setTimeout(r, 6000));

const out = await page.evaluate(async () => {
  const call = async (input) => {
    const url = "/ops-portal/v1/trpc/analysis.fresh.freshInventoryTracker?input=" + encodeURIComponent(JSON.stringify({ json: input }));
    const r = await fetch(url, { credentials: "include" });
    const j = await r.json();
    return j?.result?.data?.json ?? { error: JSON.stringify(j).slice(0, 300) };
  };
  const all = await call({ buId: 1458, buType: 6, timeType: 100, deptNumber: [-9999] });
  const d93 = await call({ buId: 1458, buType: 6, timeType: 100, deptNumber: [93] });
  const pick = (res) => ({
    columns: res.meta?.columns,
    rowCount: res.rows?.length,
    firstRow: res.rows?.[0],
    lastRow: res.rows?.[res.rows.length - 1],
  });
  return { all: pick(all), d93: pick(d93) };
});
console.log(JSON.stringify(out, null, 1).slice(0, 6000));
await page.close(); await browser.disconnect();
