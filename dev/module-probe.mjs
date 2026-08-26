// dev/module-probe.mjs
//
// Mount a module and report what happened: did it render, and what did it log?
// For when a build stops working and the tab smoke just says "0 tabs".
//
//   node dev/module-probe.mjs --build=<dir> --module=digitalmetrics

import puppeteer from "puppeteer-core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const arg = (n, d = null) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=").slice(1).join("=") : d;
};
const BUILD = arg("build");
const MODULE = arg("module", "digitalmetrics");
const PROFILE = process.env.APAISUITE_EDGE_PROFILE || join(homedir(), ".apaisuite-edge-debug");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let id = null;
if (BUILD) {
  try {
    const prefs = JSON.parse(readFileSync(join(PROFILE, "Default", "Secure Preferences"), "utf8"));
    const want = BUILD.replace(/[\\/]+/g, "\\").toLowerCase();
    for (const [k, v] of Object.entries(prefs?.extensions?.settings || {})) {
      if (String(v?.path || "").replace(/[\\/]+/g, "\\").toLowerCase() === want) id = k;
    }
  } catch {}
}

const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
async function loads(c) {
  const p = await browser.newPage();
  try { await p.goto(`chrome-extension://${c}/app.html`, { waitUntil: "domcontentloaded", timeout: 12_000 }); return true; }
  catch { return false; } finally { await p.close().catch(() => {}); }
}
if (id && !(await loads(id))) id = null;
if (!id) {
  for (const t of await browser.targets()) {
    if (!t.url().startsWith("chrome-extension://")) continue;
    const c = new URL(t.url()).host;
    if (await loads(c)) { id = c; break; }
  }
}
if (!id) { console.error("✗ no loadable extension"); process.exit(1); }

const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}\n${(e.stack || "").split("\n").slice(1, 4).join("\n")}`));

await page.goto(`chrome-extension://${id}/app.html`, { waitUntil: "domcontentloaded", timeout: 60_000 });
await sleep(3000);
// Sidebar labels are spaced words ("Digital Metrics"); the module id is not.
// Match on the words, not the id.
await page.evaluate((m) => {
  const words = m.replace("digitalmetrics", "digital metrics")
                 .replace("digitalrollup", "digital market rollup");
  [...document.querySelectorAll("a,button,[role=button],li")]
    .find((e) => (e.textContent || "").trim().toLowerCase().includes(words))?.click();
}, MODULE);
await sleep(8000);

const state = await page.evaluate((m) => ({
  mounted: !!document.querySelector(`.module-${m}`),
  containerHtml: (document.querySelector(`.module-${m}`)?.innerHTML || "").length,
  tabs: document.querySelectorAll(".dm-tab").length,
  store: document.querySelector("#dm-store")?.value ?? null,
  weekOpts: document.querySelector("#dm-week")?.options?.length ?? null,
  status: document.querySelector("#dm-status")?.textContent ?? null,
  pageText: (document.querySelector("#dm-page")?.innerText || "").slice(0, 100).replace(/\s+/g, " "),
}), MODULE);

console.log(JSON.stringify(state, null, 2));
console.log("\n── console ──");
for (const l of logs.filter((l) => /error|warn|digitalmetrics/i.test(l)).slice(-12)) {
  console.log("  " + l.slice(0, 400));
}

await page.close();
browser.disconnect();
