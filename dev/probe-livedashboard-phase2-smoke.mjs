// dev/probe-livedashboard-phase2-smoke.mjs
//
// Reload extension, switch store from 1458 to 0635, verify CVP refreshes.
// Then trigger pull_compliance and verify Enviance capture+replay works.

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

await extPage.evaluate(async (id) => {
  await new Promise((resolve) => chrome.developerPrivate.reload(id, {}, resolve));
}, extensionId);
await extPage.close().catch(() => {});
await new Promise((r) => setTimeout(r, 1800));

const appPage = await browser.newPage();
await appPage.setViewport({ width: 1600, height: 1000 });
appPage.on("pageerror", (err) => console.error("  PAGE ERROR:", err.message));

await appPage.goto(`chrome-extension://${extensionId}/app.html#/home`, { waitUntil: "domcontentloaded", timeout: 15000 });
await new Promise((r) => setTimeout(r, 2000));

// SW attach for log capture
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
    console.error(`  SW> [exception] ${e.exceptionDetails?.text} ${e.exceptionDetails?.exception?.description}`);
  });
}

// ── Test 1: store switch ─────────────────────────────────────────
console.log(`\n=== Test 1: store switch from 1458 to 635 ===`);
const switchRes = await appPage.evaluate(async () => {
  return await new Promise((resolve) => {
    chrome.runtime.sendMessage({ module: "livedashboard", type: "set_store", storeNbr: "635" }, resolve);
  });
});
const sr = switchRes?.data ?? switchRes;
console.log(`  set_store ok: ${sr?.ok}`);
console.log(`  settings.storeNbr: ${sr?.settings?.storeNbr}`);
console.log(`  cvp.ok: ${sr?.cvp?.ok}`);
if (sr?.cvp?.ok) {
  const hw = sr.cvp.byCategory?.headline?.currentWeek;
  console.log(`  cvp store 635: ${hw?.sellThruPctTy?.toFixed(1)}% (week ${hw?.wmWeekText})`);
}
// Set back to 1458 for the compliance test (user's store)
await appPage.evaluate(async () => {
  return await new Promise((resolve) => {
    chrome.runtime.sendMessage({ module: "livedashboard", type: "set_store", storeNbr: "1458" }, resolve);
  });
});
console.log(`  store reset to 1458`);

// ── Test 2: pull_compliance ─────────────────────────────────────
console.log(`\n=== Test 2: pull_compliance ===`);
const compRes = await appPage.evaluate(async () => {
  return await new Promise((resolve) => {
    chrome.runtime.sendMessage({ module: "livedashboard", type: "pull_compliance" }, resolve);
  });
});
const cr = compRes?.data ?? compRes;
console.log(`  ok: ${cr?.ok}`);
if (cr?.ok) {
  console.log(`  total tasks: ${cr.counts?.total}`);
  console.log(`  overdue: ${cr.counts?.overdue}, due soon: ${cr.counts?.dueSoon}, worst overdue: ${cr.counts?.worstOverdueDays}d`);
  console.log(`  first 5 tasks:`);
  for (const t of (cr.rows || []).slice(0, 5)) {
    const due = t.daysUntilDue == null ? "?" : t.daysUntilDue < 0 ? `${-t.daysUntilDue}d overdue` : `${t.daysUntilDue}d`;
    console.log(`    [${due}] ${t.dueDate} — ${t.taskName} (${t.category}) @ ${t.facility}`);
  }
} else {
  console.log(`  error: ${cr?.error || cr?.errorClass}`);
}

// Screenshot after compliance pull
await new Promise((r) => setTimeout(r, 1500));
await appPage.evaluate(() => document.querySelector("#ld-w-compliance").click());
await new Promise((r) => setTimeout(r, 600));
await appPage.screenshot({ path: "phase2-smoke-compliance-drill.png", fullPage: false }).catch(() => {});
console.log(`  📸 phase2-smoke-compliance-drill.png`);

await cdp?.detach().catch(() => {});
browser.disconnect();
process.exit(0);
