// dev/probe-livedashboard-phase1.mjs
//
// Live test: reload APAISuite, open app.html, navigate to #/livedashboard,
// invoke pull_cvp from the SW and observe the response, screenshot.
//
// Does NOT trigger pull_absences automatically — that opens the IVR tab
// and runs a 5–60s scrape. Run it manually from the dashboard's "Refresh
// Now" button if you want to verify absences too.

import puppeteer from "puppeteer-core";

const BROWSER_URL = "http://localhost:9222";
const EXT_NAME    = "APAISuite";

const browser = await puppeteer.connect({ browserURL: BROWSER_URL, defaultViewport: null });
console.log(`✓ Connected to ${BROWSER_URL}`);

// ── Find extension ID via chrome://extensions ───────────────────────
const extPage = await browser.newPage();
await extPage.goto("edge://extensions/", { waitUntil: "domcontentloaded", timeout: 10000 });
const allExtensions = await extPage.evaluate(async () => {
  return await new Promise((resolve) => {
    chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true }, (info) => resolve(info));
  });
});
const suiteInfo = allExtensions.find((x) => x.name === EXT_NAME);
if (!suiteInfo) {
  console.error(`✗ "${EXT_NAME}" not installed. Installed:`);
  for (const x of allExtensions) console.error(`    ${x.id}  ${x.name}  v${x.version}  (${x.state})`);
  process.exit(1);
}
const extensionId = suiteInfo.id;
console.log(`✓ ${EXT_NAME}: id=${extensionId} v${suiteInfo.version} state=${suiteInfo.state}`);

// ── Reload extension to pick up new code ─────────────────────────────
console.log(`→ reloading extension…`);
await extPage.evaluate(async (id) => {
  await new Promise((resolve) => chrome.developerPrivate.reload(id, {}, resolve));
}, extensionId);
await extPage.close().catch(() => {});
await new Promise((r) => setTimeout(r, 1800));

// ── Open app.html to wake SW + render dashboard ─────────────────────
const appPage = await browser.newPage();
await appPage.setViewport({ width: 1600, height: 1000 });
appPage.on("pageerror", (err) => console.error("  PAGE ERROR:", err.message));
appPage.on("console", (msg) => {
  // Forward page console for visibility
  if (msg.type() === "error") console.error("  PAGE console.error:", msg.text());
});

await appPage.goto(`chrome-extension://${extensionId}/app.html#/livedashboard`, { waitUntil: "domcontentloaded", timeout: 15000 });
await new Promise((r) => setTimeout(r, 1500));

// ── Attach to SW for console capture ────────────────────────────────
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
  cdp.on("Runtime.exceptionThrown", (e) => {
    console.error(`  SW> [exception] ${e.exceptionDetails?.text || ""} ${e.exceptionDetails?.exception?.description || ""}`);
  });
  console.log(`✓ SW attached: ${swTarget.url()}`);
} else {
  console.warn(`  no SW target — dashboard messages may not flow`);
}

// ── Snapshot 1: dashboard as initially rendered ─────────────────────
await new Promise((r) => setTimeout(r, 1500));
await appPage.screenshot({ path: "livedashboard-1-initial.png", fullPage: false }).catch(() => {});
console.log(`  📸 livedashboard-1-initial.png`);

// ── Trigger pull_cvp via the SW message bus ─────────────────────────
console.log(`→ invoking pull_cvp (store 1458)…`);
const cvpResult = await appPage.evaluate(async () => {
  return await new Promise((resolve) => {
    chrome.runtime.sendMessage({ module: "livedashboard", type: "pull_cvp", storeNbr: "1458" }, resolve);
  });
});
console.log(`  pull_cvp result: ok=${cvpResult?.ok} data.ok=${cvpResult?.data?.ok}`);
if (cvpResult?.data?.ok) {
  const cw = cvpResult.data.currentWeek;
  console.log(`  current week: ${cw.wmWeekTextLong} sellThru=${cw.sellThruPctTy}% LY=${cw.sellThruPctLy}%`);
  console.log(`  rows captured: ${cvpResult.data.rows.length}`);
} else {
  console.log(`  pull_cvp error: ${cvpResult?.data?.error || cvpResult?.error}`);
}

// ── Read dashboard state for verification ───────────────────────────
console.log(`→ reading get_dashboard_state…`);
const state = await appPage.evaluate(async () => {
  return await new Promise((resolve) => {
    chrome.runtime.sendMessage({ module: "livedashboard", type: "get_dashboard_state" }, resolve);
  });
});
if (state?.ok && state?.data) {
  console.log(`  state.storeNbr: ${state.data.storeNbr}`);
  console.log(`  freshness.cvp:`, JSON.stringify(state.data.freshness.cvp));
  console.log(`  cvp cache has rows: ${state.data.sources.cvp.cache?.rows?.length || 0}`);
}

// ── Snapshot 2: dashboard after CVP pull ────────────────────────────
await new Promise((r) => setTimeout(r, 2000));
await appPage.screenshot({ path: "livedashboard-2-after-cvp.png", fullPage: false }).catch(() => {});
console.log(`  📸 livedashboard-2-after-cvp.png`);

// ── Dump rendered widget text for hard verification ────────────────
const widgetState = await appPage.evaluate(() => {
  const out = {};
  for (const id of ["ld-w-absences","ld-w-compliance","ld-w-accident","ld-w-cvp","ld-w-register"]) {
    const el = document.querySelector("#" + id);
    if (!el) { out[id] = null; continue; }
    out[id] = {
      sev: el.dataset.sev,
      title: el.querySelector("h2")?.textContent?.trim(),
      pill:  el.querySelector(".ld-widget-pill")?.textContent?.trim(),
      prim:  el.querySelector(".ld-widget-primary")?.textContent?.trim(),
      sec:   el.querySelector(".ld-widget-secondary")?.textContent?.trim(),
      foot:  el.querySelector(".ld-widget-foot")?.textContent?.trim(),
    };
  }
  return out;
});
console.log(`\n========== RENDERED WIDGETS ==========`);
for (const [id, w] of Object.entries(widgetState)) {
  if (!w) { console.log(`  ${id}: NOT RENDERED`); continue; }
  console.log(`  ${id} [${w.sev}] "${w.title}" pill="${w.pill}"`);
  console.log(`    primary:  "${w.prim}"`);
  console.log(`    sec:      "${w.sec}"`);
  console.log(`    foot:     "${w.foot}"`);
}
console.log(`======================================\n`);

await new Promise((r) => setTimeout(r, 1000));
await cdp?.detach().catch(() => {});
browser.disconnect();
console.log(`✓ Done.`);
process.exit(0);
