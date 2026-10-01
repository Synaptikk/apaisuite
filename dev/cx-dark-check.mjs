// Measure real computed contrast for every visible Cx text node in dark mode,
// the same method as dev/audit-contrast.mjs but over the debug Edge (playwright
// is not installed in dev/node_modules).
import puppeteer from "puppeteer-core";
const APP = "chrome-extension://fchnolphfaklbpdgnofhblfhcailkpdb/app.html";
const THEME = process.argv[2] || "dark";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null, protocolTimeout: 300000 });
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 1000 });
await page.goto(APP, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.evaluate(async (t) => { localStorage.setItem("shell.theme", t); await chrome.storage.sync.set({ "shell.theme": t }); }, THEME);
await page.goto(`${APP}#/cx`, { waitUntil: "domcontentloaded", timeout: 60000 });
await new Promise(r => setTimeout(r, 6000));
// The shell reconciles the theme from chrome.storage.sync after mount, so set
// the attribute the CSS actually keys on directly — that is what we measure.
await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), THEME);
for (const h of await page.$$("[data-bad-themes] .cx-theme-head")) { await h.click(); break; }
await new Promise(r => setTimeout(r, 900));

const out = await page.evaluate(() => {
  const parse = (c) => { const m = String(c).match(/rgba?\(([^)]+)\)/); if (!m) return null;
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v/12.92 : ((v+0.055)/1.055)**2.4; };
    return 0.2126*f(r) + 0.7152*f(g) + 0.0722*f(b); };
  const over = (fg, bg) => ({ r: fg.r*fg.a + bg.r*(1-fg.a), g: fg.g*fg.a + bg.g*(1-fg.a), b: fg.b*fg.a + bg.b*(1-fg.a), a: 1 });
  const ratio = (a, b) => { const [l1, l2] = [lum(a), lum(b)].sort((x,y)=>y-x); return (l1+0.05)/(l2+0.05); };
  const bgOf = (el) => { let acc = null;
    for (let n = el; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor);
      if (!c || c.a === 0) continue; acc = acc ? over(acc, c) : c; if (acc.a >= 1) break; }
    if (!acc) acc = { r:255,g:255,b:255,a:1 };
    return acc.a < 1 ? over(acc, { r:255,g:255,b:255,a:1 }) : acc; };

  const root = document.querySelector(".module-cx");
  if (!root) return { err: "not mounted" };
  const fails = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.nodeValue.trim();
    if (!text) continue;
    const el = n.parentElement;
    if (!el || seen.has(el)) continue;
    seen.add(el);
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.opacity === "0") continue;
    const fg = parse(cs.color); if (!fg) continue;
    const bg = bgOf(el);
    const cr = ratio(fg.a < 1 ? over(fg, bg) : fg, bg);
    const px = parseFloat(cs.fontSize);
    const large = px >= 18.66 || (px >= 14 && Number(cs.fontWeight) >= 700);
    const need = large ? 3.0 : 4.5;
    if (cr < need) fails.push({ cls: el.className.toString().slice(0, 46), px, weight: cs.fontWeight,
      ratio: Math.round(cr*100)/100, need, color: cs.color, text: text.slice(0, 40) });
  }
  return { theme: document.documentElement.getAttribute("data-theme"), checked: seen.size, fails };
});
console.log(`theme=${out.theme} nodes=${out.checked} failures=${out.fails?.length ?? "?"}`);
for (const f of out.fails ?? []) console.log(`  ${String(f.ratio).padStart(5)} (need ${f.need})  ${f.px}px/${f.weight}  ${f.cls.padEnd(34)} "${f.text}"`);
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: false });
await page.evaluate(async () => { localStorage.setItem("shell.theme", "system"); await chrome.storage.sync.set({ "shell.theme": "system" }); });
await page.close();
await browser.disconnect();
