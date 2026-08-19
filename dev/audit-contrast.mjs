// dev/audit-contrast.mjs
//
// Renders each module's view.html in DARK mode with the real stylesheets and
// measures the actual computed contrast of every visible text node against its
// effective background, walking ancestors past transparent layers.
//
// Why measured rather than reviewed: styles/tokens.css says any hex literal
// "needs to be reviewed for dark legibility — search the codebase on theme
// bring-up". There are ~380 of them across 13 stylesheets, and reading them
// cannot tell you what a rule actually composites to at runtime.
//
// Run: node dev/audit-contrast.mjs            (needs a static server on 8755)
//      node dev/audit-contrast.mjs --light

import { chromium } from "playwright";
import { readdirSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const PORT = process.env.PORT || 8755;
const THEME = process.argv.includes("--light") ? "light" : "dark";

// WCAG 2.1: 4.5:1 for body text, 3:1 for large text (>=18.66px, or >=14px bold).
const AA_NORMAL = 4.5;
const AA_LARGE = 3.0;

const modules = readdirSync(path.join(ROOT, "modules"), { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(path.join(ROOT, "modules", d.name, "view.html")))
  .map((d) => d.name);

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();
await page.route("**/*", (r) =>
  r.request().url().includes(`127.0.0.1:${PORT}`) ? r.continue() : r.abort());

const AUDIT = () => {
  const parse = (c) => {
    const m = String(c).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const ratio = (a, b) => {
    const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (l1 + 0.05) / (l2 + 0.05);
  };
  // Effective background: composite every ancestor layer down to the page.
  const bgOf = (el) => {
    let acc = null;
    for (let n = el; n; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (!c || c.a === 0) continue;
      acc = acc ? over(acc, c) : c;
      if (acc.a >= 1) break;
    }
    if (!acc) acc = { r: 255, g: 255, b: 255, a: 1 };
    if (acc.a < 1) acc = over(acc, { r: 255, g: 255, b: 255, a: 1 });
    return acc;
  };

  const out = [];
  const seen = new Set();
  for (const el of document.querySelectorAll("*")) {
    // Only elements with their own visible text.
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!own) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
    const fgRaw = parse(cs.color);
    if (!fgRaw) continue;
    const bg = bgOf(el);
    const fg = fgRaw.a < 1 ? over(fgRaw, bg) : fgRaw;
    const r = ratio(fg, bg);
    const px = parseFloat(cs.fontSize);
    const bold = Number(cs.fontWeight) >= 700;
    const large = px >= 18.66 || (px >= 14 && bold);
    const need = large ? 3.0 : 4.5;
    if (r >= need) continue;
    const text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 45);
    const key = `${el.className}|${cs.color}|${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      sel: el.tagName.toLowerCase() + (el.className && typeof el.className === "string"
        ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : ""),
      text, color: cs.color, bg: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})`,
      ratio: Math.round(r * 100) / 100, need,
    });
  }
  return out.sort((a, b) => a.ratio - b.ratio);
};

// Module views, plus the shell's own pages — Settings is shell-rendered, so a
// module-only sweep would miss every control on it.
const targets = [
  ...modules.map((m) => ({ name: m, url: `/dev/view-harness.html?m=${m}&theme=${THEME}`, settle: 350 })),
  { name: "shell:settings", url: `/dev/settings-harness.html#/settings`, settle: 1500, theme: THEME },
];

let total = 0;
const report = [];
for (const t of targets) {
  await page.goto(`http://127.0.0.1:${PORT}${t.url}`, { waitUntil: "domcontentloaded" });
  // The shell harness applies whatever theme app.js resolves, so force ours.
  if (t.theme) await page.evaluate((th) => document.documentElement.setAttribute("data-theme", th), t.theme);
  await page.waitForTimeout(t.settle);
  const bad = await page.evaluate(AUDIT);
  total += bad.length;
  if (bad.length) report.push({ mod: t.name, bad });
}

console.log(`\n=== contrast audit (theme=${THEME}) ===`);
for (const { mod, bad } of report) {
  console.log(`\n${mod}  — ${bad.length} failing`);
  for (const b of bad.slice(0, 8)) {
    console.log(`  ${String(b.ratio).padStart(5)}:1 (need ${b.need})  ${b.sel}`);
    console.log(`        color ${b.color} on ${b.bg}   "${b.text}"`);
  }
  if (bad.length > 8) console.log(`  … ${bad.length - 8} more`);
}
console.log(`\ntotal failing text styles: ${total} across ${report.length}/${targets.length} views`);
await browser.close();
