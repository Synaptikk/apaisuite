// dev/probe-digitallocks-flow-no-open.mjs
// Run the slicer-filter + click + export flow without first clicking the
// combobox (which collapses a list-style slicer). Uses the current
// always-visible Search input. Tells us whether the rest of the driver
// pipeline works once we stop fighting the slicer.

import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";

const STORE = (process.argv[2] || "1458").trim();
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const pages = await browser.pages();
const target = pages.find((p) => /app\.powerbi\.com\/groups\/me\/reports\/a118e7e7-/.test(p.url()));
if (!target) { console.error("✗ no PBI tab"); browser.disconnect(); process.exit(1); }
await target.bringToFront();
await new Promise(r => setTimeout(r, 400));

target.on("console", (msg) => {
  const t = msg.text();
  if (/digital|slicer|pbi/i.test(t)) console.log(`  PAGE> [${msg.type()}] ${t}`);
});

const result = await target.evaluate(async (wanted) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
  const out = { steps: [], filteredOptions: [], menuItemsAfterMore: [], menuItemsAfterExport: [], dialogButtons: [], error: null };

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

  try {
    // STEP 1: pick the slicer's already-visible Search input directly.
    const search = [...document.querySelectorAll(
      'input[placeholder="Search"], input[aria-label="Search"], input[type="search"]'
    )].find((el) => {
      if (el.offsetParent === null) return false;
      const lbl = (el.getAttribute("aria-label") || "").toLowerCase();
      return lbl !== "global search";
    });
    if (!search) throw new Error("No visible slicer Search input");
    out.steps.push(`picked search input at ${JSON.stringify(search.getBoundingClientRect())}`);

    // STEP 2: clear any existing value, type wanted store.
    search.focus();
    setNativeValue(search, "");
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(200);
    setNativeValue(search, String(wanted));
    search.dispatchEvent(new Event("input", { bubbles: true }));
    search.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(1200);
    out.steps.push(`typed "${wanted}"`);

    // STEP 3: dump filtered options
    out.filteredOptions = [...document.querySelectorAll('.slicerItemContainer')]
      .filter((o) => o.offsetParent !== null)
      .map((o) => ({ text: norm(o.textContent), ariaSelected: o.getAttribute("aria-selected") }));
    out.steps.push(`filtered options after typing: ${out.filteredOptions.length}`);

    // STEP 4: match + click
    const padded = String(wanted).padStart(4, "0");
    const wordRe = new RegExp(`(^|\\D)0*${wanted}(\\D|$)`);
    const visible = [...document.querySelectorAll('.slicerItemContainer')]
      .filter((o) => o.offsetParent !== null);
    const opt = visible.find((o) => norm(o.textContent) === String(wanted))
             || visible.find((o) => norm(o.textContent) === padded)
             || visible.find((o) => wordRe.test(norm(o.textContent)))
             || (visible.length === 1 ? visible[0] : null);
    if (!opt) {
      out.error = `Match failed. Visible: ${out.filteredOptions.map((o) => o.text).join(", ")}`;
      return out;
    }
    out.steps.push(`matched option: "${norm(opt.textContent)}"`);
    fireClick(opt);
    await sleep(500);

    // STEP 5: wait for visuals refresh (loading indicator)
    let sawLoading = false;
    const deadline = Date.now() + 25_000;
    await sleep(300);
    while (Date.now() < deadline) {
      const loading = !!document.querySelector('[aria-label="Visuals are loading..."], [aria-label="Loading"]');
      if (loading) sawLoading = true;
      else if (sawLoading) break;
      await sleep(200);
    }
    out.steps.push(`visuals refresh done (sawLoading=${sawLoading})`);

    // STEP 6: find data grid
    const grid = [...document.querySelectorAll(".visualContainer")]
      .find((v) => v.querySelector('[role="grid"]'));
    if (!grid) throw new Error("Data grid visual not found");
    out.steps.push(`found data grid at ${JSON.stringify(grid.getBoundingClientRect())}`);
    hover(grid);
    await sleep(400);

    // STEP 7: more options button near grid
    const gr = grid.getBoundingClientRect();
    const moreBtn = [...document.querySelectorAll('button[aria-label="More options"], button[title="More options"]')]
      .filter((b) => b.offsetParent !== null)
      .find((b) => {
        const r = b.getBoundingClientRect();
        return r.x >= gr.x - 5 && r.x <= gr.x + gr.width + 5 && r.y >= gr.y - 30 && r.y <= gr.y + 60;
      });
    if (!moreBtn) {
      // dump all visible more options buttons for diagnosis
      const all = [...document.querySelectorAll('button[aria-label="More options"], button[title="More options"]')]
        .filter((b) => b.offsetParent !== null)
        .map((b) => ({ aria: b.getAttribute("aria-label"), rect: b.getBoundingClientRect() }));
      throw new Error("Grid More options button not near grid. Found these buttons: " + JSON.stringify(all));
    }
    fireClick(moreBtn);
    await sleep(600);
    out.steps.push("clicked More options");

    const visibleMenu = () =>
      [...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], button, .menu-item, .menu-link')]
        .filter((i) => i.offsetParent !== null);
    const itemText = (el) => (el.textContent || "").replace(/\s+/g, " ").trim();

    out.menuItemsAfterMore = visibleMenu()
      .filter((i) => itemText(i).length && itemText(i).length < 60)
      .slice(0, 25).map((i) => itemText(i));

    // STEP 8: click Export
    const exportItem = visibleMenu().find((i) => /^export\s+data$/i.test(itemText(i)))
                    || visibleMenu().find((i) => /^export$/i.test(itemText(i)))
                    || visibleMenu().find((i) => /\bexport\b/i.test(itemText(i)));
    if (!exportItem) {
      out.error = "No Export item in menu";
      return out;
    }
    out.steps.push(`clicking export item: "${itemText(exportItem)}"`);
    fireClick(exportItem);
    await sleep(1100);

    // STEP 9: capture what appeared
    out.menuItemsAfterExport = visibleMenu()
      .filter((i) => itemText(i).length && itemText(i).length < 60)
      .slice(0, 25).map((i) => itemText(i));

    const dialog = document.querySelector('[role="dialog"], .pbi-modal, .ms-Dialog');
    if (dialog) {
      out.steps.push("dialog visible");
      out.dialogButtons = [...dialog.querySelectorAll("button")]
        .filter((b) => b.offsetParent !== null)
        .map((b) => ({ text: itemText(b), disabled: b.disabled }));
    } else {
      // Look for submenu Excel / .xlsx / Data choice
      const submenuPick = visibleMenu().find((i) => {
        const t = itemText(i);
        return /excel|\.xlsx|^xlsx$/i.test(t) || /^data(\s+with.*layout)?$/i.test(t);
      });
      if (submenuPick) {
        out.steps.push(`clicking submenu pick: "${itemText(submenuPick)}"`);
        fireClick(submenuPick);
        await sleep(1100);
        const d2 = document.querySelector('[role="dialog"], .pbi-modal, .ms-Dialog');
        if (d2) {
          out.steps.push("dialog visible after submenu");
          out.dialogButtons = [...d2.querySelectorAll("button")]
            .filter((b) => b.offsetParent !== null)
            .map((b) => ({ text: itemText(b), disabled: b.disabled }));
        } else {
          out.error = "Still no dialog after submenu pick. menu: " +
            visibleMenu().slice(0, 15).map((i) => JSON.stringify(itemText(i))).join(", ");
        }
      } else {
        out.error = "No dialog, no submenu Excel pick.";
      }
    }
  } catch (e) {
    out.error = `${e?.message || e}`;
  }
  return out;
}, STORE);

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
if (result.error) console.error(`\n✗ ERROR: ${result.error}`);

await target.screenshot({ path: "digitallocks-flow-no-open.png", fullPage: false });
console.log("\nScreenshot: digitallocks-flow-no-open.png");
writeFileSync("digitallocks-flow-no-open.json", JSON.stringify(result, null, 2));
browser.disconnect();
process.exit(0);
