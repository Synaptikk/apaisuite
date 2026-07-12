// dev/probe-digitallocks-slicer-dom.mjs
//
// Dump the DOM structure around the Store slicer so we can see EXACTLY
// what we're driving. The Power BI slicer in this report appears to be a
// "list" slicer (inline search + radio rows) rather than a dropdown — we
// need to confirm that and locate the search input within its container.

import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";

const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const pages = await browser.pages();
const target = pages.find((p) => /app\.powerbi\.com\/groups\/me\/reports\/a118e7e7-/.test(p.url()));
if (!target) { console.error("✗ no PBI tab"); browser.disconnect(); process.exit(1); }

const out = await target.evaluate(() => {
  const slicer = [...document.querySelectorAll('[role="combobox"]')]
    .find((c) => /^Store$/i.test(c.getAttribute("aria-label") || ""));

  function walkUp(el, levels) {
    const path = [];
    let cur = el;
    for (let i = 0; i < levels && cur; i++) {
      const tag = cur.tagName?.toLowerCase() || "?";
      const cls = (cur.className && typeof cur.className === "string") ? cur.className.split(/\s+/).slice(0, 3).join(".") : "";
      const role = cur.getAttribute?.("role");
      const aria = cur.getAttribute?.("aria-label");
      path.push(`${tag}${cls ? "." + cls : ""}${role ? `[role=${role}]` : ""}${aria ? `[aria=${JSON.stringify(aria)}]` : ""}`);
      cur = cur.parentElement;
    }
    return path;
  }

  function describeInputsIn(container) {
    return [...container.querySelectorAll("input")].map((el) => ({
      placeholder: el.placeholder,
      ariaLabel: el.getAttribute("aria-label"),
      type: el.type,
      visible: el.offsetParent !== null,
      rect: (() => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })(),
    }));
  }

  // Find the slicer's outer visualContainer — that's the Power BI cell
  // that wraps the whole "Store" slicer including the search bar + options.
  const slicerVisual = slicer?.closest(".visualContainer")
    || slicer?.closest("[data-vc-id]")
    || slicer?.parentElement?.parentElement?.parentElement?.parentElement;

  return {
    slicerFound: !!slicer,
    slicerRect: slicer?.getBoundingClientRect(),
    slicerAncestorPath: slicer ? walkUp(slicer, 8) : null,
    slicerVisualOuterHtmlSnip: slicerVisual?.outerHTML?.slice(0, 4000) || null,
    inputsInSlicerVisual: slicerVisual ? describeInputsIn(slicerVisual) : null,
    allOptionsCount: document.querySelectorAll('.slicerItemContainer').length,
    visibleOptionsCount: [...document.querySelectorAll('.slicerItemContainer')].filter((o) => o.offsetParent !== null).length,
    // also search for "Store"-labelled containers in case combobox isn't the right anchor
    containersMentioningStore: [...document.querySelectorAll('[aria-label*="Store" i]')].slice(0, 10).map((el) => ({
      tag: el.tagName, role: el.getAttribute("role"), aria: el.getAttribute("aria-label"),
      visible: el.offsetParent !== null,
      classes: typeof el.className === "string" ? el.className.split(/\s+/).slice(0, 4) : null,
    })),
  };
});

writeFileSync("digitallocks-slicer-dom.json", JSON.stringify(out, null, 2));
console.log("Slicer found:", out.slicerFound);
console.log("Slicer rect:", out.slicerRect);
console.log("Slicer ancestor path:");
for (const p of out.slicerAncestorPath || []) console.log(`  ${p}`);
console.log("\nInputs inside slicer's visualContainer:");
for (const i of (out.inputsInSlicerVisual || [])) console.log(`  ${JSON.stringify(i)}`);
console.log("\nTotal .slicerItemContainer:", out.allOptionsCount, "  visible:", out.visibleOptionsCount);
console.log("\nContainers with 'Store' in aria-label:");
for (const c of out.containersMentioningStore) console.log(`  ${JSON.stringify(c)}`);
console.log("\nSlicer visual outerHTML (first 4KB) saved to digitallocks-slicer-dom.json");

browser.disconnect();
process.exit(0);
