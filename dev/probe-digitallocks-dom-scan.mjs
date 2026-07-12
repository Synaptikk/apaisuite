// dev/probe-digitallocks-dom-scan.mjs
// Comprehensive DOM + JS-API scan to find the easiest path to:
//   1. Set the store number (any input that accepts it, or PBI JS API)
//   2. Trigger Excel export (any clickable, or PBI JS API)

import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";

const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const pages = await browser.pages();
const target = pages.find((p) => /app\.powerbi\.com\/groups\/me\/reports\/a118e7e7-/.test(p.url()));
if (!target) { console.error("✗ no PBI tab"); browser.disconnect(); process.exit(1); }
await target.bringToFront();
await new Promise(r => setTimeout(r, 400));

const out = await target.evaluate(() => {
  // -- 1. Look for the Power BI JS embedding API ----------------------------
  const pbiApi = {
    windowPowerBi: typeof window.powerbi !== "undefined",
    windowReport: typeof window.report !== "undefined",
    angularExposed: typeof window.angular !== "undefined",
  };
  // The reports often live inside a <report-embed> or similar with a model.
  // Grab a sample of top-level window properties that might be the API entry.
  pbiApi.windowKeysMatching = Object.keys(window).filter((k) =>
    /power|report|model|embed|cv|visual/i.test(k)
  ).slice(0, 30);

  // Try to discover the report-host element and any data attributes.
  const reportHosts = [...document.querySelectorAll(
    "report-embed, [data-testid*='report'], [class*='report-host'], [class*='reportcontainer']"
  )].map((el) => ({
    tag: el.tagName,
    classes: typeof el.className === "string" ? el.className.split(/\s+/).slice(0, 4).join(" ") : null,
    dataAttrs: [...el.attributes].filter((a) => a.name.startsWith("data-")).map((a) => `${a.name}=${a.value.slice(0, 60)}`),
  }));

  // -- 2. EVERY visible input on the page (with surrounding context) -------
  const inputs = [...document.querySelectorAll("input")].map((el, idx) => {
    if (el.offsetParent === null) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return null;     // hidden small inputs aren't interesting
    if (r.x < 0 || r.y < 0 || r.x > window.innerWidth || r.y > window.innerHeight) return null;
    let parentText = "";
    let cur = el.parentElement;
    for (let i = 0; i < 4 && cur; i++) {
      parentText = (cur.textContent || "").trim().slice(0, 60);
      if (parentText) break;
      cur = cur.parentElement;
    }
    return {
      idx,
      type: el.type,
      placeholder: el.placeholder,
      ariaLabel: el.getAttribute("aria-label"),
      name: el.name,
      id: el.id,
      value: el.value?.slice(0, 30),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      parentTextSnip: parentText,
    };
  }).filter(Boolean);

  // -- 3. EVERY visible button/link with text containing export/excel/data --
  const exportish = [...document.querySelectorAll("button, a, [role='button'], [role='menuitem']")].map((el) => {
    if (el.offsetParent === null) return null;
    const text = (el.textContent || "").replace(/\s+/g, " ").trim();
    const aria = el.getAttribute("aria-label") || "";
    const blob = `${text} ${aria}`.toLowerCase();
    if (!/export|excel|xlsx|download|data/i.test(blob)) return null;
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName, text: text.slice(0, 60), aria: aria.slice(0, 60),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    };
  }).filter(Boolean).slice(0, 30);

  // -- 4. Visible toolbar at top of report — usually has Export/Share -------
  const topbarButtons = [...document.querySelectorAll(".reportContainer button, [class*='topbar'] button, [class*='actionbar'] button")]
    .filter((el) => el.offsetParent !== null)
    .map((el) => {
      const text = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 50);
      const aria = (el.getAttribute("aria-label") || "").slice(0, 60);
      return text || aria ? { text, aria } : null;
    }).filter(Boolean).slice(0, 30);

  // -- 5. Look for the "File" menu (which often has Export) -----------------
  const fileMenuCandidates = [...document.querySelectorAll("button, [role='menuitem']")]
    .filter((el) => el.offsetParent !== null)
    .filter((el) => /^file$/i.test((el.textContent || "").trim()) || /^file$/i.test(el.getAttribute("aria-label") || ""))
    .map((el) => ({ text: (el.textContent || "").trim(), aria: el.getAttribute("aria-label") }));

  // -- 6. Anything with "Store" in its label/text -- store-input shortcut? --
  const storeMentions = [...document.querySelectorAll('input, [aria-label*="Store" i], [placeholder*="Store" i]')]
    .filter((el) => el.offsetParent !== null)
    .slice(0, 10)
    .map((el) => ({
      tag: el.tagName, type: el.type, aria: el.getAttribute("aria-label"),
      placeholder: el.placeholder, classes: typeof el.className === "string" ? el.className : null,
    }));

  return { pbiApi, reportHosts, inputs, exportish, topbarButtons, fileMenuCandidates, storeMentions };
});

writeFileSync("digitallocks-dom-scan.json", JSON.stringify(out, null, 2));

console.log("== Power BI JS API present ==");
console.log(out.pbiApi);
console.log("\n== Report host elements ==");
for (const r of out.reportHosts) console.log(`  ${JSON.stringify(r)}`);
console.log("\n== Visible inputs on page (filtered) ==");
for (const i of out.inputs) console.log(`  [#${i.idx}] type=${i.type} aria=${JSON.stringify(i.ariaLabel)} placeholder=${JSON.stringify(i.placeholder)} id=${JSON.stringify(i.id)} value=${JSON.stringify(i.value)} rect=${JSON.stringify(i.rect)} parent="${i.parentTextSnip}"`);
console.log("\n== Export/Excel/Download-ish buttons ==");
for (const e of out.exportish) console.log(`  <${e.tag}> "${e.text}" aria="${e.aria}" rect=${JSON.stringify(e.rect)}`);
console.log("\n== Topbar buttons ==");
for (const b of out.topbarButtons) console.log(`  "${b.text}" aria="${b.aria}"`);
console.log("\n== 'File' menu candidates ==");
for (const f of out.fileMenuCandidates) console.log(`  ${JSON.stringify(f)}`);
console.log("\n== Anything 'Store' on page ==");
for (const s of out.storeMentions) console.log(`  ${JSON.stringify(s)}`);

await target.screenshot({ path: "digitallocks-current.png", fullPage: false });
console.log("\nScreenshot: digitallocks-current.png");

browser.disconnect();
process.exit(0);
