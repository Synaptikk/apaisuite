// dev/register-desc-probe.mjs — what does each source say about register TYPES? Dumps distinct
// register → Register_Desc from the cached Cash Recycler till log, plus every register the Power BI
// grid / CFT / WorkView caches know, from the debug-Edge extension storage. Usage: node dev/register-desc-probe.mjs
import puppeteer from "puppeteer-core";
const EXT = "fchnolphfaklbpdgnofhblfhcailkpdb";
const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222", protocolTimeout: 120000 });
const page = await browser.newPage();
await page.goto(`chrome-extension://${EXT}/app.html`, { waitUntil: "domcontentloaded" });
const out = await page.evaluate(() => new Promise((res) => chrome.storage.local.get(["registerls.tills", "registerls.grid", "registerls.cft", "registerls.queue"], (o) => {
  const tills = o["registerls.tills"] || {}; const rows = tills.rows || [];
  const byReg = {};
  for (const r of rows) { const k = r.register ?? r.registerNbr ?? "?"; (byReg[k] ||= {}); const d = r.registerDesc || "(blank)"; byReg[k][d] = (byReg[k][d] || 0) + 1; }
  const sampleKeys = rows[0] ? Object.keys(rows[0]) : [];
  const grid = o["registerls.grid"] || {}; const cells = grid.cells || grid.rows || grid.discrepancies || [];
  const gridRegs = [...new Set(cells.map((c) => String(c.registerNbr ?? c.register ?? "?")))].sort((a, b) => a - b);
  const gridKeys = cells[0] ? Object.keys(cells[0]) : [];
  const shifts = grid.shifts || grid.operatorShifts || []; const shiftKeys = shifts[0] ? Object.keys(shifts[0]) : [];
  const cft = o["registerls.cft"] || {}; const cftKeys = (cft.rows || [])[0] ? Object.keys(cft.rows[0]) : [];
  const cftDesc = [...new Set((cft.rows || []).map((r) => r.registerDesc || r.location || r.desc || "").filter(Boolean))].slice(0, 40);
  const q = o["registerls.queue"] || {}; const it = (q.items || [])[0]; const qKeys = it ? Object.keys(it) : [];
  res({ tillStore: tills.storeNbr, tillRows: rows.length, sampleKeys, byReg, gridKeys: Object.keys(grid), cellKeys: gridKeys, gridRegs, shiftKeys, cftKeys, cftDesc, qKeys });
})));
await page.close(); browser.disconnect();
console.log(JSON.stringify(out, null, 1));
