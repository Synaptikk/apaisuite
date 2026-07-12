// dev/probe-digitallocks-fullflow.mjs
//
// End-to-end probe of the digitallocks Power BI flow, executed in the page
// via CDP — bypasses the extension SW so we can iterate without reload
// cycles. Mirrors the driver's logic with verbose step-by-step logging.
//
// Usage:
//   node dev/probe-digitallocks-fullflow.mjs [storeNumber=1458]

import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";

const STORE = (process.argv[2] || "1458").trim();
const BROWSER_URL = process.env.EDGE_CDP_URL || "http://localhost:9222";
const REPORT_HOST_FILTER = /app\.powerbi\.com\/groups\/me\/reports\/a118e7e7-/;

console.log(`→ connecting to ${BROWSER_URL}…`);
const browser = await puppeteer.connect({ browserURL: BROWSER_URL, defaultViewport: null });

const pages = await browser.pages();
const target = pages.find((p) => REPORT_HOST_FILTER.test(p.url()));
if (!target) {
  console.error(`✗ No Power BI tab matches ${REPORT_HOST_FILTER}.`);
  for (const p of pages) console.error(`  ${p.url()}`);
  browser.disconnect(); process.exit(1);
}
console.log(`✓ Found PBI tab: ${target.url()}`);

// Capture page console messages so we see anything the page logs.
target.on("console", (msg) => {
  const t = msg.text();
  if (/digitallocks|driver|powerbi|slicer/i.test(t)) console.log(`  PAGE> [${msg.type()}] ${t}`);
});

const result = await target.evaluate(async (wanted) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
  const trace = [];
  const log = (...a) => { trace.push(a.map((x) => typeof x === "object" ? JSON.stringify(x) : String(x)).join(" ")); };

  function fireClick(el) {
    if (!el) return;
    const r = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, view: window, clientX: r.x + r.width/2, clientY: r.y + r.height/2 };
    el.dispatchEvent(new PointerEvent("pointerdown", { ...opts, pointerType: "mouse" }));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new PointerEvent("pointerup", { ...opts, pointerType: "mouse" }));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
    if (typeof el.click === "function") el.click();
  }
  function hover(el) {
    if (!el) return;
    const r = el.getBoundingClientRect();
    const opts = { bubbles: true, clientX: r.x + r.width/2, clientY: r.y + r.height/2 };
    ["pointerover","pointerenter","mouseover","mouseenter","mousemove"].forEach((t) => {
      try { el.dispatchEvent(new PointerEvent(t, { ...opts, pointerType: "mouse" })); }
      catch { el.dispatchEvent(new MouseEvent(t, opts)); }
    });
  }
  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, "value")
              || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    desc?.set?.call(el, value);
  }
  async function waitFor(fn, timeoutMs, errMsg) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const v = fn();
      if (v) return v;
      await sleep(150);
    }
    throw new Error(errMsg || "waitFor timed out");
  }

  const out = { wanted, steps: [], filteredOptions: [], menuItemsAfterMore: [], menuItemsAfterExport: [], dialogButtons: [], downloadFired: null, trace, error: null };

  try {
    // STEP 1: find slicer
    const slicer = [...document.querySelectorAll('[role="combobox"]')]
      .find((c) => /^Store$/i.test(c.getAttribute("aria-label") || ""));
    if (!slicer) throw new Error("Store slicer not found");
    out.steps.push("found slicer");
    log("slicer rect:", slicer.getBoundingClientRect());

    // STEP 2: open slicer
    fireClick(slicer);
    await sleep(500);
    out.steps.push("clicked slicer (open)");

    // STEP 3: find slicer's OWN search input — exclude page-level "Global search"
    const inputs = [...document.querySelectorAll(
      'input[placeholder="Search"], input[aria-label="Search"], input[type="search"]'
    )];
    log("inputs scanned:", inputs.length, "labels:", inputs.map((i) => `[${i.offsetParent !== null ? "vis" : "hid"} | aria=${JSON.stringify(i.getAttribute("aria-label"))}]`).join(" "));
    const search = inputs.find((el) => {
      if (el.offsetParent === null) return false;
      const lbl = (el.getAttribute("aria-label") || "").toLowerCase();
      return lbl !== "global search";
    });
    if (!search) throw new Error("Slicer's search input not found (after excluding 'Global search')");
    out.steps.push(`picked search input aria-label=${JSON.stringify(search.getAttribute("aria-label"))}`);

    // STEP 4: type
    setNativeValue(search, String(wanted));
    search.dispatchEvent(new Event("input", { bubbles: true }));
    search.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(900);
    out.steps.push(`typed "${wanted}" into slicer search`);

    // STEP 5: dump filtered options
    out.filteredOptions = [...document.querySelectorAll('[role="option"], [role="listitem"], .slicerItemContainer')]
      .filter((o) => o.offsetParent !== null)
      .map((o) => ({ text: norm(o.textContent), ariaSelected: o.getAttribute("aria-selected") }));
    out.steps.push(`filtered options: ${out.filteredOptions.length}`);

    // STEP 6: match + click
    const padded = String(wanted).padStart(4, "0");
    const wordRe = new RegExp(`(^|\\D)0*${wanted}(\\D|$)`);
    const opt = (() => {
      const visible = [...document.querySelectorAll('[role="option"], [role="listitem"], .slicerItemContainer')]
        .filter((o) => o.offsetParent !== null);
      return visible.find((o) => norm(o.textContent) === String(wanted))
          || visible.find((o) => norm(o.textContent) === padded)
          || visible.find((o) => wordRe.test(norm(o.textContent)))
          || (visible.length === 1 ? visible[0] : null);
    })();
    if (!opt) {
      out.error = `Store option "${wanted}" not found after filter. Visible: ${out.filteredOptions.map((o) => o.text).join(", ")}`;
      return out;
    }
    out.steps.push(`matched option text=${JSON.stringify(norm(opt.textContent))}`);
    fireClick(opt);
    const cb = opt.querySelector('input[type="checkbox"], [role="checkbox"], [role="radio"]');
    if (cb && cb !== opt) { fireClick(cb); out.steps.push("clicked inner radio/checkbox too"); }
    await sleep(300);
    document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    await sleep(200);
    out.steps.push("closed slicer (Esc)");

    // STEP 7: wait for visuals to refresh
    let sawLoading = false;
    const deadline = Date.now() + 20_000;
    await sleep(300);
    while (Date.now() < deadline) {
      const loading = !!document.querySelector('[aria-label="Visuals are loading..."], [aria-label="Loading"]');
      if (loading) sawLoading = true;
      else if (sawLoading) break;
      await sleep(200);
    }
    out.steps.push(`waitForVisualsRefresh done (sawLoading=${sawLoading})`);

    // STEP 8: find data grid + its More options button
    const grid = [...document.querySelectorAll(".visualContainer")]
      .find((v) => v.querySelector('[role="grid"]'));
    if (!grid) throw new Error("Data grid not found");
    hover(grid);
    await sleep(300);
    const gr = grid.getBoundingClientRect();
    const moreBtn = [...document.querySelectorAll('button[aria-label="More options"], button[title="More options"]')]
      .filter((b) => b.offsetParent !== null)
      .find((b) => {
        const r = b.getBoundingClientRect();
        return r.x >= gr.x - 5 && r.x <= gr.x + gr.width + 5 && r.y >= gr.y - 30 && r.y <= gr.y + 60;
      });
    if (!moreBtn) throw new Error("Grid 'More options' button not found");
    fireClick(moreBtn);
    await sleep(500);
    out.steps.push("clicked More options on data grid");

    const visibleMenu = () =>
      [...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], button, .menu-item, .menu-link')]
        .filter((i) => i.offsetParent !== null);
    const itemText = (el) => (el.textContent || "").replace(/\s+/g, " ").trim();

    out.menuItemsAfterMore = visibleMenu().slice(0, 25).map((i) => itemText(i)).filter(Boolean);
    out.steps.push(`menu items visible: ${out.menuItemsAfterMore.length}`);

    // STEP 9: click Export / Export data
    const exportItem = visibleMenu().find((i) => /^export\s+data$/i.test(itemText(i)))
                    || visibleMenu().find((i) => /^export$/i.test(itemText(i)))
                    || visibleMenu().find((i) => /\bexport\b/i.test(itemText(i)));
    if (!exportItem) throw new Error("Export menu item not found");
    out.steps.push(`clicking export item: ${JSON.stringify(itemText(exportItem))}`);
    fireClick(exportItem);
    await sleep(900);

    // STEP 10: snapshot what appeared (dialog OR submenu)
    out.menuItemsAfterExport = visibleMenu().slice(0, 25).map((i) => itemText(i)).filter(Boolean);

    const dialog = document.querySelector('[role="dialog"], .pbi-modal, .ms-Dialog');
    if (dialog) {
      out.steps.push("dialog appeared directly");
      out.dialogButtons = [...dialog.querySelectorAll("button")]
        .filter((b) => b.offsetParent !== null)
        .map((b) => ({ text: itemText(b), disabled: b.disabled }));
    } else {
      out.steps.push("no dialog yet — looking for submenu items");
      // look for excel/xlsx/data submenu pick
      const submenuPick = visibleMenu().find((i) => {
        const t = itemText(i);
        return /excel|\.xlsx|^xlsx$/i.test(t) || /^data(\s+with.*layout)?$/i.test(t);
      });
      if (submenuPick) {
        out.steps.push(`clicking submenu pick: ${JSON.stringify(itemText(submenuPick))}`);
        fireClick(submenuPick);
        await sleep(800);
        const dialog2 = document.querySelector('[role="dialog"], .pbi-modal, .ms-Dialog');
        if (dialog2) {
          out.steps.push("dialog appeared after submenu pick");
          out.dialogButtons = [...dialog2.querySelectorAll("button")]
            .filter((b) => b.offsetParent !== null)
            .map((b) => ({ text: itemText(b), disabled: b.disabled }));
        } else {
          out.error = "No dialog after submenu pick either. Visible menu now: " +
            visibleMenu().slice(0, 15).map((i) => JSON.stringify(itemText(i))).join(", ");
          return out;
        }
      } else {
        out.error = "No dialog and no submenu Excel pick. Visible items: " +
          out.menuItemsAfterExport.slice(0, 15).map((t) => JSON.stringify(t)).join(", ");
        return out;
      }
    }

  } catch (e) {
    out.error = `${e?.message || e}\n${e?.stack || ""}`;
  }
  return out;
}, STORE);

writeFileSync("digitallocks-fullflow-probe.json", JSON.stringify(result, null, 2));

console.log("\n========== STEPS ==========");
for (const s of result.steps) console.log(`  • ${s}`);
console.log("\n========== FILTERED OPTIONS ==========");
for (const o of result.filteredOptions) console.log(`  ${JSON.stringify(o.text)}  selected=${o.ariaSelected}`);
console.log("\n========== MENU after More options ==========");
for (const t of result.menuItemsAfterMore) console.log(`  ${JSON.stringify(t)}`);
console.log("\n========== MENU after Export click ==========");
for (const t of result.menuItemsAfterExport) console.log(`  ${JSON.stringify(t)}`);
console.log("\n========== DIALOG BUTTONS ==========");
for (const b of result.dialogButtons) console.log(`  ${JSON.stringify(b.text)}  disabled=${b.disabled}`);
console.log("\n========== TRACE ==========");
for (const t of result.trace) console.log(`  ${t}`);
if (result.error) console.error(`\n✗ ERROR: ${result.error}`);
console.log("\nFull detail: digitallocks-fullflow-probe.json");

browser.disconnect();
process.exit(0);
