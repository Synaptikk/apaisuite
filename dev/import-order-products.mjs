// dev/import-order-products.mjs
//
// Spark/OPD driver-theft helper: read a Walmart OPD order sheet PDF
// (order_<number>.pdf) and bulk-add every line item — UPC, quantity, sale
// price — to the Auror event draft that is open in the debug Edge.
//
//   node dev/import-order-products.mjs --pdf="C:\Users\me\Downloads\order_200015429126511.pdf"
//   node dev/import-order-products.mjs --pdf=... --dry-run          # parse only, print the rows
//   node dev/import-order-products.mjs --pdf=... --include-cancelled
//   node dev/import-order-products.mjs --pdf=... --event=https://app.us.auror.co/event/edit/draft/<id>
//
// Prerequisites
//   1. ./dev/launch-edge-debug.sh   (debug Edge on port 9222, SSO done once)
//   2. In that Edge, open the Auror event draft. The Products step is
//      reached automatically; the wizard's Next / Publish are never clicked.
//
// Row selection (default): rows whose Status is "Driver Return Initiated"
// and whose price is > 0. That drops the $0 BAG line and rows that were
// cancelled/substituted before the driver ever had them. --include-cancelled
// keeps the cancelled rows; --all keeps everything including the bag.
//
// The DOM driver is the SAME function the extension uses
// (modules/aurorbuddy/lib/auror_products.js::driveProducts), evaluated in
// the page over CDP, so selectors live in exactly one place.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import puppeteer from "puppeteer-core";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { driveProducts } from "../modules/aurorbuddy/lib/auror_products.js";

const arg = (n, d = null) => {
  const a = process.argv.find((x) => x === `--${n}` || x.startsWith(`--${n}=`));
  if (!a) return d;
  return a.includes("=") ? a.split("=").slice(1).join("=") : true;
};
const PDF        = arg("pdf");
const DRY        = !!arg("dry-run");
const INC_CANC   = !!arg("include-cancelled");
const ALL        = !!arg("all");
const PORT       = arg("port", "9222");
const EVENT_URL  = arg("event");
const RECEIPT    = arg("receipt");           // override; default = order number from the PDF
const NO_RECEIPT = !!arg("no-receipt");
const CHUNK      = Number(arg("chunk", "15")); // items per page.evaluate round-trip

if (!PDF) {
  console.error("usage: node dev/import-order-products.mjs --pdf=<order.pdf> [--dry-run] [--include-cancelled] [--all] [--event=<url>] [--port=9222]");
  process.exit(2);
}

// ─── 1. Parse the order sheet ───────────────────────────────────────────────
//
// The sheet is a table repeated per page. pdfjs gives every text fragment
// with its x/y, so rows are recovered geometrically instead of from the
// (badly interleaved) plain-text order:
//   · the header row fixes the column x-positions (UPC, Item Description,
//     Qu(antity), Price/Item, Status, Access Type),
//   · every 12–13-digit token in the UPC column starts a row,
//   · a row owns all fragments between its own baseline and the next row's,
//   · description / status are the fragments in their column, read top-down.

async function parseOrderPdf(path) {
  const data = new Uint8Array(readFileSync(path));
  const doc  = await getDocument({ data, useSystemFonts: true, disableFontFace: true, verbosity: 0 }).promise;
  const rows = [];
  let orderNumber = null;
  for (let p = 1; p <= doc.numPages; p++) {
    const page  = await doc.getPage(p);
    const tc    = await page.getTextContent();
    const items = tc.items
      .filter((it) => it.str && it.str.trim())
      .map((it) => ({ s: it.str.trim(), x: it.transform[4], y: it.transform[5] }));
    const text = items.map((i) => i.s).join(" ");
    orderNumber ||= (text.match(/Order Number\s*:\s*(\d+)/) || [])[1] || null;

    const col = (label) => items.find((i) => i.s === label);
    const hUPC = col("UPC"), hDesc = col("Item Description"), hQty = col("Qu"),
          hPrice = col("Price/Item"), hStatus = col("Status"), hAccess = col("Access Type"), hSub = col("Sub");
    if (!hUPC || !hDesc || !hQty || !hPrice || !hStatus || !hAccess) continue; // not a table page
    const headerY = hUPC.y;

    const starts = items
      .filter((i) => /^\d{12,13}$/.test(i.s) && Math.abs(i.x - hUPC.x) < 12 && i.y < headerY)
      .sort((a, b) => b.y - a.y); // top of page first (pdf y grows upward)

    starts.forEach((st, idx) => {
      const top    = st.y + 3;
      const bottom = idx + 1 < starts.length ? starts[idx + 1].y + 3 : -Infinity;
      const inRow  = items.filter((i) => i.y <= top && i.y > bottom);
      const inCol  = (x0, x1) => inRow.filter((i) => i.x >= x0 - 2 && i.x < x1 - 2).sort((a, b) => (b.y - a.y) || (a.x - b.x));
      const join   = (arr) => arr.map((i) => i.s).join(" ").replace(/\s+/g, " ").trim();
      const desc   = join(inCol(hDesc.x, (hSub || hQty).x));
      const qtyS   = join(inCol(hQty.x, hPrice.x));
      const priceS = join(inCol(hPrice.x, hStatus.x));
      const status = join(inCol(hStatus.x, hAccess.x));
      rows.push({
        upc: st.s, desc, status,
        qty:   Number((qtyS.match(/\d+/) || [NaN])[0]),
        price: Number((priceS.match(/[\d.]+/) || [NaN])[0]),
        page: p,
      });
    });
  }
  return { orderNumber, rows };
}

// ─── 2. Choose rows ─────────────────────────────────────────────────────────

function selectRows(rows) {
  return rows.filter((r) => {
    if (!Number.isFinite(r.qty) || !Number.isFinite(r.price)) return false;
    if (ALL) return true;
    if (r.price <= 0) return false;                      // BAG line etc.
    if (/driver return/i.test(r.status)) return true;
    if (INC_CANC && /cancel/i.test(r.status)) return true;
    return false;
  });
}

// ─── 3. Drive the Auror draft ───────────────────────────────────────────────

async function findEventPage(browser) {
  const pages = await browser.pages();
  const isEvent = (u) => /^https:\/\/app\.us\.auror\.co\/event\//.test(u);
  let page = pages.find((pg) => isEvent(pg.url()));
  if (!page && EVENT_URL) {
    page = await browser.newPage();
    await page.goto(EVENT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await new Promise((r) => setTimeout(r, 2_500));
  }
  return page;
}

const main = async () => {
  const { orderNumber, rows } = await parseOrderPdf(resolve(PDF));
  const items = selectRows(rows);
  const value = items.reduce((s, r) => s + r.qty * r.price, 0);
  console.log(`order ${orderNumber ?? "?"}: ${rows.length} rows parsed, ${items.length} selected, $${value.toFixed(2)} at sale price`);
  if (DRY || !items.length) {
    for (const r of rows) {
      const mark = items.includes(r) ? "+" : "-";
      console.log(`${mark} ${r.upc}  x${String(r.qty).padStart(2)}  $${r.price.toFixed(2).padStart(6)}  ${r.status.padEnd(30)}  ${r.desc}`);
    }
    if (!items.length) process.exit(1);
    return;
  }

  let browser;
  try {
    browser = await puppeteer.connect({ browserURL: `http://localhost:${PORT}`, defaultViewport: null, protocolTimeout: 600_000 });
  } catch (e) {
    console.error(`cannot reach the debug Edge on port ${PORT} (${e.message}).\nStart it with ./dev/launch-edge-debug.sh, sign in to Auror there, open the event draft, then rerun.`);
    process.exit(1);
  }
  const page = await findEventPage(browser);
  if (!page) {
    console.error("no Auror event tab is open in the debug Edge. Open the draft there (or pass --event=<draft url>) and rerun.");
    browser.disconnect(); process.exit(1);
  }
  console.log(`event tab: ${page.url()}`);

  const receipt = NO_RECEIPT ? "" : (RECEIPT || orderNumber || "");
  const totals  = { added: [], missed: [], failed: [] };
  for (let i = 0; i < items.length; i += CHUNK) {
    const chunk = items.slice(i, i + CHUNK).map(({ upc, qty, price, desc }) => ({ upc, qty, price, desc }));
    const last  = i + CHUNK >= items.length;
    const res   = await page.evaluate(driveProducts, { items: chunk, receiptNumber: last ? receipt : "" });
    if (res?.error) { console.error(`driver error: ${res.error}`); for (const l of res.log || []) console.error("  " + l); break; }
    totals.added.push(...res.added); totals.missed.push(...res.missed); totals.failed.push(...res.failed);
    console.log(`  ${Math.min(i + CHUNK, items.length)}/${items.length}  rows on page: ${res.rowsNow}`);
  }

  const weak = totals.added.filter((a) => /^\d+ \(/.test(a.chosen));
  console.log(`\nadded ${totals.added.length}, missed ${totals.missed.length}, failed ${totals.failed.length}`);
  if (totals.missed.length) { console.log("\nNOT FOUND in Auror's catalog (add by hand):"); for (const m of totals.missed) console.log(`  ${m.upc}  ${m.desc}`); }
  if (totals.failed.length) { console.log("\nFAILED:"); for (const f of totals.failed) console.log(`  ${f.upc}  ${f.desc}  (${f.why})`); }
  if (weak.length) {
    console.log(`\n${weak.length} rows matched a bare-number catalog placeholder (Auror shows the UPC as the name). Values are set; names will read as numbers:`);
    for (const w of weak) console.log(`  ${w.upc}  x${w.qty}  ${w.price}`);
  }
  console.log("\nReview the Products card in Edge, then click Next / Publish yourself.");
  browser.disconnect();
};

main().catch((e) => { console.error(e); process.exit(1); });
