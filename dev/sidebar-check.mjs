// dev/sidebar-check.mjs
//
// Verify the sidebar collapse: width, labels, tooltips, persistence, and that
// it works in the Preview layout as well as the current one.
//
//   node dev/sidebar-check.mjs --build=<dir>
//
// The collapse overrides --shell-sidebar-w rather than restyling the grid, so
// "does it also work in Preview" is the load-bearing question — Preview sets
// that same token to 248px.

import puppeteer from "puppeteer-core";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (n, d = null) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=").slice(1).join("=") : d;
};
const BUILD = arg("build");
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

const snap = () => page.evaluate(() => {
  const sb = document.querySelector(".shell-sidebar");
  const item = document.querySelector("a.shell-nav-item");
  const label = item?.querySelector("span:not(.shell-nav-status)");
  return {
    attr: document.documentElement.getAttribute("data-sidebar"),
    layout: document.documentElement.getAttribute("data-layout"),
    width: sb ? Math.round(sb.getBoundingClientRect().width) : null,
    labelShown: label ? getComputedStyle(label).display !== "none" : null,
    iconShown: item?.querySelector("svg") ? getComputedStyle(item.querySelector("svg")).display !== "none" : null,
    tooltip: item?.getAttribute("title") ?? null,
    toggleLabel: document.getElementById("shell-sidebar-toggle")?.querySelector("span")?.textContent ?? null,
    ariaExpanded: document.getElementById("shell-sidebar-toggle")?.getAttribute("aria-expanded") ?? null,
    stored: (() => { try { return localStorage.getItem("shell.sidebar"); } catch { return null; } })(),
  };
});

for (const layout of ["current", "preview"]) {
  await page.goto(`chrome-extension://${id}/app.html`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.evaluate((l) => {
    try { localStorage.setItem("shell.layout", l); localStorage.setItem("shell.sidebar", "expanded"); } catch {}
  }, layout);
  await page.reload({ waitUntil: "domcontentloaded" });
  await sleep(2500);

  console.log(`\n── layout: ${layout} ──`);
  const before = await snap();
  console.log(`  expanded : width ${before.width}px, label ${before.labelShown ? "shown" : "hidden"}, toggle "${before.toggleLabel}", aria-expanded=${before.ariaExpanded}`);

  await page.evaluate(() => document.getElementById("shell-sidebar-toggle")?.click());
  await sleep(600);
  const after = await snap();
  console.log(`  collapsed: width ${after.width}px, label ${after.labelShown ? "SHOWN ✗" : "hidden ✓"}, icon ${after.iconShown ? "shown ✓" : "HIDDEN ✗"}, tooltip ${JSON.stringify(after.tooltip)}`);
  console.log(`             toggle "${after.toggleLabel}", aria-expanded=${after.ariaExpanded}, stored=${after.stored}`);

  const ok = after.width && after.width <= 70 && !after.labelShown && after.iconShown
          && after.tooltip && after.stored === "collapsed" && after.ariaExpanded === "false";
  console.log(`  ${ok ? "✓ collapse works" : "✗ something is off"}`);

  // Persistence across a reload — this is what pre-paint in theme_boot covers.
  await page.reload({ waitUntil: "domcontentloaded" });
  await sleep(2000);
  const reloaded = await snap();
  console.log(`  after reload: ${reloaded.attr} at ${reloaded.width}px ${reloaded.attr === "collapsed" && reloaded.width <= 70 ? "✓ persisted" : "✗ lost"}`);

  await page.screenshot({ path: resolve(HERE, "screenshots", `sidebar-collapsed-${layout}.png`) });

  // Toggle back so the profile is left as found.
  await page.evaluate(() => document.getElementById("shell-sidebar-toggle")?.click());
  await sleep(400);
}

await page.evaluate(() => { try { localStorage.setItem("shell.layout", "current"); } catch {} });
await page.close();
browser.disconnect();
