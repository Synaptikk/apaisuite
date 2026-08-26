// dev/shoot-themes.mjs
//
// Screenshot a module tab in BOTH themes, and report the measured contrast
// between scheduled and blocked-out grid cells.
//
//   node dev/shoot-themes.mjs --build=<dir> --tab=assignments
//
// Contrast is measured, not eyeballed: the two surfaces sit next to each other
// across a 17-column grid, and "looks fine on my monitor" is how they ended up
// two percent apart in the first place.

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
const TAB = arg("tab", "assignments");
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

for (const theme of ["light", "dark"]) {
  await page.goto(`chrome-extension://${id}/app.html`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await sleep(2500);
  await page.evaluate((t) => {
    document.documentElement.setAttribute("data-theme", t);
    try { localStorage.setItem("apai.theme", t); } catch {}
  }, theme);
  await sleep(600);
  await page.evaluate(() => {
    [...document.querySelectorAll("a,button,[role=button],li")]
      .find((e) => /digital metrics/i.test((e.textContent || "").trim()))?.click();
  });
  await page.waitForFunction(() => (document.querySelector("#dm-week")?.options?.length ?? 0) > 0,
    { timeout: 60_000, polling: 500 }).catch(() => {});
  await sleep(2000);
  await page.evaluate((t) => document.querySelector(`.dm-tab[data-dm-page="${t}"]`)?.click(), TAB);
  await sleep(2500);

  const m = await page.evaluate(() => {
    // color-mix() computes to `color(srgb 0.91 0.92 0.93)` — 0-1 floats, not
    // 0-255. Treating those as bytes makes every mixed colour read as black,
    // which produced a nonsense 20.88 against white and a flat 1 in dark.
    const rgb = (s) => {
      const n = (String(s).match(/[\d.]+/g) || []).map(Number);
      const c = /color\(\s*srgb/i.test(String(s)) ? n.slice(0, 3).map((v) => v * 255) : n.slice(0, 3);
      return c.length === 3 ? c : [0, 0, 0];
    };
    const lum = ([r, g, b]) => {
      const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const ratio = (a, b) => {
      const [x, y] = [lum(a) + 0.05, lum(b) + 0.05].sort((p, q) => q - p);
      return x / y;
    };
    const cs = (el, prop) => el ? getComputedStyle(el)[prop] : null;
    const on  = document.querySelector(".dm-cell.in-shift");
    const off = document.querySelector(".dm-cell[data-dm-offshift]");
    const flag = document.querySelector(".dm-lunch-flag");
    return {
      shift: cs(on, "backgroundColor"),
      offshift: cs(off, "backgroundColor"),
      contrast: on && off ? +ratio(rgb(cs(on, "backgroundColor")), rgb(cs(off, "backgroundColor"))).toFixed(2) : null,
      flagBg: cs(flag, "backgroundColor"),
      flagInk: cs(flag, "color"),
      flagContrast: flag ? +ratio(rgb(cs(flag, "backgroundColor")), rgb(cs(flag, "color"))).toFixed(2) : null,
    };
  });

  console.log(`\n── ${theme} ──`);
  console.log(`  scheduled   : ${m.shift}`);
  console.log(`  blocked out : ${m.offshift}`);
  console.log(`  contrast    : ${m.contrast}  ${m.contrast >= 1.25 ? "✓" : "✗ too close"}`);
  console.log(`  lunch flag  : ${m.flagBg} on ${m.flagInk} → ${m.flagContrast} ${m.flagContrast >= 4.5 ? "✓" : "✗"}`);

  const out = resolve(HERE, "screenshots", `theme-${theme}-${TAB}.png`);
  await page.screenshot({ path: out });
  console.log(`  shot        : ${out}`);
}

await page.close();
browser.disconnect();
