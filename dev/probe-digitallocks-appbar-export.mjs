// dev/probe-digitallocks-appbar-export.mjs
// Click the persistent "Export" button in the report's appBar and capture
// what menu/dialog appears, so we know whether it's the right path to a
// per-visual .xlsx download.

import puppeteer from "puppeteer-core";

const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const pages = await browser.pages();
const target = pages.find((p) => /app\.powerbi\.com\/groups\/me\/reports\/a118e7e7-/.test(p.url()));
if (!target) { console.error("✗ no PBI tab"); browser.disconnect(); process.exit(1); }
await target.bringToFront();
await new Promise(r => setTimeout(r, 400));

const result = await target.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { steps: [], menuItems: [], dialogButtons: [], submenuItems: [], error: null };

  function fireClick(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, view: window, clientX: r.x + r.width/2, clientY: r.y + r.height/2 };
    el.dispatchEvent(new PointerEvent("pointerdown", { ...opts, pointerType: "mouse" }));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new PointerEvent("pointerup", { ...opts, pointerType: "mouse" }));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
    if (typeof el.click === "function") el.click();
    return true;
  }
  const itemText = (el) => (el.textContent || "").replace(/\s+/g, " ").trim();
  const visibleMenu = () =>
    [...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], button, .menu-item, .menu-link, .ms-ContextualMenu-link')]
      .filter((i) => i.offsetParent !== null);

  try {
    // Find the appBar Export button: text=Export at upper-left area of report.
    const exportBtn = [...document.querySelectorAll("button")]
      .filter((b) => b.offsetParent !== null)
      .find((b) => /^export$/i.test(itemText(b)));
    if (!exportBtn) throw new Error("appBar Export button not found");
    out.steps.push(`found Export button at ${JSON.stringify(exportBtn.getBoundingClientRect())}`);
    fireClick(exportBtn);
    await sleep(800);

    out.menuItems = visibleMenu()
      .map((i) => ({ text: itemText(i), aria: i.getAttribute("aria-label") }))
      .filter((i) => i.text || i.aria)
      .slice(0, 30);

    // Look for a "data" or "Excel" submenu item we'd want to click next.
    const dataItem = visibleMenu().find((i) => /^(export\s+)?data$/i.test(itemText(i)))
                  || visibleMenu().find((i) => /\bdata\b/i.test(itemText(i)));
    if (dataItem) {
      out.steps.push(`found Data item: "${itemText(dataItem)}"`);
      fireClick(dataItem);
      await sleep(900);
      out.submenuItems = visibleMenu().map((i) => itemText(i)).filter(Boolean).slice(0, 30);
      const dialog = document.querySelector('[role="dialog"], .pbi-modal, .ms-Dialog');
      if (dialog) {
        out.steps.push("dialog appeared after clicking Data submenu");
        out.dialogButtons = [...dialog.querySelectorAll("button")]
          .filter((b) => b.offsetParent !== null)
          .map((b) => ({ text: itemText(b), disabled: b.disabled }));
      }
    } else {
      const dialog = document.querySelector('[role="dialog"], .pbi-modal, .ms-Dialog');
      if (dialog) {
        out.steps.push("dialog appeared directly after Export click (no Data submenu needed)");
        out.dialogButtons = [...dialog.querySelectorAll("button")]
          .filter((b) => b.offsetParent !== null)
          .map((b) => ({ text: itemText(b), disabled: b.disabled }));
      }
    }
  } catch (e) {
    out.error = String(e?.message || e);
  }
  return out;
});

console.log("== Steps ==");
for (const s of result.steps) console.log(`  • ${s}`);
console.log("\n== Menu after Export click ==");
for (const m of result.menuItems) console.log(`  ${JSON.stringify(m)}`);
console.log("\n== Submenu after Data click ==");
for (const s of result.submenuItems) console.log(`  ${JSON.stringify(s)}`);
console.log("\n== Dialog buttons ==");
for (const b of result.dialogButtons) console.log(`  ${JSON.stringify(b)}`);
if (result.error) console.error(`\n✗ ERROR: ${result.error}`);

await target.screenshot({ path: "digitallocks-export-menu.png", fullPage: false });
console.log("\nScreenshot: digitallocks-export-menu.png");
browser.disconnect();
process.exit(0);
