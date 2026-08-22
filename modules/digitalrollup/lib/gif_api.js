// modules/digitalrollup/lib/gif_api.js
//
// Client for the GIF Market Dashboard ("Digital Market Rollup"), an AI
// Launchpad prototype at ai-innovation-lab-app-bebdeibbicjffabd.walmart.com.
//
// Unlike every other source in this suite, this one is a REAL JSON API — it is
// a FastAPI app and publishes its own contract at /openapi.json (Swagger UI at
// /docs). No crosstab export, no DOM driving, no capture ring. Discovered
// live 2026-08-22; the endpoints we use:
//
//   GET /api/hierarchy              → { regions:[{ region_nbr, markets:[...] }] }
//                                     Pre-scoped to the caller's access.
//   GET /api/dashboard?market=<n>   → { cards:[10], summary:{...}, stamps }
//   GET /api/region?region=<n>      → identical card shape one level up
//                                     (market cards). Not used yet.
//
// Deliberately NOT used: GET /api/trends?market=<n>. It returns 500
// "Your default credentials were not found" — the app's server-side GCP ADC
// is unconfigured. If it ever starts working it is the only route to history;
// until then anything historical has to be accumulated locally.
//
// ── Auth ────────────────────────────────────────────────────────────────
// The app sits behind the istio ingress, which validates a pfedprod SAML JWT
// off the `AccessToken` cookie and injects x-user-groups / x-app-id headers.
// /api/diagnostics/headers echoes what it resolved — useful when a pull comes
// back empty rather than failing.
//
// A cross-origin fetch straight from the service worker may or may not carry
// that cookie depending on its SameSite attribute; the same question sank the
// direct-fetch approach for Workvivo (see MEMORY.md::Workvivo API needs 3
// page-scoped headers). So we TRY direct first, because it costs nothing and
// avoids a tab, and fall back to running the fetch inside a tab on the app's
// own origin, where the cookie is unambiguously in scope. Which path won is
// recorded on the snapshot as `via` so we learn the answer from real profiles
// instead of guessing.

export const ORIGIN = "https://ai-innovation-lab-app-bebdeibbicjffabd.walmart.com";

// The lightest page on the origin. Opening the dashboard itself would render
// the whole board and, on a profile that has not accepted the AI Launchpad
// disclaimer, bounce to innovate.walmart.com instead. /ping is a two-word JSON
// response on the right origin, which is all the tab is for.
const ANCHOR_PATH = "/ping";

const TAB_LOAD_TIMEOUT_MS = 20_000;
const TAB_POLL_MS = 250;

/** Error carrying a machine-readable class, so the view can give real advice. */
export class GifApiError extends Error {
  constructor(kind, message, detail = {}) {
    super(message);
    this.name = "GifApiError";
    this.kind = kind; // AUTH | DISCLAIMER | HTTP | TAB | PARSE | NETWORK
    this.detail = detail;
  }
}

/**
 * Fetch a JSON path from the app, direct first and via a tab as fallback.
 * @returns {Promise<{json:any, via:"direct"|"tab"}>}
 */
export async function fetchAppJson(path) {
  let directErr = null;
  try {
    return { json: await fetchDirect(path), via: "direct" };
  } catch (e) {
    // A 4xx here is the expected "cookie did not travel" case, not a bug.
    // Anything else is still worth keeping for diagnostics.
    directErr = e;
  }
  try {
    return { json: await fetchViaTab(path), via: "tab" };
  } catch (e) {
    e.detail = { ...(e.detail || {}), directError: String(directErr?.message ?? directErr) };
    throw e;
  }
}

async function fetchDirect(path) {
  const res = await fetch(ORIGIN + path, {
    credentials: "include",
    headers: { accept: "application/json" },
  });
  return interpret(res.status, res.headers.get("content-type") || "", await res.text(), path);
}

async function fetchViaTab(path) {
  const { tabId, opened } = await findOrOpenTab();
  try {
    const [frame] = await chrome.scripting.executeScript({
      target: { tabId },
      // Must be pure — this is serialised into the tab. It runs in the
      // ISOLATED world, whose fetch is same-origin to the page, so the
      // AccessToken cookie applies with no SameSite question to answer.
      func: async (p) => {
        try {
          const r = await fetch(p, { credentials: "include", headers: { accept: "application/json" } });
          return { status: r.status, ct: r.headers.get("content-type") || "", body: await r.text() };
        } catch (e) {
          return { error: String(e?.message ?? e) };
        }
      },
      args: [path],
    });
    const out = frame?.result;
    if (!out) throw new GifApiError("TAB", "The page returned nothing for the request.");
    if (out.error) throw new GifApiError("NETWORK", `Request failed in the page: ${out.error}`);
    return interpret(out.status, out.ct, out.body, path);
  } finally {
    // Never close a tab the user had open themselves.
    if (opened) chrome.tabs.remove(tabId).catch(() => {});
  }
}

/** Shared response handling for both paths, so they can't disagree. */
function interpret(status, contentType, body, path) {
  if (status === 401 || status === 403) {
    throw new GifApiError("AUTH", "The dashboard rejected the request as unauthenticated.", { status, path });
  }
  // The disclaimer gate is a redirect to innovate.walmart.com that lands as
  // HTML. Getting HTML from an /api path means we were bounced, not that the
  // API changed shape — and the fix is a human clicking through once.
  if (!/json/i.test(contentType)) {
    const looksLikeGate = /disclaimer/i.test(body.slice(0, 4000));
    throw new GifApiError(
      looksLikeGate ? "DISCLAIMER" : "HTTP",
      looksLikeGate
        ? "The AI Launchpad disclaimer has not been accepted in this browser profile."
        : `Expected JSON from ${path} but got ${contentType || "an unlabelled response"}.`,
      { status, path, preview: body.slice(0, 200) }
    );
  }
  if (status < 200 || status >= 300) {
    throw new GifApiError("HTTP", `${path} returned HTTP ${status}.`, { status, path, preview: body.slice(0, 200) });
  }
  try {
    return JSON.parse(body);
  } catch (e) {
    throw new GifApiError("PARSE", `Could not parse the response from ${path} as JSON.`, {
      status, path, preview: body.slice(0, 200),
    });
  }
}

async function findOrOpenTab() {
  // Any tab already on the origin will do — the fetch is relative, so it does
  // not matter which page it is sitting on.
  const existing = await chrome.tabs.query({ url: `${ORIGIN}/*` });
  const ready = existing.find((t) => t.status === "complete" && t.id != null);
  if (ready) return { tabId: ready.id, opened: false };

  const tab = await chrome.tabs.create({ url: ORIGIN + ANCHOR_PATH, active: false });
  await waitForLoad(tab.id);
  return { tabId: tab.id, opened: true };
}

async function waitForLoad(tabId) {
  const deadline = Date.now() + TAB_LOAD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    let t;
    try {
      t = await chrome.tabs.get(tabId);
    } catch {
      throw new GifApiError("TAB", "The background tab closed before it finished loading.");
    }
    if (t.status === "complete") return;
    await new Promise((r) => setTimeout(r, TAB_POLL_MS));
  }
  throw new GifApiError("TAB", "Timed out waiting for the dashboard tab to load.", { tabId });
}

// ── Endpoints ───────────────────────────────────────────────────────────

/** Region/market tree the signed-in user is allowed to see. */
export async function fetchHierarchy() {
  const { json, via } = await fetchAppJson("/api/hierarchy");
  const markets = [];
  for (const region of json?.regions || []) {
    for (const m of region.markets || []) {
      markets.push({
        market: String(m.market_nbr),
        name: m.market_name || `Market ${m.market_nbr}`,
        region: region.region_nbr != null ? String(region.region_nbr) : null,
        storeCount: m.store_count ?? null,
      });
    }
  }
  markets.sort((a, b) => Number(a.market) - Number(b.market));
  return { markets, via };
}

/** One market's whole rollup — every store card plus the market summary. */
export async function fetchDashboard(market) {
  const m = encodeURIComponent(String(market));
  const { json, via } = await fetchAppJson(`/api/dashboard?market=${m}`);
  return { raw: json, via };
}
