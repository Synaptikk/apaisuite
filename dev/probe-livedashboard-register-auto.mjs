// dev/probe-livedashboard-register-auto.mjs
//
// Reload extension, trigger pull_register, observe automated capture from
// the Power BI register report, verify the matching/severity output, take
// a screenshot of the new theft-focused drill.

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

// Reload extension so new code + manifest land
await extPage.evaluate(async (id) => {
  await new Promise((resolve) => chrome.developerPrivate.reload(id, {}, resolve));
}, extensionId);
await extPage.close().catch(() => {});
await new Promise((r) => setTimeout(r, 2000));

const appPage = await browser.newPage();
await appPage.setViewport({ width: 1700, height: 1050 });
appPage.on("pageerror", (err) => console.error("  PAGE ERROR:", err.message));

await appPage.goto(`chrome-extension://${extensionId}/app.html#/home`, { waitUntil: "domcontentloaded", timeout: 15000 });
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
  cdp.on("Runtime.exceptionThrown", (e) => {
    console.error(`  SW> [exception] ${e.exceptionDetails?.text} ${e.exceptionDetails?.exception?.description || ""}`);
  });
}

console.log(`\n=== pull_register (automated capture from Power BI) ===`);
console.log(`(this opens the report in background and waits ~25s for queries to fire)`);
const reg = await appPage.evaluate(async () => {
  return await new Promise((resolve) => {
    chrome.runtime.sendMessage({ module: "livedashboard", type: "pull_register" }, resolve);
  });
});
const r = reg?.data ?? reg;
console.log(`  ok: ${r?.ok}`);
if (r?.ok) {
  console.log(`  cells: ${r.cellCount}, findings: ${r.findings}`);
  console.log(`  counts: ${JSON.stringify(r.counts)}`);
} else {
  console.log(`  error: ${r?.error || r?.errorClass}`);
}

// Read state, dump top surface findings
const state = await appPage.evaluate(async () => {
  return await new Promise((resolve) => {
    chrome.runtime.sendMessage({ module: "livedashboard", type: "get_dashboard_state" }, resolve);
  });
});
const reg_cache = state?.data?.sources?.register?.cache;
if (reg_cache?.findings) {
  const surface = reg_cache.findings.filter((f) => f.displayPriority === "primary");
  console.log(`\n=== Primary surface findings (${surface.length}) ===`);
  surface.slice(0, 10).forEach((f) => {
    const amt = (f.primaryAmountCents / 100).toFixed(2);
    const conf = f.matchType === "none" ? "—" : `${Math.round(f.flipConfidence * 100)}%`;
    const match = f.matchType === "none" ? "UNMATCHED" : `${f.matchType.replace(/-/g, " ")} (${conf})`;
    const ops = (f.primaryOperators || []).map((o) => o.operatorId).join(",") || "—";
    console.log(`  ${f.severity.toUpperCase().padEnd(6)} ${f.primaryDate} reg ${f.primaryRegister.padStart(3)} $${amt.padStart(8)} ${match}  ops=${ops}`);
  });
  const noise = reg_cache.findings.filter((f) => f.displayPriority === "noise");
  console.log(`\n=== Noise (likely flips, hidden) (${noise.length}) — sample 5 ===`);
  noise.slice(0, 5).forEach((f) => {
    const amt = (f.primaryAmountCents / 100).toFixed(2);
    const conf = `${Math.round(f.flipConfidence * 100)}%`;
    console.log(`  reg ${f.primaryRegister.padStart(3)} $${amt.padStart(8)} ${f.primaryDate} flip ${conf}`);
  });
}

// Open the register drill in the UI
await new Promise((r) => setTimeout(r, 1500));
await appPage.evaluate(() => document.querySelector("#ld-w-register")?.click());
await new Promise((r) => setTimeout(r, 700));
await appPage.screenshot({ path: "register-auto-1-drill-default.png", fullPage: false });
console.log(`\n  📸 register-auto-1-drill-default.png`);

// Toggle "show all"
const toggle = await appPage.$("#ld-reg-show-all");
if (toggle) {
  await toggle.click();
  await new Promise((r) => setTimeout(r, 500));
  await appPage.screenshot({ path: "register-auto-2-drill-show-all.png", fullPage: false });
  console.log(`  📸 register-auto-2-drill-show-all.png`);
}

await cdp?.detach().catch(() => {});
browser.disconnect();
process.exit(0);
