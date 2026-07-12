// dev/probe-digitallocks-keyboard.mjs
// Use Power BI's keyboard accessibility paths to open the data-grid's
// More-options context menu, bypassing the fragile hover detection.

import puppeteer from "puppeteer-core";

const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const pages = await browser.pages();
const target = pages.find((p) => /app\.powerbi\.com\/groups\/me\/reports\/a118e7e7-/.test(p.url()));
if (!target) { console.error("✗ no PBI tab"); browser.disconnect(); process.exit(1); }
await target.bringToFront();
await new Promise(r => setTimeout(r, 400));

// Close any open panels by clicking blank report area first.
await target.evaluate(() => {
  // Click in a known-safe area (somewhere not on a slicer or button).
  document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
});
await new Promise(r => setTimeout(r, 400));

// Get data-grid bounding rect.
const gridInfo = await target.evaluate(() => {
  const grid = [...document.querySelectorAll(".visualContainer")]
    .find((v) => v.querySelector('[role="grid"]'));
  if (!grid) return null;
  const r = grid.getBoundingClientRect();
  // Also locate the More-options button within this visualContainer (it
  // exists in DOM even when hidden — we just can't click via mouse without
  // hover, but maybe via focus+Enter we can).
  const moreBtn = grid.querySelector('button[aria-label="More options"]');
  return {
    grid: { x: r.x, y: r.y, w: r.width, h: r.height },
    moreBtnExists: !!moreBtn,
    moreBtnRect: moreBtn ? (() => { const rr = moreBtn.getBoundingClientRect(); return { x: rr.x, y: rr.y, w: rr.width, h: rr.height, visible: moreBtn.offsetParent !== null }; })() : null,
  };
});
console.log("grid info:", JSON.stringify(gridInfo, null, 2));
if (!gridInfo) { console.error("✗ no data grid"); browser.disconnect(); process.exit(1); }

// STRATEGY A: hover over grid (real-mouse), then look for More-options.
console.log("\n→ STRATEGY A: real-mouse hover over grid center, then click More-options");
await target.mouse.move(gridInfo.grid.x + gridInfo.grid.w / 2, gridInfo.grid.y + gridInfo.grid.h / 2, { steps: 5 });
await new Promise(r => setTimeout(r, 800));

const afterHover = await target.evaluate(() => {
  const visible = (b) => b.offsetParent !== null;
  const candidates = [...document.querySelectorAll('button[aria-label="More options"]')]
    .map((b) => ({ visible: visible(b), rect: (() => { const r = b.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })() }));
  return candidates;
});
console.log("More-options buttons after hover:", JSON.stringify(afterHover, null, 2));

// If one's visible inside grid bounds, click it.
const moreInGrid = afterHover.find((b) => b.visible
  && b.rect.x >= gridInfo.grid.x - 5 && b.rect.x <= gridInfo.grid.x + gridInfo.grid.w + 5
  && b.rect.y >= gridInfo.grid.y - 30 && b.rect.y <= gridInfo.grid.y + 60);
if (moreInGrid) {
  console.log(`\n→ More options visible at ${JSON.stringify(moreInGrid.rect)}, clicking...`);
  await target.mouse.click(moreInGrid.rect.x + moreInGrid.rect.w / 2, moreInGrid.rect.y + moreInGrid.rect.h / 2);
  await new Promise(r => setTimeout(r, 600));

  const menu = await target.evaluate(() => {
    return [...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')]
      .filter((i) => i.offsetParent !== null)
      .map((i) => (i.textContent || "").trim())
      .filter(Boolean)
      .slice(0, 25);
  });
  console.log("\n== Menu items after More-options click ==");
  for (const m of menu) console.log(`  ${JSON.stringify(m)}`);

  // Now click "Export data" if present, then capture the dialog.
  const result = await target.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const txt = (e) => (e.textContent || "").trim();
    const exportItem = [...document.querySelectorAll('[role="menuitem"]')]
      .filter((i) => i.offsetParent !== null)
      .find((i) => /^export\s+data$/i.test(txt(i))) ||
      [...document.querySelectorAll('[role="menuitem"]')]
        .filter((i) => i.offsetParent !== null)
        .find((i) => /^export$/i.test(txt(i)));
    if (!exportItem) return { err: "no Export item" };
    // Click via fireClick — these are menuitems, real mouse may not bubble right.
    const r = exportItem.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, view: window, clientX: r.x + r.width/2, clientY: r.y + r.height/2 };
    exportItem.dispatchEvent(new PointerEvent("pointerdown", { ...opts, pointerType: "mouse" }));
    exportItem.dispatchEvent(new MouseEvent("mousedown", opts));
    exportItem.dispatchEvent(new PointerEvent("pointerup", { ...opts, pointerType: "mouse" }));
    exportItem.dispatchEvent(new MouseEvent("mouseup", opts));
    exportItem.dispatchEvent(new MouseEvent("click", opts));
    if (typeof exportItem.click === "function") exportItem.click();
    await sleep(900);
    // What appeared?
    const submenu = [...document.querySelectorAll('[role="menuitem"]')]
      .filter((i) => i.offsetParent !== null)
      .map((i) => txt(i))
      .filter(Boolean)
      .slice(0, 20);
    const dialog = document.querySelector('[role="dialog"], .pbi-modal, .ms-Dialog');
    return {
      clicked: txt(exportItem),
      submenu,
      dialog: dialog ? {
        buttons: [...dialog.querySelectorAll("button")]
          .filter((b) => b.offsetParent !== null)
          .map((b) => ({ text: txt(b), disabled: b.disabled })),
        radios: [...dialog.querySelectorAll('input[type="radio"], [role="radio"]')]
          .map((r) => ({ aria: r.getAttribute("aria-label"), label: r.closest("label")?.textContent?.trim() })),
      } : null,
    };
  });
  console.log("\n== After Export click ==");
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log("\n✗ No More-options visible after hover. Trying STRATEGY B: keyboard Shift+F10");
  // Focus the grid first
  await target.evaluate(() => {
    const grid = [...document.querySelectorAll(".visualContainer")]
      .find((v) => v.querySelector('[role="grid"]'));
    grid?.focus();
  });
  await new Promise(r => setTimeout(r, 200));
  await target.keyboard.down("Shift");
  await target.keyboard.press("F10");
  await target.keyboard.up("Shift");
  await new Promise(r => setTimeout(r, 800));
  const menu = await target.evaluate(() => {
    return [...document.querySelectorAll('[role="menuitem"]')]
      .filter((i) => i.offsetParent !== null)
      .map((i) => (i.textContent || "").trim())
      .filter(Boolean)
      .slice(0, 25);
  });
  console.log("\nMenu after Shift+F10:");
  for (const m of menu) console.log(`  ${JSON.stringify(m)}`);
}

await target.screenshot({ path: "digitallocks-keyboard.png", fullPage: false });
console.log("\nScreenshot: digitallocks-keyboard.png");
browser.disconnect();
process.exit(0);
