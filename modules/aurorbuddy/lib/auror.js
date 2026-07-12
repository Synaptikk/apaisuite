// lib/auror.js — Auror SearchPeople JSON API client (browser version)
// ────────────────────────────────────────────────────────────────────────────
// Port of pipeline/auror_scraper.py (the server-side bits, not the Playwright
// JWT-capture bits — that's in background.js now).
//
// Key differences from the Python version:
//   - Runs in the service worker, so fetch() has cookies + no CORS.
//   - JWT comes from background.js's webRequest listener, not a Playwright
//     request event listener.
//   - Parallel page batches use Promise.all instead of asyncio.gather.

const SEARCH_PEOPLE_URL = "https://app.us.auror.co/api/spa/SearchApi/searchPeople";
const PAGE_SIZE       = 20;      // server-fixed
const PARALLEL_PAGES  = 5;
const HARD_PAGE_CEIL  = 20;      // covers ~400 suspects

const SUSPECT_MAX_VALUE = 10_000;
const SUSPECT_NO_NAMES  = new Set(["(unknown)", "unknown", "", "n/a", "none"]);

// ─── Public: searchPeople ───────────────────────────────────────────────────
// `signal` is an optional AbortSignal wired into each fetch; when a new
// scan starts in background.js we abort the prior signal so the pagination
// loop here and the in-flight network calls all bail immediately.
export async function searchPeople({ token, stores, homeStore, days = "Last30days", signal }) {
  if (!token) throw new Error("searchPeople: missing Auror JWT");
  if (!Array.isArray(stores) || stores.length === 0) {
    throw new Error("searchPeople: `stores` must be a non-empty array");
  }

  // Mirror auror_scraper._exclude_home_store: strip the home store from
  // siteTraits. Suspects who show up at home are already known to this AP
  // team — the tool exists to surface activity at NEIGHBOURING stores.
  //
  // Each store object is expected to carry an `auror_site` field built by
  // lib/stores.js in the exact format Auror's index uses:
  //   SITE: WALMART <num> - <STREET>, <CITY>, <ST>
  // Anything else (e.g. just "SITE: WALMART 9999 Walmart 9999") returns
  // zero results from the API.
  const siteTraits = stores
    .filter(s => String(s.number).trim() !== String(homeStore).trim())
    .map(s => s.auror_site || `SITE: WALMART ${s.number}`)  // fallback keeps old callers working
    .filter(Boolean);

  if (siteTraits.length === 0) {
    throw new Error("All nearby stores equal the home store — nothing to search.");
  }

  // Emit one diagnostic line so we can tell — from the service worker
  // DevTools console — what we actually sent Auror when someone reports
  // "0 suspects returned". Without this it's a guessing game.
  console.log("[auror] searchPeople", {
    homeStore: String(homeStore),
    siteTraitsCount: siteTraits.length,
    siteTraitsFirst3: siteTraits.slice(0, 3),
    days
  });

  // Page 0 gets the total count; page 1..N just fetch rows.
  const firstPage = await fetchPage({ token, siteTraits, skip: 0, includeTotal: true, days, signal });
  if (signal?.aborted) return { suspects: [], diag: { rawTotal: 0, rowsFetched: 0, afterActionableFilter: 0, siteTraitsCount: siteTraits.length, siteTraitsSample: siteTraits.slice(0, 3) } };
  console.log("[auror] page 0 response", {
    total: firstPage.totalResultCount,
    rowsOnPage: firstPage.searchResults?.length ?? 0,
    firstRowName: firstPage.searchResults?.[0]?.primaryIdentifier
  });

  const rawTotal = firstPage.totalResultCount ?? 0;
  const total = Math.min(rawTotal, HARD_PAGE_CEIL * PAGE_SIZE);
  const rows = [...(firstPage.searchResults ?? [])];

  // Remaining pages in parallel batches of PARALLEL_PAGES
  const remaining = Math.ceil(total / PAGE_SIZE) - 1;
  if (remaining > 0) {
    for (let batchStart = 1; batchStart <= remaining; batchStart += PARALLEL_PAGES) {
      if (signal?.aborted) break;
      const skips = [];
      for (let p = batchStart; p < batchStart + PARALLEL_PAGES && p <= remaining; p++) {
        skips.push(p * PAGE_SIZE);
      }
      const pages = await Promise.all(
        skips.map(skip => fetchPage({ token, siteTraits, skip, includeTotal: false, days, signal }))
      );
      for (const pg of pages) rows.push(...(pg.searchResults ?? []));
    }
  }

  const allParsed = rows.map(toSuspect).filter(Boolean);
  const suspects  = allParsed.filter(isActionable);

  // Diagnostic dump — every name Auror gave us back in the scan, before
  // AND after the actionable filter ($100–$10k, 2+ events, named).
  // Analyst can grep the SW console for an expected suspect to see if
  // they made it through the Auror stage at all. If a name they expect
  // is in BEFORE but missing from AFTER, our filter is dropping them.
  // If it's missing from BEFORE, Auror itself didn't return them.
  console.log(`[auror] all suspects returned (${allParsed.length}):`,
    allParsed.map(s => `${s.name} (${s.event_count}e $${s.total_value})`));
  const dropped = allParsed.filter(s => !isActionable(s));
  if (dropped.length) {
    console.log(`[auror] actionable-filter dropped ${dropped.length}:`,
      dropped.map(s => `${s.name} (${s.event_count}e $${s.total_value})`));
  }
  // Return a structured object so the UI can explain a 0-result scan
  // without the user digging into DevTools. chrome.runtime.sendMessage
  // only guarantees structured-clone of plain objects, so this shape is
  // safer than attaching props to the array.
  return {
    suspects,
    diag: {
      rawTotal,                       // what Auror reports BEFORE client-side filtering
      rowsFetched: rows.length,       // what we actually got back over all pages
      afterActionableFilter: suspects.length,
      siteTraitsCount: siteTraits.length,
      siteTraitsSample: siteTraits.slice(0, 3)
    }
  };
}

// ─── Internal helpers ───────────────────────────────────────────────────────

async function fetchPage({ token, siteTraits, skip, includeTotal, days, signal }) {
  const params = new URLSearchParams();
  params.append("configCaptureApiCalls", "");
  params.append("configProfile", "");
  params.append("endDate", "");
  params.append("eventTypeFilters", "PosScoFraud");
  params.append("incidentCountMin", "2");
  params.append("includeTotalResultCount", includeTotal ? "true" : "false");
  params.append("searchString", "");
  for (const s of siteTraits) params.append("siteTraits", s);
  params.append("skip", String(skip));
  params.append("sortBy", "");
  params.append("startDate", "");
  params.append("timeRangeFilter", days);
  params.append("totalValueMin", "100");

  const fullUrl = `${SEARCH_PEOPLE_URL}?${params.toString()}`;
  if (skip === 0) {
    // Full URL on the first page only (subsequent pages differ only by skip=).
    // Copy this line out of the service-worker console to compare against
    // what the Python tool sends — URL should be byte-identical apart from
    // skip/includeTotalResultCount.
    console.log("[auror] GET", fullUrl);
  }

  const r = await fetch(fullUrl, {
    method: "GET",
    credentials: "include",
    signal,   // aborted by background.js freshScanSignal() when a newer scan starts
    headers: {
      "Authorization": token,
      "X-Requested-With": "XMLHttpRequest",
      "Accept": "application/json, text/plain, */*"
    }
  });

  if (r.status === 401 || r.status === 403) {
    throw new Error("Auror returned 401/403 — reload your Auror tab so the SPA refreshes its JWT and retry.");
  }
  if (!r.ok) {
    throw new Error(`Auror searchPeople failed: HTTP ${r.status}`);
  }

  // Read raw body once; on the first page, log it so we can debug
  // 'response came back empty' reports. Subsequent pages skip the dump.
  const bodyText = await r.text();
  if (skip === 0) {
    console.log("[auror] page 0 raw body (first 500 chars):", bodyText.slice(0, 500));
  }
  try {
    return JSON.parse(bodyText);
  } catch (e) {
    console.warn("[auror] non-JSON response on skip=" + skip + ":", bodyText.slice(0, 200));
    return {};
  }
}

function toSuspect(row) {
  if (!row || row.intelType !== "Person") return null;
  const name = row.primaryIdentifier ?? "";
  const [first, ...rest] = name.trim().split(/\s+/);
  const last = rest.length ? rest[rest.length - 1] : "";

  // Field names match pipeline/auror_scraper.py::_format so the rendered UI
  // can be reused almost verbatim from templates/index.html.
  const rid = row.resourceLocator ?? "";
  const personId = rid.startsWith("p") ? rid.slice(1) : rid;
  const img = row.image ?? {};
  const photo = img.thumbnailMediumUrl || img.thumbnailSmallUrl || img.thumbnailLargeUrl || "";

  return {
    person_id:          personId,
    resource_locator:   rid,
    name,
    first_name:         first ?? "",
    last_name:          last ?? "",
    event_count:        Number(row.eventCount ?? 0),
    total_value:        Math.round(Number(row.totalValue ?? 0) * 100) / 100,
    // pipeline/auror_scraper.py line 117: /person/{person_id} — uses the
    // STRIPPED id (no 'p' prefix). The docs in AURORAGENT_DOCS.md showing
    // '/person/p3125673' are stale vs the code.
    auror_url:          personId ? `https://app.us.auror.co/person/${personId}` : "",
    photo_url:          photo,
    threatening:        !!row.hasThreateningBehaviors,
    threatening_types:  row.threateningBehaviors ?? [],
    is_orc:             !!row.isOrganizedRetailCrime
  };
}

function isActionable(s) {
  if (!s) return false;
  if (s.event_count < 2) return false;
  if (s.total_value < 100 || s.total_value > SUSPECT_MAX_VALUE) return false;
  if (SUSPECT_NO_NAMES.has(s.name.trim().toLowerCase())) return false;
  return true;
}
