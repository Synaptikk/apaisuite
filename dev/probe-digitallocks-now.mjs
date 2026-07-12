// dev/probe-digitallocks-now.mjs
// Take a screenshot + snapshot DOM at the same moment so we know exactly
// what the page looks like and what the DOM says is visible right now.

import puppeteer from "puppeteer-core";

const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const pages = await browser.pages();
const target = pages.find((p) => /app\.powerbi\.com\/groups\/me\/reports\/a118e7e7-/.test(p.url()));
if (!target) { console.error("✗ no PBI tab"); browser.disconnect(); process.exit(1); }

await target.bringToFront();
await new Promise(r => setTimeout(r, 600));

// Snapshot first, then screenshot — back to back to minimize state drift.
const snap = await target.evaluate(() => {
  // Find ALL listboxes (not just aria-label="Store")
  const listboxes = [...document.querySelectorAll('[role="listbox"]')].map((el) => ({
    aria: el.getAttribute("aria-label"),
    classes: typeof el.className === "string" ? el.className.split(/\s+/).slice(0, 5).join(" ") : null,
    visible: el.offsetParent !== null,
    optionCount: el.querySelectorAll('[role="option"], .slicerItemContainer').length,
    rect: (() => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })(),
  }));

  // Find ALL slicerItemContainer with visibility AND text
  const items = [...document.querySelectorAll('.slicerItemContainer')].slice(0, 20).map((o) => ({
    text: (o.textContent || "").trim().slice(0, 40),
    visible: o.offsetParent !== null,
    rect: (() => { const r = o.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })(),
  }));

  // Find ALL inputs and their state RIGHT NOW
  const inputs = [...document.querySelectorAll("input")].map((el, i) => ({
    idx: i,
    placeholder: el.placeholder,
    ariaLabel: el.getAttribute("aria-label"),
    type: el.type,
    visible: el.offsetParent !== null,
    rect: (() => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })(),
  })).filter((i) => /search|^$/i.test(i.ariaLabel || "") || /search/i.test(i.placeholder || "") || i.type === "search");

  return { listboxes, items, inputs, scrollY: window.scrollY, viewport: { w: window.innerWidth, h: window.innerHeight } };
});

console.log("Viewport:", snap.viewport, "scrollY:", snap.scrollY);
console.log("\n--- All [role=listbox] on page ---");
for (const l of snap.listboxes) console.log(`  ${JSON.stringify(l)}`);
console.log("\n--- All .slicerItemContainer (first 20) ---");
for (const i of snap.items) console.log(`  visible=${i.visible}  rect=${JSON.stringify(i.rect)}  text="${i.text}"`);
console.log("\n--- All search-looking inputs ---");
for (const i of snap.inputs) console.log(`  [${i.idx}] visible=${i.visible}  aria=${JSON.stringify(i.ariaLabel)}  placeholder=${JSON.stringify(i.placeholder)}  rect=${JSON.stringify(i.rect)}`);

await target.screenshot({ path: "digitallocks-now.png", fullPage: false });
console.log("\nScreenshot: digitallocks-now.png");

browser.disconnect();
process.exit(0);
