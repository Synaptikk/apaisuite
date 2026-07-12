// dev/probe-digitallocks-slicer.mjs
//
// Connect to a running Edge (launched with --remote-debugging-port=9222),
// find the digitallocks Power BI report tab, open the Store slicer, type a
// store number, and dump *exactly* what the page renders so we can see why
// the driver's matcher misses.
//
// Setup:
//   1. cd dev && npm install     (one-time, installs puppeteer-core)
//   2. ./launch-edge-debug.sh    (relaunches Edge on port 9222 with your profile)
//   3. Open the Power BI report tab in Edge and sign in to SSO if needed.
//   4. node probe-digitallocks-slicer.mjs [storeNumber]   (default 1458)
//
// Output: console dump + dev/digitallocks-slicer-probe.json with full detail.

import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";

const BROWSER_URL = process.env.EDGE_CDP_URL || "http://localhost:9222";
const STORE = (process.argv[2] || "1458").trim();
const REPORT_HOST_FILTER = /app\.powerbi\.com\/groups\/me\/reports\/a118e7e7-/;
const OUT_FILE = "digitallocks-slicer-probe.json";

console.log(`→ connecting to ${BROWSER_URL}…`);
let browser;
try {
  browser = await puppeteer.connect({ browserURL: BROWSER_URL, defaultViewport: null });
} catch (e) {
  console.error(`✗ Could not connect. Did you run launch-edge-debug.sh ?`);
  console.error(`  ${e.message}`);
  process.exit(1);
}

// ── Find the Power BI tab ──────────────────────────────────────────────
const pages = await browser.pages();
const target = pages.find((p) => REPORT_HOST_FILTER.test(p.url()));
if (!target) {
  console.error(`✗ No tab matches ${REPORT_HOST_FILTER}.`);
  console.error(`  Open the digitallocks Power BI report in Edge and sign in, then re-run.`);
  console.error(`  Tabs currently open:`);
  for (const p of pages) console.error(`    ${p.url()}`);
  browser.disconnect();
  process.exit(1);
}
console.log(`✓ Found Power BI tab: ${target.url()}`);

// ── Probe ──────────────────────────────────────────────────────────────
// All DOM work happens inside the page. We export one big function that runs
// in the page context so we don't pay puppeteer roundtrip cost per selector.

const probe = await target.evaluate(async (wanted) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
  const log = [];
  const out = {
    href: location.href,
    iframes: [],
    slicerFound: false,
    searchInputs: [],
    optionsBeforeType: [],
    optionsAfterType: [],
    sampleOptionDom: null,
    typedInto: null,
    error: null,
    log,
  };

  try {
    // 0. Iframe inventory — Power BI sometimes nests reports in iframes.
    out.iframes = [...document.querySelectorAll("iframe")].map((f, i) => ({
      idx: i, src: f.src, name: f.name,
      width: f.clientWidth, height: f.clientHeight,
      sameOrigin: (() => { try { return !!f.contentDocument; } catch { return false; } })(),
    }));
    log.push(`iframes on page: ${out.iframes.length}`);

    // 1. Find the Store slicer combobox.
    const slicer = [...document.querySelectorAll('[role="combobox"]')]
      .find((c) => /^Store$/i.test(c.getAttribute("aria-label") || ""));
    if (!slicer) {
      log.push("Store slicer combobox NOT found on top frame.");
      // Try iframes (same-origin only — Power BI reports usually are).
      for (const fInfo of out.iframes) {
        if (!fInfo.sameOrigin) continue;
        const frame = document.querySelectorAll("iframe")[fInfo.idx];
        const f = frame.contentDocument;
        const c = [...f.querySelectorAll('[role="combobox"]')]
          .find((c) => /^Store$/i.test(c.getAttribute("aria-label") || ""));
        if (c) {
          log.push(`Store slicer found in iframe #${fInfo.idx} (src=${fInfo.src})`);
          out.error = `Slicer is in iframe #${fInfo.idx} — driver injection needs allFrames:true or frameIds`;
          return out;
        }
      }
      out.error = "Store slicer not found anywhere (top frame or accessible iframes)";
      return out;
    }
    out.slicerFound = true;

    // 2. Click slicer to open dropdown.
    const r = slicer.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, clientX: r.x + r.width/2, clientY: r.y + r.height/2 };
    slicer.dispatchEvent(new PointerEvent("pointerdown", { ...opts, pointerType: "mouse" }));
    slicer.dispatchEvent(new MouseEvent("mousedown", opts));
    slicer.dispatchEvent(new PointerEvent("pointerup", { ...opts, pointerType: "mouse" }));
    slicer.dispatchEvent(new MouseEvent("mouseup", opts));
    slicer.dispatchEvent(new MouseEvent("click", opts));
    if (typeof slicer.click === "function") slicer.click();
    await sleep(600);

    // 3. Inventory of EVERY search input on the page (so we know if our
    //    selector grabs the right one).
    out.searchInputs = [...document.querySelectorAll(
      'input[placeholder="Search"], input[aria-label="Search"], input[type="search"]'
    )].map((el, i) => {
      const rect = el.getBoundingClientRect();
      return {
        idx: i,
        placeholder: el.placeholder,
        ariaLabel: el.getAttribute("aria-label"),
        type: el.type,
        visible: el.offsetParent !== null,
        rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
        outerHtmlSnip: el.outerHTML.slice(0, 200),
      };
    });

    // 4. Options BEFORE typing — see the unfiltered list.
    out.optionsBeforeType = [...document.querySelectorAll('[role="option"], [role="listitem"], .slicerItemContainer')]
      .filter((o) => o.offsetParent !== null)
      .slice(0, 30)
      .map((o, i) => ({
        idx: i,
        role: o.getAttribute("role"),
        text: norm(o.textContent),
        rawText: o.textContent,
      }));
    log.push(`unfiltered visible options: ${out.optionsBeforeType.length}`);

    // 5. Capture one full option DOM so we can see the structure.
    const sampleOpt = document.querySelector('[role="option"], [role="listitem"], .slicerItemContainer');
    if (sampleOpt) out.sampleOptionDom = sampleOpt.outerHTML.slice(0, 600);

    // 6. Type into the FIRST visible search input.
    const search = out.searchInputs.find((s) => s.visible);
    if (!search) {
      out.error = "No visible search input appeared after opening the slicer.";
      return out;
    }
    const searchEl = document.querySelectorAll(
      'input[placeholder="Search"], input[aria-label="Search"], input[type="search"]'
    )[search.idx];
    const proto = Object.getPrototypeOf(searchEl);
    const desc = Object.getOwnPropertyDescriptor(proto, "value")
              || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    desc?.set?.call(searchEl, String(wanted));
    searchEl.dispatchEvent(new Event("input", { bubbles: true }));
    searchEl.dispatchEvent(new Event("change", { bubbles: true }));
    out.typedInto = { idx: search.idx, placeholder: search.placeholder, ariaLabel: search.ariaLabel };
    log.push(`typed "${wanted}" into search input #${search.idx}`);
    await sleep(900);

    // 7. Options AFTER typing — the critical data point.
    out.optionsAfterType = [...document.querySelectorAll('[role="option"], [role="listitem"], .slicerItemContainer')]
      .filter((o) => o.offsetParent !== null)
      .slice(0, 30)
      .map((o, i) => ({
        idx: i,
        role: o.getAttribute("role"),
        text: norm(o.textContent),
        rawText: o.textContent,
        ariaSelected: o.getAttribute("aria-selected"),
        ariaLabel: o.getAttribute("aria-label"),
      }));
    log.push(`filtered visible options: ${out.optionsAfterType.length}`);

  } catch (e) {
    out.error = `probe threw: ${e?.message ?? e}\n${e?.stack || ""}`;
  }

  return out;
}, STORE);

// ── Report ─────────────────────────────────────────────────────────────
writeFileSync(OUT_FILE, JSON.stringify(probe, null, 2));

console.log("\n========== PROBE RESULT ==========");
console.log(`URL:               ${probe.href}`);
console.log(`Slicer found:      ${probe.slicerFound}`);
console.log(`Iframes on page:   ${probe.iframes.length}`);
for (const f of probe.iframes) {
  console.log(`  - iframe #${f.idx}  ${f.width}x${f.height}  sameOrigin=${f.sameOrigin}  src=${f.src.slice(0, 80)}`);
}
console.log(`Search inputs:     ${probe.searchInputs.length}`);
for (const s of probe.searchInputs) {
  console.log(`  - input #${s.idx}  visible=${s.visible}  placeholder=${JSON.stringify(s.placeholder)}  aria-label=${JSON.stringify(s.ariaLabel)}`);
}
console.log(`Typed into:        ${JSON.stringify(probe.typedInto)}`);
console.log(`Unfiltered opts:   ${probe.optionsBeforeType.length}`);
for (const o of probe.optionsBeforeType.slice(0, 5)) {
  console.log(`  - [${o.idx}] role=${o.role}  text=${JSON.stringify(o.text)}`);
}
console.log(`Filtered opts (after typing "${STORE}"): ${probe.optionsAfterType.length}`);
for (const o of probe.optionsAfterType) {
  console.log(`  - [${o.idx}] role=${o.role}  text=${JSON.stringify(o.text)}  ariaSelected=${o.ariaSelected}`);
}
if (probe.sampleOptionDom) {
  console.log(`\nSample option DOM (first 600 chars):\n  ${probe.sampleOptionDom}`);
}
if (probe.error) {
  console.error(`\n✗ ERROR: ${probe.error}`);
}
console.log("\nLog:");
for (const line of probe.log) console.log(`  ${line}`);
console.log("\nFull detail written to:", OUT_FILE);

browser.disconnect();
process.exit(0);
