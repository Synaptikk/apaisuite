// modules/doorcatch/lib/item_lookup.js
//
// UPC → item name, brand, category, picture. Runs in the service worker.
//
// Public UPC sites through the corp proxy (checked 2026-10-07): go-upc.com
// and www.upcitemdb.com product pages load; their APIs (api.upcitemdb.com,
// barcodelookup.com, upcdatabase.org) are McAfee-blocked; walmart.com search
// does not match on UPC at all. So: go-upc first, upcitemdb page as backup.
//
// Walmart price: walmart.com search by the product name, then each of the
// first few results' item pages until one carries the scanned UPC
// (product.upc); its product.priceInfo.currentPrice is the price. Reading the
// first "currentPrice" in the HTML instead picks up a related item (the DeWalt
// drill page showed $119 for a different drill; the drill itself is $144.95).
// This is walmart.com's ONLINE price for its default store, not store 1458's
// shelf price.
//
// A result is kept only when the page's own UPC/EAN equals the scanned code,
// so a fuzzy search hit never puts the wrong product on a catch.
//
// Cached per UPC in chrome.storage.local (found 60 days, not found 2 days).

const CACHE_KEY = "doorcatch.items.v3";   // v3: + walmart.com price
const WM_CANDIDATES = 4;
const PRICE_TTL = 7 * 24 * 3600 * 1000;   // prices move; names don't
const FOUND_TTL = 60 * 24 * 3600 * 1000;
const MISS_TTL = 2 * 24 * 3600 * 1000;

const digits = (s) => String(s || "").replace(/\D/g, "");
const noLeadZeros = (s) => digits(s).replace(/^0+/, "");
export const sameUpc = (a, b) => !!noLeadZeros(a) && noLeadZeros(a) === noLeadZeros(b);

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };
const text = (s) => String(s || "")
  .replace(/<[^>]*>/g, " ")
  .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e) =>
    ENTITIES[e.toLowerCase()] ?? (e[0] === "#" ? String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : m))
  .replace(/\s+/g, " ").trim();

export function parseGoUpc(html, upc) {
  const name = text((html.match(/<h1 class="product-name">([\s\S]*?)<\/h1>/) || [])[1]);
  if (!name) return null;
  const cell = (label) => text((html.match(new RegExp(`metadata-label">${label}</td>\\s*<td>([\\s\\S]*?)</td>`)) || [])[1]);
  if (![cell("UPC"), cell("EAN")].some((c) => sameUpc(c, upc))) return null;
  const img = (html.match(/<figure class="product-image[^"]*">\s*<img src="(https:[^"]+)"/) || [])[1] || "";
  return { name, brand: cell("Brand"), category: cell("Category"), img, source: "go-upc.com", sourceUrl: `https://go-upc.com/search?q=${digits(upc)}` };
}

export function parseUpcItemDb(html, upc) {
  const m = html.match(/UPC (\d+) is associated with <b>([\s\S]*?)<\/b>/);
  if (!m || !sameUpc(m[1], upc)) return null;
  const img = (html.match(/<img class="product" src="(https:[^"]+)"/) || [])[1] || "";
  const brand = text((html.match(/<td>Brand:<\/td><td>([\s\S]*?)<\/td>/) || [])[1]);
  return { name: text(m[2]), brand, category: "", img, source: "upcitemdb.com", sourceUrl: `https://www.upcitemdb.com/upc/${digits(upc)}` };
}

async function page(url) {
  const r = await fetch(url, { credentials: "omit" });
  return r.ok ? r.text() : "";
}

function nextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  try { return m ? JSON.parse(m[1]) : null; } catch { return null; }
}

export function searchItemIds(html) {
  const ids = [];
  (function walk(o) {
    if (!o || typeof o !== "object" || ids.length >= 20) return;
    if (o.usItemId && o.imageInfo && !ids.includes(String(o.usItemId))) ids.push(String(o.usItemId));
    for (const k in o) walk(o[k]);
  })(nextData(html));
  return ids;
}

export function parseWalmartItem(html, upc) {
  const p = nextData(html)?.props?.pageProps?.initialData?.data?.product;
  if (!p || !sameUpc(p.upc, upc)) return null;
  const price = Number(p.priceInfo?.currentPrice?.price);
  return {
    walmartId: String(p.usItemId),
    walmartName: p.name || "",
    walmartPrice: Number.isFinite(price) && price > 0 ? price : null,
    walmartUrl: `https://www.walmart.com/ip/${p.usItemId}`,
    walmartImg: p.imageInfo?.thumbnailUrl || "",
  };
}

// Auror-style catalog filler and punctuation confuse walmart.com search.
export function shortQuery(name) {
  return name.replace(/\b(not applicable|n\/a|other|none|assorted|various)\b/gi, " ")
    .replace(/[^\w&'.\- ]+/g, " ").split(/\s+/).filter(Boolean).slice(0, 6).join(" ");
}

async function walmartPrice(name, upc) {
  // "Apple Airpods 4 - White": the colour/size tail after a dash sinks the match.
  const head = name.split(/\s+[-–|(]\s*/)[0];
  for (const q of [...new Set([name, shortQuery(name), shortQuery(head)])].filter(Boolean)) {
    const ids = searchItemIds(await page(`https://www.walmart.com/search?q=${encodeURIComponent(q)}`)).slice(0, WM_CANDIDATES);
    for (const id of ids) {
      const hit = parseWalmartItem(await page(`https://www.walmart.com/ip/${id}`), upc);
      if (hit) return hit;
    }
  }
  return null;
}

async function lookupOne(upc) {
  const go = parseGoUpc(await page(`https://go-upc.com/search?q=${upc}`), upc);
  if (go) return go;
  return parseUpcItemDb(await page(`https://www.upcitemdb.com/upc/${upc}`), upc);
}

// Whatever is cached for these UPCs, any age, no network: the view paints
// with this the moment it opens, then asks lookupItems for the rest.
export async function cachedItems(upcs) {
  const cache = (await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY] || {};
  const out = {};
  for (const upc of upcs || []) { const d = digits(upc); if (cache[d]) out[d] = cache[d]; }
  return out;
}

// → { items: { [upc]: { status: "found"|"not_found", name, brand, category, img,
//                        source, sourceUrl, walmartId, walmartPrice, walmartUrl,
//                        priceAt, at } } }  — walmartPrice null when no walmart.com
//                        listing carries this UPC
// Each result is written the moment it exists, merged into the cache as it is
// NOW: a whole-cache write at the end lost every entry when the page closed
// mid-lookup, and two overlapping lookups overwrote each other's results.
let writes = Promise.resolve();
function saveEntry(upc, entry) {
  writes = writes.then(async () => {
    const cache = (await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY] || {};
    cache[upc] = entry;
    await chrome.storage.local.set({ [CACHE_KEY]: cache });
  }).catch(() => {});
  return writes;
}

export async function lookupItems(upcs, { force = false } = {}) {
  const cache = (await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY] || {};
  const now = Date.now();
  const out = {};
  for (const upc of [...new Set((upcs || []).map(digits).filter((u) => u.length >= 6))]) {
    const hit = cache[upc];
    if (hit && !force && now - hit.at < (hit.status === "found" ? FOUND_TTL : MISS_TTL)) {
      // Name is still good; refresh only a week-old price.
      if (hit.walmartId && now - (hit.priceAt || 0) > PRICE_TTL) {
        const wm = parseWalmartItem(await page(hit.walmartUrl).catch(() => ""), upc);
        if (wm) { Object.assign(hit, wm, { priceAt: now }); await saveEntry(upc, hit); }
      }
      out[upc] = hit; continue;
    }
    let entry;
    try {
      const found = await lookupOne(upc);
      if (!found) entry = { status: "not_found", at: Date.now() };
      else {
        const wm = await walmartPrice(found.name, upc).catch(() => null);
        entry = { status: "found", ...found, img: found.img || wm?.walmartImg || "", ...(wm || {}),
                  walmartUrl: wm?.walmartUrl || `https://www.walmart.com/search?q=${encodeURIComponent(found.name)}`,
                  priceAt: wm ? Date.now() : null, at: Date.now() };
      }
    } catch { continue; }   // network hiccup: leave uncached
    await saveEntry(upc, entry);
    out[upc] = entry;
  }
  return { items: out };
}
