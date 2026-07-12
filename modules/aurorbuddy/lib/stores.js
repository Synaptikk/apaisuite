// lib/stores.js — Nearby Walmart store lookup (browser version)
// ────────────────────────────────────────────────────────────────────────────
// Port of pipeline/store_lookup.py. Walmart's store-finder page is
// JS-rendered, so a raw service-worker fetch() only sees the pre-JS HTML
// skeleton (no store cards). We need a real browser to run the Walmart JS.
//
// Strategy (mirrors what the Python tool does with Playwright over CDP):
//   1. Fetch walmart.com/store/<num> directly — __NEXT_DATA__ in the initial
//      HTML has the home store's zip + city + state.
//   2. Open walmart.com/store/finder?location=<zip> in a BACKGROUND tab,
//      wait for the SPA to render the store cards, then inject a content
//      script that reads document.body.innerText. Close the tab.
//   3. Parse the text with the same line-by-line logic as pipeline/stores.py
//      parse_stores_from_text, including the `auror_site` string that Auror's
//      siteTraits filter actually matches against.
//
// `auror_site` format is load-bearing — Auror's index keys on
//   SITE: WALMART <num> - <STREET>, <CITY>, <ST>
// Any deviation returns zero results, which is what the first cut of the
// extension was hitting.

const STORE_PAGE    = (num) => `https://www.walmart.com/store/${num}`;
const FINDER_PAGE   = (zip) => `https://www.walmart.com/store/finder?location=${encodeURIComponent(zip)}`;
const RENDER_DEADLINE_MS = 10_000;   // how long to wait for Walmart JS to render store cards
const RENDER_POLL_MS     = 400;

// ─── Public entry point ─────────────────────────────────────────────────────

export async function findNearbyStores(homeStoreNum, miles = 20) {
  // Race the whole lookup against a 45s overall budget — two tab creates
  // plus a polling loop should be done well under that. When it hangs
  // (Walmart is slow, the tab errors, an extension permission is stale),
  // we want a clear error surfaced to the UI, not a frozen 'Finding
  // stores…' line.
  return await withTimeout(
    (async () => {
      const info = await fetchStoreInfo(homeStoreNum);
      if (!info?.zip) {
        throw new Error(`Could not determine ZIP for store #${homeStoreNum}. Walmart may have changed the store page.`);
      }
      const stores = await scrapeFinderInTab(info.zip, miles);
      if (!stores.length) {
        throw new Error(`Walmart store finder returned no results for zip ${info.zip}.`);
      }
      return { stores, city: info.city, state: info.state, zip: info.zip, home: String(homeStoreNum) };
    })(),
    45_000,
    "Timed out (45s) finding stores. Check the extension's service-worker console for errors; Walmart may be slow or may have changed their page layout."
  );
}

// Helper: reject a promise if it doesn't settle within `ms`.
async function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// ─── Step 1: zip from store detail page (static HTML, works via fetch) ──────

async function fetchStoreInfo(num) {
  // Mirror pipeline/store_lookup.py: navigate the page in a real tab so the
  // Next.js hydration completes before we read __NEXT_DATA__. The raw HTTP
  // response is enough for the zip (it's in the canonical metadata), but
  // city/state sometimes only appear after client-side hydration. Going
  // through a tab removes the guesswork AND avoids tripping the bot-
  // detection path Walmart serves to unauthenticated fetch() calls.
  const tab = await chrome.tabs.create({ url: STORE_PAGE(num), active: false });
  try {
    await waitForTabLoad(tab.id);
    // Pull the __NEXT_DATA__ contents from the rendered DOM.
    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const el = document.getElementById("__NEXT_DATA__");
        return el ? el.textContent : "";
      }
    });
    const blob = result?.[0]?.result ?? "";
    if (!blob) return null;

    // Regexes are copied verbatim from pipeline/store_lookup.py
    // _parse_zip_from_html — keep them in sync with the Python side to
    // avoid cross-engine drift.
    const zip   = blob.match(/"postalCode"\s*:\s*"(\d{5})"/)?.[1] ?? "";
    const city  = blob.match(/"addressLocality"\s*:\s*"([^"]+)"/)?.[1] ?? "";
    const state = blob.match(/"addressRegion"\s*:\s*"([A-Z]{2})"/)?.[1] ?? "";
    return zip ? { zip, city, state } : null;
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// ─── Step 2: open finder in a tab, wait for JS render, scrape text ──────────

async function scrapeFinderInTab(zip, miles) {
  // Open as a background tab in the current window — visible in the tab
  // strip but doesn't steal focus. Cheapest option that lets Walmart's JS
  // run. We close the tab before returning so it's only open for 5-10 s.
  const tab = await chrome.tabs.create({ url: FINDER_PAGE(zip), active: false });
  try {
    await waitForTabLoad(tab.id);

    // Poll the rendered DOM via scripting.executeScript. Walmart's finder
    // shows store cards after hydration — look for distance strings
    // ("N miles away") or store type markers as a readiness signal.
    const deadline = Date.now() + RENDER_DEADLINE_MS;
    let text = "";
    let matched = false;
    while (Date.now() < deadline) {
      text = await readBodyText(tab.id).catch(() => "");
      if (/(miles? away|Walmart Supercenter|Neighborhood Market)/i.test(text)) {
        matched = true;
        break;
      }
      await new Promise(r => setTimeout(r, RENDER_POLL_MS));
    }
    const parsed = parseFinderText(text, miles);
    // Diagnostic: zero results is almost always a Walmart-side layout
    // change or a CAPTCHA/bot-detection page. Dump what we actually saw
    // so we can grep the SW console instead of guessing.
    if (!parsed.length) {
      console.warn(`[stores] 0 stores parsed for zip ${zip} (matched readiness regex: ${matched})`);
      console.warn(`[stores] body text length: ${text.length}`);
      console.warn(`[stores] body text (first 1200 chars):\n${text.slice(0, 1200)}`);
      // If the readiness regex never matched, the page probably never
      // hydrated — log if it looks like a robot/captcha page so the
      // user knows to sign in to walmart.com once.
      if (/robot check|are you a human|access to this page has been denied|captcha/i.test(text)) {
        console.warn(`[stores] Walmart is serving a bot-check page. Sign in to walmart.com in a normal tab to clear it.`);
      }
    }
    return parsed;
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function waitForTabLoad(tabId, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return false;
    if (t.status === "complete") return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

async function readBodyText(tabId) {
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => document.body?.innerText ?? ""
  });
  return result?.[0]?.result ?? "";
}

// ─── Step 3: line-by-line parse (mirrors pipeline/stores.py) ────────────────

// All three regexes copied VERBATIM from pipeline/stores.py — keep them in
// sync with the Python side to avoid cross-engine drift. If a store's
// address doesn't match ADDR_RE, the Python tool has the same behaviour
// (street/city/state end up empty and auror_site is useless for that row)
// — so any discrepancy is a Walmart-side change we should fix in both
// engines at once rather than guess.
const STORE_HEADER_RE = /^(Walmart Supercenter|Neighborhood Market|Walmart Neighborhood Market)\s+#(\d+)/i;
const DISTANCE_RE     = /([\d.]+)\s+miles?\s+away/i;
// From pipeline/stores.py:   r"^(.+),\s*([^,]+),\s*([A-Z]{2})\s+\d+$"
const ADDR_RE         = /^(.+),\s*([^,]+),\s*([A-Z]{2})\s+\d+$/;

function parseFinderText(raw, maxMiles) {
  const lines = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const stores = [];

  for (let i = 0; i < lines.length; i++) {
    const h = STORE_HEADER_RE.exec(lines[i]);
    if (!h) continue;
    const stype   = h[1].trim();
    const num     = h[2];
    const address = lines[i + 1] ?? "";

    let dist = null;
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      const dm = DISTANCE_RE.exec(lines[j]);
      if (dm) { dist = parseFloat(dm[1]); break; }
    }
    if (dist === null || dist > maxMiles) continue;

    const am = ADDR_RE.exec(address);
    const street = am ? am[1].trim() : address;
    const city   = am ? am[2].trim() : "";
    const state  = am ? am[3].trim() : "";

    stores.push({
      number:      num,
      store_type:  stype,
      name:        `Walmart ${num}`,
      address,
      street,
      city,
      state,
      miles:       dist,
      // Load-bearing — Auror's siteTraits index keys on this exact format.
      // Must match pipeline/stores.py build_auror_url/auror_site.
      auror_site:  `SITE: WALMART ${num} - ${street.toUpperCase()}, ${city.toUpperCase()}, ${state}`,
      // true when the address regex matched. If this is false on most/all
      // stores, Auror will match 0 suspects — the UI shows a warning + the
      // raw address so we can see what Walmart actually rendered.
      parse_ok:    !!am
    });
  }

  // Dedup by store number, keep closest, sort by distance.
  const byNum = new Map();
  for (const s of stores) {
    const prev = byNum.get(s.number);
    if (!prev || s.miles < prev.miles) byNum.set(s.number, s);
  }
  return [...byNum.values()].sort((a, b) => a.miles - b.miles);
}
