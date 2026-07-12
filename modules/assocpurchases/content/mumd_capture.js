// modules/assocpurchases/content/mumd_capture.js
//
// Content script that runs on the MUMD detail report page.
// Silently captures table data whenever the user visits the page
// (their normal navigation works; ours doesn't — so we piggyback on theirs).
//
// Stores to chrome.storage.local["assocpurchases.mumd_capture"] so the SW
// can read it without touching the tab at all.

const STORAGE_KEY = "assocpurchases.mumd_capture";

function extractTable() {
  // Headers: prefer <th>/[role='columnheader'] — confirmed via Playwright.
  let headers = Array.from(document.querySelectorAll("th, [role='columnheader']"))
    .map(th => th.innerText.trim().replace(/\s+/g, " "))
    .filter(Boolean);

  if (!headers.length) {
    headers = Array.from(document.querySelectorAll(".w_G8.w_G5, .w_G8.w_G7"))
      .map(b => b.innerText.trim()).filter(Boolean);
  }

  // Data table: pick the one with the most rows.
  const tables = Array.from(document.querySelectorAll("table"));
  if (!tables.length) return null;

  const bigTable = tables.reduce(
    (best, t) => t.rows.length > (best?.rows.length ?? 0) ? t : best, null
  );
  if (!bigTable || bigTable.rows.length <= 1) return null;

  const rows = Array.from(bigTable.rows)
    .slice(1)
    .map(r => Array.from(r.cells).map(c => c.innerText.trim()))
    .filter(r => r.some(c => c));

  if (!rows.length) return null;

  // Capture the "Selected Filters" chips so we know what store/dates this covers.
  const filterText = Array.from(
    document.querySelectorAll('[class*="selected-filter"], [class*="filter-chip"], [class*="filter-tag"]')
  ).map(el => el.innerText.trim()).filter(Boolean);

  // Also read the disabled filter inputs directly as a fallback.
  const filterInputs = {};
  const allInputs = Array.from(document.querySelectorAll("input[disabled], select[disabled]"));
  allInputs.forEach(el => {
    const label = el.closest("[class]")?.querySelector("[class*='label'], [class*='title'], p, span")?.innerText?.trim();
    if (label && el.value) filterInputs[label] = el.value;
  });

  return {
    headers,
    rows,
    rowCount: rows.length,
    filterText,
    filterInputs,
    pageUrl:    location.href,
    capturedAt: Date.now(),
  };
}

// Debounced save — DOM mutations can fire many times during a single data load.
let _saveTimer = null;
function scheduleSave() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    const data = extractTable();
    if (data) {
      chrome.storage.local.set({ [STORAGE_KEY]: data });
      console.log(`[assocpurchases] MUMD captured: ${data.rowCount} rows, filters:`, data.filterText);
    }
  }, 800);
}

// Poll until we have data (handles async data loading after page mount).
let _pollAttempts = 0;
const MAX_POLL_ATTEMPTS = 60;   // 60 × 1s = 60s max wait

function poll() {
  _pollAttempts++;
  const data = extractTable();
  if (data) {
    chrome.storage.local.set({ [STORAGE_KEY]: data });
    console.log(`[assocpurchases] MUMD captured on poll ${_pollAttempts}: ${data.rowCount} rows`);

    // Now set up mutation observer to re-capture if filters change.
    const main = document.querySelector("main, [role='main'], .main");
    if (main) {
      new MutationObserver(scheduleSave).observe(main, { childList: true, subtree: true });
    }
    return;
  }
  if (_pollAttempts < MAX_POLL_ATTEMPTS) {
    setTimeout(poll, 1000);
  } else {
    console.warn("[assocpurchases] MUMD capture: no data after 60s — page may have an error");
  }
}

// Start after the page has had a moment to begin rendering.
setTimeout(poll, 1500);
