// dev/probe-digitallocks-e2e.mjs
// End-to-end test of the DAX capture-and-replay path:
//   1. Reload the extension (new content/capture.js + service.js + manifest take effect)
//   2. Find a Power BI tab; reload it so capture.js installs and fires
//   3. Send digitallocks.searchByStore from a shell page to the SW
//   4. Print row count + sample

import puppeteer from "puppeteer-core";

const STORE = (process.argv[2] || "1458").trim();
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });

const extPage = await browser.newPage();
await extPage.goto("chrome://extensions/", { waitUntil: "domcontentloaded" });
const exts = await extPage.evaluate(() =>
  new Promise((r) => chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true }, r))
);
const suite = exts.find((e) => e.name === "APAISuite");
if (!suite) { console.error("✗ APAISuite not installed"); browser.disconnect(); process.exit(1); }
console.log(`✓ APAISuite v${suite.version}  id=${suite.id}`);

console.log("→ reloading extension…");
await extPage.evaluate((id) => new Promise((r) => chrome.developerPrivate.reload(id, {}, r)), suite.id);
await new Promise(r => setTimeout(r, 2000));
await extPage.close();

let pages = await browser.pages();
let pbiPage = pages.find((p) => /app\.powerbi\.com\/groups\/me\/reports\/a118e7e7-/.test(p.url()));
if (!pbiPage) {
  console.error("✗ no Power BI tab open — open the digitallocks report manually first");
  browser.disconnect();
  process.exit(1);
}

console.log("→ reloading Power BI tab so capture.js injects on this run…");
await pbiPage.reload({ waitUntil: "domcontentloaded" });

// Wait for the data grid to render so the capture content script records the DAX query.
console.log("→ waiting 15s for the visual to fire its data-grid query…");
await new Promise(r => setTimeout(r, 15000));

// Verify capture exists
const capCheck = await pbiPage.evaluate(() => {
  const cap = window.__APAISUITE_DIGITALLOCKS_CAP;
  if (!cap) return { installed: false };
  const q = cap.findDataGridQuery();
  return { installed: true, found: !!q, ringSize: cap.all().length };
});
console.log(`  capture installed=${capCheck.installed}  data-grid query found=${capCheck.found}  ring=${capCheck.ringSize}`);
if (!capCheck.installed) {
  console.error("✗ MAIN-world capture script never installed. Check manifest content_scripts entry.");
  browser.disconnect();
  process.exit(1);
}
if (!capCheck.found) {
  console.error("⚠ capture installed but no data-grid query yet. Power BI may need longer or a manual refresh.");
}

// Open a shell page to act as message sender, then dispatch searchByStore to the SW.
console.log(`→ opening shell page and sending searchByStore(${STORE})…`);
const shellPage = await browser.newPage();
await shellPage.goto(`chrome-extension://${suite.id}/app.html#/digitallocks`, { waitUntil: "domcontentloaded" });
await new Promise(r => setTimeout(r, 1500));

const resp = await shellPage.evaluate(async (store) => {
  return await new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { module: "digitallocks", type: "searchByStore", storeNumber: store, waitMs: 30000 },
      (r) => resolve(r),
    );
  });
}, STORE);

console.log("\n========== SW RESPONSE ==========");
console.log(`ok:         ${resp?.ok}`);
console.log(`error:      ${resp?.error || "(none)"}`);
if (resp?.data) {
  console.log(`count:      ${resp.data.count}`);
  console.log(`storeNumber:${resp.data.storeNumber}`);
  console.log(`elapsed ms: ${resp.data.ms}`);
  console.log(`\n--- first 2 rows ---`);
  for (const r of (resp.data.rows || []).slice(0, 2)) console.log(JSON.stringify(r));
} else {
  console.log("data: (none)");
  console.log("Full response:", JSON.stringify(resp, null, 2));
}

await shellPage.close();
browser.disconnect();
process.exit(0);
