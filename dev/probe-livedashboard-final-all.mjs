// dev/probe-livedashboard-final-all.mjs
//
// Integration test for: bootstrap on initial load (all 5 sources auto-pull),
// compliance row clickability, accident endpoint working, hourly absences
// (period verified by inspecting alarm).

import puppeteer from "puppeteer-core";

const BROWSER_URL = "http://localhost:9222";
const EXT_NAME    = "APAISuite";

const browser = await puppeteer.connect({ browserURL: BROWSER_URL, defaultViewport: null });

const extPage = await browser.newPage();
await extPage.goto("edge://extensions/", { waitUntil: "domcontentloaded", timeout: 10000 });
const all = await extPage.evaluate(async () => {
  return await new Promise((resolve) => {
    chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true }, (info) => resolve(info));
  });
});
const info = all.find((x) => x.name === EXT_NAME);
const extensionId = info.id;
console.log(`✓ ${EXT_NAME} v${info.version} (${extensionId})`);

// Wipe livedashboard caches + freshness so bootstrap has to fire fresh
console.log(`\n→ clearing livedashboard caches to simulate fresh install…`);
await extPage.evaluate(async (id) => {
  // We can't reach into the extension's storage from chrome://extensions.
  // Instead reload the extension below which keeps storage; we'll just
  // observe whether bootstrap re-fires when current data is < threshold.
}, extensionId);

// Reload extension
console.log(`→ reloading extension…`);
await extPage.evaluate(async (id) => {
  await new Promise((resolve) => chrome.developerPrivate.reload(id, {}, resolve));
}, extensionId);
await extPage.close().catch(() => {});
await new Promise((r) => setTimeout(r, 2000));

// Open app, force-clear caches via SW so bootstrap fires
const appPage = await browser.newPage();
await appPage.setViewport({ width: 1700, height: 1050 });
appPage.on("pageerror", (err) => console.error("  PAGE ERROR:", err.message));

await appPage.goto(`chrome-extension://${extensionId}/app.html#/home`, { waitUntil: "domcontentloaded", timeout: 15000 });
await new Promise((r) => setTimeout(r, 1500));

// Wipe caches
console.log(`→ wiping livedashboard caches via SW…`);
await appPage.evaluate(async () => {
  const all = await chrome.storage.local.get(null);
  const toRemove = Object.keys(all).filter((k) => k.startsWith("livedashboard."));
  if (toRemove.length) await chrome.storage.local.remove(toRemove);
  return toRemove.length;
});

// Reload the page so register() fires + bootstrap kicks off
console.log(`→ reloading app.html so register()+bootstrap re-fire…`);
await appPage.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
await new Promise((r) => setTimeout(r, 2500));

// Attach SW console
const swTarget = browser.targets().find((t) =>
  t.type() === "service_worker" && new URL(t.url()).hostname === extensionId
);
let cdp = null;
if (swTarget) {
  cdp = await swTarget.createCDPSession();
  await cdp.send("Runtime.enable");
  cdp.on("Runtime.consoleAPICalled", (msg) => {
    const text = (msg.args || []).map((a) => a.value ?? a.description ?? JSON.stringify(a)).join(" ");
    console.log(`  SW> [${msg.type}] ${text}`);
  });
}

// === Check: snapshot widget states immediately (should show "loading…") ===
console.log(`\n=== Snapshot 1: just after page load (in-flight) ===`);
const initial = await appPage.evaluate(() => {
  const r = {};
  for (const id of ["ld-w-absences","ld-w-compliance","ld-w-accident","ld-w-cvp","ld-w-register"]) {
    const el = document.querySelector("#"+id);
    if (!el) { r[id] = null; continue; }
    r[id] = {
      sev: el.dataset.sev,
      pill: el.querySelector(".ld-widget-pill")?.textContent.trim(),
      prim: el.querySelector(".ld-widget-primary")?.textContent.trim(),
      sec:  el.querySelector(".ld-widget-secondary")?.textContent.trim(),
    };
  }
  return r;
});
for (const [k, v] of Object.entries(initial)) {
  console.log(`  ${k.padEnd(16)} sev=${v.sev}  pill=${v.pill}  prim="${v.prim}"  sec="${v.sec}"`);
}
await appPage.screenshot({ path: "final-all-1-bootstrap-start.png", fullPage: false });

// Now wait for accident (fast) + compliance + cvp (medium) to complete.
// Register + absences are heavier; let's give 60s max.
console.log(`\n→ waiting 60s for bootstrap pulls to complete…`);
await new Promise((r) => setTimeout(r, 60_000));

// Get post-bootstrap state
const state = await appPage.evaluate(async () => {
  return await new Promise((resolve) => {
    chrome.runtime.sendMessage({ module: "livedashboard", type: "get_dashboard_state" }, resolve);
  });
});
const s = state?.data ?? state;
console.log(`\n=== Source statuses after bootstrap wait ===`);
for (const id of ["absences", "compliance", "accident", "cvp", "register"]) {
  const f = s?.freshness?.[id];
  const c = s?.sources?.[id]?.cache;
  const hasData = c && Object.keys(c).length > 0;
  console.log(`  ${id.padEnd(12)} success=${!!f?.lastSuccess} inFlight=${f?.inFlight} error=${f?.lastError ? f.lastError.slice(0,60) : "—"} hasData=${hasData}`);
}

// Accident widget specifically
const acc = s?.sources?.accident?.cache;
if (acc?.records) {
  console.log(`\n  Accident records (${acc.records.length}):`);
  for (const r of acc.records.slice(0, 5)) {
    console.log(`    ${r.reportType.padEnd(28)} ref=${r.referenceNbr.padEnd(10)} claimant=${r.claimant.padEnd(12)} open=${r.daysOpen}d score=${r.priorityScore} status=${r.evidenceStatus} missing=${r.missingItems.join(",")}`);
  }
}

// Compliance click test
console.log(`\n=== Compliance row clickability ===`);
await appPage.evaluate(() => document.querySelector("#ld-w-compliance")?.click());
await new Promise((r) => setTimeout(r, 600));
const clickableCount = await appPage.evaluate(() => document.querySelectorAll("tr.ld-row-clickable").length);
console.log(`  Clickable compliance rows in drill: ${clickableCount}`);
await appPage.screenshot({ path: "final-all-2-compliance-clickable.png", fullPage: false });

// Accident drill test
console.log(`\n=== Accident drill ===`);
await appPage.evaluate(() => document.querySelector("#ld-w-accident")?.click());
await new Promise((r) => setTimeout(r, 600));
const accDrill = await appPage.evaluate(() => {
  const title = document.querySelector("#ld-drill-title")?.textContent;
  const tables = document.querySelectorAll(".ld-drill-body .ld-table").length;
  const rows   = document.querySelectorAll(".ld-drill-body .ld-table tbody tr").length;
  return { title, tables, rows };
});
console.log(`  title="${accDrill.title}", tables=${accDrill.tables}, rows=${accDrill.rows}`);
await appPage.screenshot({ path: "final-all-3-accident-drill.png", fullPage: false });

// Alarm period check
console.log(`\n=== Alarm periods ===`);
const alarms = await appPage.evaluate(async () => {
  return await new Promise((resolve) => chrome.alarms.getAll(resolve));
});
for (const a of alarms.filter((x) => x.name.startsWith("livedashboard."))) {
  console.log(`  ${a.name.padEnd(28)} periodInMinutes=${a.periodInMinutes}`);
}

await cdp?.detach().catch(() => {});
browser.disconnect();
process.exit(0);
