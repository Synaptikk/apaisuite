// modules/aurorbuddy/lib/auror_products.js
//
// Bulk-add products to an Auror event draft that is ALREADY open in a tab.
//
//   items: [{ upc: "0007874235188", qty: 1, price: 3.72, desc?: "..." }]
//
// Drives the "Products" card of the event wizard (data-locator selectors
// validated 2026-09-12 against the live form — see the selector map at the
// bottom of this file). Each UPC is typed into the product search box, the
// first *catalog* match is clicked, then quantity + unit price are set on
// the row Auror appends. The order's price overrides Auror's catalog price
// because it is the actual sale price for the transaction.
//
// The driver never clicks Next / Publish — the operator reviews first.

// ─── Public entry point (runs in the service worker) ───────────────────────

export async function fillAurorProducts(tabId, items, { onLog, receiptNumber = "" } = {}) {
  if (!Array.isArray(items) || !items.length) {
    return { status: "error", error: "no items" };
  }
  let result;
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: driveProducts,
      args: [{ items, receiptNumber }],
      world: "MAIN",
    });
    result = injection?.result;
  } catch (e) {
    return { status: "error", error: `scripting.executeScript failed: ${e.message || e}` };
  }
  if (!result) return { status: "error", error: "Driver returned no result (did the page navigate away?)" };
  for (const line of result.log || []) {
    try { onLog?.(line); } catch { /* ignore */ }
    console.log("[Auror products]", line);
  }
  if (result.error) return { status: "error", ...result };
  return { status: "filled", ...result };
}

// ─── The driver (runs inside the Auror tab — world: "MAIN") ────────────────
//
// IMPORTANT: serialised via chrome.scripting.executeScript (extension) or
// page.evaluate (dev/import-order-products.mjs over CDP), so it can't
// close over anything outside itself. All helpers are inline.

export function driveProducts({ items, receiptNumber }) {
  return (async () => {
    const log = [];
    const note = (m) => log.push(m);
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const q = (sel, root = document) => root.querySelector(sel);

    const SEARCH_SEL  = 'input[data-locator="ProductDetails-ProductEntrySearch"]';
    const MENU_SEL    = '[data-locator="ProductDetails-ProductDropdownMenu"]';
    const NAME_SEL    = '[data-locator="ProductDetails-ProductName"]';
    const QTY_SEL     = '[data-locator="ProductDetails-Quantity"]';
    const PRICE_SEL   = '[data-locator="ProductDetails-Price"]';
    const RECEIPT_SEL = 'input[data-locator="ProductDetails-TransactionNumber"]';
    const NAV_SEL     = '[data-locator="Products-Navlink"]';
    const RESULTS_WAIT_MS = 10_000;
    const ROW_WAIT_MS     = 8_000;

    const setReactValue = (el, value) => {
      const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value");
      if (desc && desc.set) desc.set.call(el, value);
      else                  el.value = value;
      el.dispatchEvent(new Event("input",  { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };
    // Downshift-style autocomplete listens for real key/InputEvents.
    const typeSlowly = async (el, text, delayMs = 25) => {
      el.focus();
      const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value");
      desc.set.call(el, "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      let cur = "";
      for (const ch of text) {
        cur += ch;
        el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }));
        desc.set.call(el, cur);
        el.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: ch, bubbles: true }));
        el.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
        await sleep(delayMs);
      }
    };
    const waitFor = async (fn, timeout, step = 150) => {
      const end = Date.now() + timeout;
      while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(step); }
      return null;
    };
    const rowEls = () => [...document.querySelectorAll(NAME_SEL)].map(n => n.closest('[class*="list-group-item"]'));
    // The dropdown renders "Create new product: <typed>" instantly, then the
    // catalog matches arrive async under a "Showing N out of M results"
    // header. Never pick the create-new option.
    const isCreate = (o) => /^create new product/i.test(o.textContent.trim());
    const realOpts = () => [...document.querySelectorAll(MENU_SEL + " [role=option]")].filter(o => !isCreate(o));

    try {
      let search = q(SEARCH_SEL);
      if (!search) {
        const nav = q(NAV_SEL);
        if (nav) { nav.click(); note("Products nav → click"); }
        search = await waitFor(() => q(SEARCH_SEL), RESULTS_WAIT_MS);
        if (!search) throw new Error("Products step not reachable (no search input)");
        await sleep(600);
      }

      const added = [], missed = [], failed = [];
      for (const it of items) {
        const upc = String(it.upc || "").trim();
        if (!upc) continue;
        try {
          const before = new Set(rowEls());
          await typeSlowly(search, upc);
          await waitFor(() => {
            const m = q(MENU_SEL);
            if (!m) return null;
            if (realOpts().length) return m;
            if (/showing \d+ out of \d+|no (results|products|matches)/i.test(m.textContent)) return m;
            return null;
          }, RESULTS_WAIT_MS);
          await sleep(400); // let the full result list settle
          const opt = realOpts()[0];
          if (!opt) {
            missed.push({ upc, desc: it.desc || "" });
            note(`MISS ${upc} ${it.desc || ""}`);
            setReactValue(search, "");
            search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            await sleep(300);
            continue;
          }
          const chosen = opt.textContent.trim().slice(0, 90);
          opt.click();
          const row = await waitFor(() => rowEls().find(r => !before.has(r)), ROW_WAIT_MS);
          if (!row) {
            failed.push({ upc, desc: it.desc || "", why: "row did not appear" });
            note(`FAIL ${upc} row did not appear`);
            continue;
          }
          await sleep(250);
          const qty   = q(QTY_SEL, row);
          const price = q(PRICE_SEL, row);
          if (qty && it.qty != null)     { qty.focus();   setReactValue(qty,   String(it.qty));              qty.blur(); }
          if (price && it.price != null) { price.focus(); setReactValue(price, Number(it.price).toFixed(2)); price.blur(); }
          await sleep(200);
          added.push({ upc, chosen, qty: qty && qty.value, price: price && price.value });
          note(`OK ${upc} → ${chosen}`);
        } catch (e) {
          failed.push({ upc, desc: it.desc || "", why: String(e && e.message || e) });
          note(`FAIL ${upc} ${e && e.message}`);
        }
        await sleep(300);
      }

      if (receiptNumber) {
        const txn = q(RECEIPT_SEL);
        if (txn && !txn.value) {
          txn.focus(); setReactValue(txn, String(receiptNumber)); txn.blur();
          note("receipt number set");
        }
      }
      return { url: location.href, log, added, missed, failed, rowsNow: rowEls().length };
    } catch (err) {
      return { error: String(err && err.message || err), url: location.href, log };
    }
  })();
}

// ─── Selector map (validated 2026-09-12 against the live Products card) ────
//
//   Products-Navlink                   wizard nav → Products step
//   ProductDetails-ProductEntrySearch  search input (name / barcode / SKU)
//   ProductDetails-ProductDropdownMenu Downshift menu; [role=option] rows;
//                                      first row is "Create new product: …"
//                                      until catalog results replace it
//   ProductDetails-ProductName         disabled name cell on an added row
//   ProductDetails-Category            category autocomplete (auto-filled)
//   ProductDetails-ProductRecovery     <select> NotRecovered|Recovered|RecoveredButDamaged
//   ProductDetails-Price               unit price, inputmode=decimal
//   ProductDetails-Quantity            quantity, inputmode=decimal
//   ProductDetails-Subtotal            computed
//   ProductDetails-Remove              per-row remove
//   ProductDetails-TransactionNumber   optional receipt/transaction number
//   Products-Next                      advances the wizard (never clicked here)
//
// A 13-digit zero-padded Walmart UPC (as printed on OPD order sheets) matches
// Auror's barcode index directly; many barcodes map to several SKUs, and the
// first match is taken.
