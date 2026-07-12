// dev/probe-digitallocks-occlusion.mjs
// Find out what's actually at the slicer's screen coordinates and capture
// a screenshot so we can see if something is occluding the slicer.

import puppeteer from "puppeteer-core";

const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const pages = await browser.pages();
const target = pages.find((p) => /app\.powerbi\.com\/groups\/me\/reports\/a118e7e7-/.test(p.url()));
if (!target) { console.error("✗ no PBI tab"); browser.disconnect(); process.exit(1); }

// Focus the tab so screenshot reflects real state
await target.bringToFront();
await new Promise(r => setTimeout(r, 300));

const probe = await target.evaluate(() => {
  const slicer = [...document.querySelectorAll('[role="combobox"]')]
    .find((c) => /^Store$/i.test(c.getAttribute("aria-label") || ""));
  if (!slicer) return { err: "no slicer" };
  slicer.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const r = slicer.getBoundingClientRect();
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  const elAtPoint = document.elementFromPoint(cx, cy);
  function desc(el) {
    if (!el) return null;
    return {
      tag: el.tagName,
      role: el.getAttribute?.("role"),
      aria: el.getAttribute?.("aria-label"),
      classes: typeof el.className === "string" ? el.className.split(/\s+/).slice(0, 4).join(" ") : null,
      isSlicer: el === slicer,
      slicerContains: slicer.contains(el),
      rect: (() => { const rr = el.getBoundingClientRect(); return { x: rr.x, y: rr.y, w: rr.width, h: rr.height }; })(),
    };
  }
  // Walk up from the elementAtPoint a few levels to understand context.
  let path = [];
  let cur = elAtPoint;
  for (let i = 0; i < 8 && cur; i++) {
    path.push(desc(cur));
    cur = cur.parentElement;
  }

  // Also look for any open overlays
  const overlays = [...document.querySelectorAll(
    '[role="listbox"], [role="menu"], [role="dialog"], .ms-Callout, .ms-Layer, .ms-Panel, .pbi-modal'
  )].filter((el) => el.offsetParent !== null).map(desc).slice(0, 10);

  return {
    slicerRect: { x: r.x, y: r.y, w: r.width, h: r.height },
    clickPoint: { cx, cy },
    elementAtPoint: desc(elAtPoint),
    elementAtPointAncestry: path,
    overlaysVisible: overlays,
    viewport: { w: window.innerWidth, h: window.innerHeight, scrollX: window.scrollX, scrollY: window.scrollY },
  };
});

console.log("Viewport:", probe.viewport);
console.log("Slicer rect:", probe.slicerRect);
console.log("Click point (slicer center):", probe.clickPoint);
console.log("\nElement at click point:", JSON.stringify(probe.elementAtPoint, null, 2));
console.log("\nAncestor chain at click point:");
for (const a of probe.elementAtPointAncestry || []) console.log(`  ${JSON.stringify(a)}`);
console.log("\nVisible overlays:");
for (const o of probe.overlaysVisible) console.log(`  ${JSON.stringify(o)}`);

const shotPath = "digitallocks-occlusion.png";
await target.screenshot({ path: shotPath, fullPage: false });
console.log(`\nScreenshot saved: ${shotPath}`);

browser.disconnect();
process.exit(0);
