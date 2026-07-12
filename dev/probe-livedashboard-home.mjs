// dev/probe-livedashboard-home.mjs
//
// Live test: reload APAISuite, navigate to #/home, verify the Live
// Dashboard renders as a strip ABOVE the module-card grid (not in
// sidebar). Click each drill-down (Callouts, CVP), screenshot.

import puppeteer from "puppeteer-core";

const BROWSER_URL = "http://localhost:9222";
const EXT_NAME    = "APAISuite";

const browser = await puppeteer.connect({ browserURL: BROWSER_URL, defaultViewport: null });

// Find extension ID
const extPage = await browser.newPage();
await extPage.goto("edge://extensions/", { waitUntil: "domcontentloaded", timeout: 10000 });
const all = await extPage.evaluate(async () => {
  return await new Promise((resolve) => {
    chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true }, (info) => resolve(info));
  });
});
const info = all.find((x) => x.name === EXT_NAME);
if (!info) { console.error("APAISuite not installed"); process.exit(1); }
const extensionId = info.id;
console.log(`✓ ${EXT_NAME} v${info.version} (${extensionId})`);

// Reload extension
await extPage.evaluate(async (id) => {
  await new Promise((resolve) => chrome.developerPrivate.reload(id, {}, resolve));
}, extensionId);
await extPage.close().catch(() => {});
await new Promise((r) => setTimeout(r, 1800));

// Open home
const appPage = await browser.newPage();
await appPage.setViewport({ width: 1600, height: 1000 });
appPage.on("pageerror", (err) => console.error("  PAGE ERROR:", err.message));
appPage.on("console", (msg) => {
  if (msg.type() === "error") console.error("  PAGE error:", msg.text());
});

await appPage.goto(`chrome-extension://${extensionId}/app.html#/home`, { waitUntil: "domcontentloaded", timeout: 15000 });
await new Promise((r) => setTimeout(r, 2000));

// Verify sidebar does NOT contain Live Dashboard
const sidebarLabels = await appPage.evaluate(() =>
  Array.from(document.querySelectorAll("a.shell-nav-item span")).map((s) => s.textContent.trim()).filter(Boolean)
);
console.log(`  sidebar items: ${JSON.stringify(sidebarLabels)}`);
const sidebarHasLive = sidebarLabels.includes("Live Dashboard");
console.log(`  sidebar has "Live Dashboard": ${sidebarHasLive ? "✗ STILL THERE" : "✓ removed"}`);

// Verify dashboard strip is mounted on home
const stripPresent = await appPage.evaluate(() => !!document.querySelector(".module-livedashboard .ld-root"));
console.log(`  dashboard strip on home: ${stripPresent ? "✓ rendered" : "✗ MISSING"}`);

// Verify it's ABOVE the module cards
const stripBeforeCards = await appPage.evaluate(() => {
  const strip = document.querySelector(".module-livedashboard");
  const grid  = document.querySelector(".grid.grid-cards");
  if (!strip || !grid) return null;
  return strip.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING ? true : false;
});
console.log(`  strip BEFORE module cards: ${stripBeforeCards === true ? "✓ correct" : `✗ ${stripBeforeCards}`}`);

await new Promise((r) => setTimeout(r, 1000));
await appPage.screenshot({ path: "livedashboard-home-1.png", fullPage: false }).catch(() => {});
console.log(`  📸 livedashboard-home-1.png`);

// Trigger a refresh to populate breakdown
console.log(`→ triggering pull_cvp to populate breakdown…`);
const cvpResult = await appPage.evaluate(async () => {
  return await new Promise((resolve) => {
    chrome.runtime.sendMessage({ module: "livedashboard", type: "pull_cvp" }, resolve);
  });
});
const cvpOk = cvpResult?.ok && cvpResult?.data?.ok;
console.log(`  pull_cvp: ${cvpOk ? "ok" : "fail"}`);
if (cvpOk) {
  const byCat = cvpResult.data.byCategory;
  for (const id of ["headline","fresh","food","gm"]) {
    const c = byCat[id];
    if (c?.ok) console.log(`    ${id}: ${c.currentWeek.sellThruPctTy?.toFixed?.(1) ?? "?"}%  units=${c.currentWeek.cvpTotalQtyTy}`);
    else       console.log(`    ${id}: ERROR — ${c?.error}`);
  }
}

await new Promise((r) => setTimeout(r, 1500));

// Click CVP widget to open drill-down
console.log(`→ clicking CVP widget…`);
await appPage.evaluate(() => document.querySelector("#ld-w-cvp").click());
await new Promise((r) => setTimeout(r, 1000));
const drillCvp = await appPage.evaluate(() => {
  const drill = document.querySelector("#ld-drill");
  return {
    visible: !drill?.hidden,
    title: document.querySelector("#ld-drill-title")?.textContent,
    rows:  Array.from(document.querySelectorAll(".ld-cvp-row")).map((r) => ({
      label: r.querySelector(".ld-cvp-label")?.textContent?.trim(),
      pct:   r.querySelector(".ld-cvp-pct")?.textContent?.trim(),
      meta:  r.querySelector(".ld-cvp-meta")?.textContent?.trim(),
    })),
  };
});
console.log(`  CVP drill visible: ${drillCvp.visible}, title="${drillCvp.title}"`);
for (const r of drillCvp.rows) console.log(`    ${r.label}: ${r.pct}  ${r.meta}`);
await appPage.screenshot({ path: "livedashboard-home-2-cvp-drill.png", fullPage: false }).catch(() => {});
console.log(`  📸 livedashboard-home-2-cvp-drill.png`);

// Click Callouts widget to swap to absences drill
console.log(`→ clicking Callouts widget…`);
await appPage.evaluate(() => document.querySelector("#ld-w-absences").click());
await new Promise((r) => setTimeout(r, 800));
const drillAbs = await appPage.evaluate(() => {
  const drill = document.querySelector("#ld-drill");
  return {
    visible: !drill?.hidden,
    title: document.querySelector("#ld-drill-title")?.textContent,
    rowCount: document.querySelectorAll(".ld-table tbody tr").length,
    firstRow: (() => {
      const tr = document.querySelector(".ld-table tbody tr");
      if (!tr) return null;
      return Array.from(tr.querySelectorAll("td")).map((td) => td.textContent.trim());
    })(),
  };
});
console.log(`  Callouts drill visible: ${drillAbs.visible}, title="${drillAbs.title}", rows=${drillAbs.rowCount}`);
if (drillAbs.firstRow) console.log(`  first row: ${JSON.stringify(drillAbs.firstRow)}`);
await appPage.screenshot({ path: "livedashboard-home-3-callouts-drill.png", fullPage: false }).catch(() => {});
console.log(`  📸 livedashboard-home-3-callouts-drill.png`);

// Close drill
await appPage.evaluate(() => document.querySelector("#ld-drill-close").click());
await new Promise((r) => setTimeout(r, 500));
const drillClosed = await appPage.evaluate(() => document.querySelector("#ld-drill")?.hidden);
console.log(`  drill closed after Close click: ${drillClosed}`);

browser.disconnect();
console.log(`✓ Done.`);
process.exit(0);
