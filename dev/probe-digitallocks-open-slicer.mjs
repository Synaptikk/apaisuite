// dev/probe-digitallocks-open-slicer.mjs
//
// Try several strategies to open the Store slicer dropdown, reporting
// which one (if any) actually exposes the slicer's search input.

import puppeteer from "puppeteer-core";

const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const pages = await browser.pages();
const target = pages.find((p) => /app\.powerbi\.com\/groups\/me\/reports\/a118e7e7-/.test(p.url()));
if (!target) { console.error("✗ no PBI tab"); browser.disconnect(); process.exit(1); }

// Helpers in-page
async function getSlicerRect() {
  return target.evaluate(() => {
    const s = [...document.querySelectorAll('[role="combobox"]')]
      .find((c) => /^Store$/i.test(c.getAttribute("aria-label") || ""));
    if (!s) return null;
    const r = s.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
}
async function visibleSlicerSearch() {
  return target.evaluate(() => {
    const inputs = [...document.querySelectorAll(
      'input[placeholder="Search"], input[aria-label="Search"], input[type="search"]'
    )];
    const slicerSearch = inputs.find((el) => {
      if (el.offsetParent === null) return false;
      const lbl = (el.getAttribute("aria-label") || "").toLowerCase();
      return lbl !== "global search";
    });
    return slicerSearch ? {
      ariaLabel: slicerSearch.getAttribute("aria-label"),
      rect: (() => { const r = slicerSearch.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })(),
    } : null;
  });
}
async function popupVisible() {
  return target.evaluate(() => {
    const body = [...document.querySelectorAll('[role="listbox"][aria-label="Store"]')]
      .find((el) => el.offsetParent !== null);
    return !!body;
  });
}

async function tryStrategy(name, fn) {
  console.log(`\n→ strategy: ${name}`);
  // make sure we start with the popup closed
  await target.evaluate(() => document.body.click());
  await new Promise(r => setTimeout(r, 400));
  const beforePopup = await popupVisible();
  await fn();
  await new Promise(r => setTimeout(r, 800));
  const afterPopup = await popupVisible();
  const search = await visibleSlicerSearch();
  console.log(`  before popup visible: ${beforePopup}`);
  console.log(`  after  popup visible: ${afterPopup}`);
  console.log(`  slicer search now visible: ${search ? "YES " + JSON.stringify(search) : "no"}`);
  return !!(afterPopup || search);
}

const rect = await getSlicerRect();
console.log(`slicer rect: ${JSON.stringify(rect)}`);
if (!rect || rect.w === 0) { console.error("✗ slicer rect invalid"); browser.disconnect(); process.exit(1); }
const cx = rect.x + rect.w / 2;
const cy = rect.y + rect.h / 2;

// Strategy A: puppeteer real mouse click via CDP
const a = await tryStrategy("A: puppeteer real-mouse click at slicer center", async () => {
  await target.mouse.click(cx, cy);
});

// Strategy B: focus + Enter
const b = a || await tryStrategy("B: focus combobox + Enter keypress", async () => {
  await target.evaluate(() => {
    const s = [...document.querySelectorAll('[role="combobox"]')]
      .find((c) => /^Store$/i.test(c.getAttribute("aria-label") || ""));
    s?.focus();
  });
  await target.keyboard.press("Enter");
});

// Strategy C: focus + Space
const c = a || b || await tryStrategy("C: focus combobox + Space keypress", async () => {
  await target.evaluate(() => {
    const s = [...document.querySelectorAll('[role="combobox"]')]
      .find((c) => /^Store$/i.test(c.getAttribute("aria-label") || ""));
    s?.focus();
  });
  await target.keyboard.press("Space");
});

// Strategy D: mousedown only (no mouseup)
const d = a || b || c || await tryStrategy("D: dispatchEvent mousedown only at slicer center", async () => {
  await target.evaluate((cx, cy) => {
    const s = [...document.querySelectorAll('[role="combobox"]')]
      .find((c) => /^Store$/i.test(c.getAttribute("aria-label") || ""));
    if (!s) return;
    const opts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, view: window };
    s.dispatchEvent(new PointerEvent("pointerdown", { ...opts, pointerType: "mouse" }));
    s.dispatchEvent(new MouseEvent("mousedown", opts));
  }, cx, cy);
});

// Strategy E: full dispatchEvent (mousedown + mouseup + click) — same as driver
const e = a || b || c || d || await tryStrategy("E: dispatchEvent full sequence — same as driver fireClick", async () => {
  await target.evaluate((cx, cy) => {
    const s = [...document.querySelectorAll('[role="combobox"]')]
      .find((c) => /^Store$/i.test(c.getAttribute("aria-label") || ""));
    if (!s) return;
    const opts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, view: window };
    s.dispatchEvent(new PointerEvent("pointerdown", { ...opts, pointerType: "mouse" }));
    s.dispatchEvent(new MouseEvent("mousedown", opts));
    s.dispatchEvent(new PointerEvent("pointerup", { ...opts, pointerType: "mouse" }));
    s.dispatchEvent(new MouseEvent("mouseup", opts));
    s.dispatchEvent(new MouseEvent("click", opts));
    if (typeof s.click === "function") s.click();
  }, cx, cy);
});

console.log("\n========== SUMMARY ==========");
console.log(`A real-mouse:        ${a ? "✓ opens slicer" : "✗"}`);
console.log(`B focus+Enter:       ${b ? "✓ opens slicer" : "✗"}`);
console.log(`C focus+Space:       ${c ? "✓ opens slicer" : "✗"}`);
console.log(`D mousedown only:    ${d ? "✓ opens slicer" : "✗"}`);
console.log(`E full dispatchEv:   ${e ? "✓ opens slicer" : "✗"}`);

browser.disconnect();
process.exit(0);
