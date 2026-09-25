// dev/costinv-export-test.mjs — type the Cost Inventory App counts into the
// module, then export, and prove the workbook that lands is real.
import puppeteer from "puppeteer-core";
import fs from "node:fs";

const EXT_ID = "fchnolphfaklbpdgnofhblfhcailkpdb";
const OUT = process.argv[2];
fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null, protocolTimeout: 120000 });
const page = await browser.newPage();

const errs = [];
page.on("pageerror", (e) => errs.push("pageerror: " + String(e)));
page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });

const cdp = await page.createCDPSession();
await cdp.send("Browser.setDownloadBehavior", {
  behavior: "allowAndName", downloadPath: OUT, eventsEnabled: true,
}).catch(async () => {
  await cdp.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: OUT });
});

await page.goto(`chrome-extension://${EXT_ID}/app.html#/costinventory`, { waitUntil: "domcontentloaded", timeout: 60000 });
await new Promise((r) => setTimeout(r, 4000));

const counts = { 93: 70123.45, 80: 15234.10, 94: 38900.00, 98: 27100.55 };
await page.evaluate((counts) => {
  for (const [dept, value] of Object.entries(counts)) {
    const input = document.querySelector(`[data-counted-dept="${dept}"]`);
    input.value = String(value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
}, counts);
await new Promise((r) => setTimeout(r, 800));

await page.click('[data-action="export"]');
await new Promise((r) => setTimeout(r, 5000));

const files = fs.readdirSync(OUT);
console.log("FILES IN DOWNLOAD DIR:", files.join(", ") || "(nothing)");
if (errs.length) console.log("ERRORS:\n" + errs.slice(0, 6).join("\n"));

// Independently of the browser download plumbing, prove the export pipeline
// itself runs inside the extension and produces the right bytes.
const direct = await page.evaluate(async (counts) => {
  try {
    const xlsx = await import(chrome.runtime.getURL("modules/costinventory/lib/xlsx.js"));
    const compute = await import(chrome.runtime.getURL("modules/costinventory/lib/compute.js"));
    const state = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ module: "costinventory", type: "get_state" }, resolve);
    });
    const snap = state.snapshot;
    const cols = snap.worksheet.columns;
    const ws = compute.buildWorksheet({
      counted: counts,
      beginningInventory: Object.fromEntries(cols.map((c) => [c.dept, c.beginning])),
      itrByDept: Object.fromEntries(cols.map((c) => [c.dept, { purchasesCost: c.purchases, salesRetail: c.sales }])),
      truckByDept: snap.trailerPanel?.byDept ?? {},
    });
    const cells = { C3: snap.storeNbr, E3: xlsx.excelDateSerial(snap.dates.windowEnd) };
    for (const col of ws.columns) {
      cells[col.column + "7"] = col.counted;
      cells[col.column + "8"] = col.truck;
      cells[col.column + "13"] = col.sales;
      cells[col.column + "14"] = col.beginning;
      cells[col.column + "15"] = col.purchases;
    }
    const tpl = await (await fetch(chrome.runtime.getURL("modules/costinventory/templates/worksheet.xlsx"))).arrayBuffer();
    const filled = await xlsx.fillWorkbook(tpl, cells);
    return { ok: true, bytes: filled.length, cells, b64: btoa(String.fromCharCode(...filled)) };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}, counts);

if (!direct.ok) {
  console.log("DIRECT EXPORT FAILED:", direct.error);
} else {
  console.log("DIRECT EXPORT OK:", direct.bytes, "bytes");
  console.log("CELLS WRITTEN:", JSON.stringify(direct.cells));
  fs.writeFileSync(OUT + "/direct-export.xlsx", Buffer.from(direct.b64, "base64"));
  console.log("saved", OUT + "/direct-export.xlsx");
}

await page.close();
await browser.disconnect();
