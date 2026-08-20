// dev/probe-slicer-dom.mjs
// Find the Store slicer/filter control on the live Backroom report so we can
// drive it. Read-only DOM scan: lists visualContainers, slicer headers, and
// any element whose text/aria mentions Store or 1458.
import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";

const BACKROOM_ID = "c929bfda-c409-49f5-b2cb-732370411af3";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const targets = browser.targets().filter((t) => t.type() === "page" && t.url().includes(BACKROOM_ID));
if (!targets.length) { console.log("❌ no Backroom report tab open"); process.exit(1); }
const page = await targets[0].page();

const info = await page.evaluate(() => {
  const out = { slicers: [], storeMentions: [], filterPane: [] };

  // Power BI slicers render as .slicer-container / visualContainer with a header.
  for (const vc of document.querySelectorAll(".visualContainer, .slicer-container, visual-container-modern, .visualContainerHost")) {
    const rect = vc.getBoundingClientRect();
    const txt = (vc.innerText || "").trim().slice(0, 120);
    const isSlicer = /slicer/i.test(vc.className) || vc.querySelector("[class*=slicer]");
    if (txt || isSlicer) {
      out.slicers.push({
        cls: vc.className?.toString().slice(0, 80),
        isSlicer: !!isSlicer,
        x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height),
        text: txt,
      });
    }
  }

  // Anything mentioning Store or the current store number.
  const all = document.querySelectorAll("*");
  let count = 0;
  for (const el of all) {
    if (count > 40) break;
    const t = (el.getAttribute?.("aria-label") || "") + "|" + (el.getAttribute?.("title") || "");
    const direct = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim();
    if (/\bstore\b/i.test(t) || /\b1458\b/.test(t) || /\b1458\b/.test(direct)) {
      const rect = el.getBoundingClientRect();
      out.storeMentions.push({
        tag: el.tagName, cls: (el.className?.toString?.() || "").slice(0, 60),
        aria: el.getAttribute?.("aria-label")?.slice(0, 80), title: el.getAttribute?.("title")?.slice(0, 60),
        text: direct.slice(0, 60), x: Math.round(rect.x), y: Math.round(rect.y),
      });
      count++;
    }
  }

  // Filter pane cards.
  for (const fc of document.querySelectorAll(".filterCard, [class*=filter-card], .slicerHeader, .slicer-header")) {
    out.filterPane.push({ cls: (fc.className?.toString?.() || "").slice(0, 60), text: (fc.innerText || "").trim().slice(0, 80) });
  }

  return out;
});

console.log("=== SLICERS (" + info.slicers.length + ") ===");
for (const s of info.slicers) console.log(JSON.stringify(s));
console.log("\n=== STORE MENTIONS (" + info.storeMentions.length + ") ===");
for (const s of info.storeMentions) console.log(JSON.stringify(s));
console.log("\n=== FILTER PANE (" + info.filterPane.length + ") ===");
for (const s of info.filterPane) console.log(JSON.stringify(s));

writeFileSync("slicer-dom-probe.json", JSON.stringify(info, null, 2));
await page.screenshot({ path: "slicer-dom-screenshot.png" }).catch(() => {});
console.log("\n✓ dev/slicer-dom-probe.json + slicer-dom-screenshot.png");
browser.disconnect();
process.exit(0);
