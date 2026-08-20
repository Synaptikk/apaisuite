// modules/orcmonitor/lib/resolve_coords.js
//
// Auto-lookup Walmart store coordinates for stores not in the hardcoded
// STORE_COORDS map. Opens walmart.com/store/<num> in a background tab
// (same technique as aurorbuddy/lib/stores.js:fetchStoreInfo) and mines
// __NEXT_DATA__ for a lat/lon pair. Resolved coords are cached to
// chrome.storage.local so a store only pays the tab-open cost once.
//
// Returns [lat, lon] on success, null on failure.

const CACHE_KEY = (num) => `orcmonitor.storeCoords.${num}`;
const STORE_PAGE = (num) => `https://www.walmart.com/store/${num}`;
const TAB_TIMEOUT_MS = 15_000;

export async function resolveStoreCoords(storeNum) {
  const n = String(storeNum).trim();
  if (!/^\d{1,5}$/.test(n)) return null;

  // Cache hit fast-path.
  const key = CACHE_KEY(n);
  const cached = await chrome.storage.local.get(key).catch(() => ({}));
  const c = cached?.[key];
  if (Array.isArray(c) && c.length === 2 && c.every((x) => typeof x === "number")) {
    return c;
  }

  const tab = await chrome.tabs.create({ url: STORE_PAGE(n), active: false }).catch(() => null);
  if (!tab) return null;

  try {
    await waitForTabLoad(tab.id, TAB_TIMEOUT_MS);
    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const el = document.getElementById("__NEXT_DATA__");
        return el ? el.textContent : "";
      },
    });
    const blob = result?.[0]?.result ?? "";
    const coords = mineCoords(blob);
    if (coords) {
      await chrome.storage.local.set({ [key]: coords }).catch(() => {});
    }
    return coords;
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// Walmart's __NEXT_DATA__ blob embeds the store's geopoint under several
// shapes across releases. Try each in turn — the first hit wins.
export function mineCoords(blob) {
  if (!blob) return null;

  // schema.org LocalBusiness: "geo": { "@type": "GeoCoordinates",
  //   "latitude": 34.9362, "longitude": -85.2152 }
  const geoLat = blob.match(/"latitude"\s*:\s*(-?\d+\.\d+)/)?.[1];
  const geoLon = blob.match(/"longitude"\s*:\s*(-?\d+\.\d+)/)?.[1];
  if (geoLat && geoLon) return [Number(geoLat), Number(geoLon)];

  // Next.js pageProps: "geoPoint": { "latitude": <n>, "longitude": <n> }
  const gpLat = blob.match(/"geoPoint"\s*:\s*\{[^}]*"latitude"\s*:\s*(-?\d+\.\d+)/)?.[1];
  const gpLon = blob.match(/"geoPoint"\s*:\s*\{[^}]*"longitude"\s*:\s*(-?\d+\.\d+)/)?.[1];
  if (gpLat && gpLon) return [Number(gpLat), Number(gpLon)];

  // Legacy: "lat": <n>, "lng"|"lon": <n>
  const shortLat = blob.match(/"lat"\s*:\s*(-?\d+\.\d+)/)?.[1];
  const shortLon = blob.match(/"(?:lng|lon)"\s*:\s*(-?\d+\.\d+)/)?.[1];
  if (shortLat && shortLon) return [Number(shortLat), Number(shortLon)];

  return null;
}

async function waitForTabLoad(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return false;
    if (t.status === "complete") return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
