// modules/orcmonitor/lib/auror_api.js
// Auror API client — reads the JWT from chrome.storage.session.
// The JWT is captured by the shell's declarative webRequest filter
// and also by ensureAurorAuth() in service.js when no Auror tab is open.

const AUROR_BASE = "https://app.us.auror.co/api/spa";
const JWT_KEY    = "orcmonitor.auror.jwt";
const JWT_KEY_AB = "aurorbuddy.auror.jwt";   // fallback from aurorbuddy's capture

export async function getJwt() {
  const got = await chrome.storage.session.get([JWT_KEY, JWT_KEY_AB]).catch(() => ({}));
  const own = got[JWT_KEY];
  const ab  = got[JWT_KEY_AB];
  const entry = (own?.value && own.value) ? own : (ab?.value && ab.value) ? ab : null;
  if (!entry) return null;
  // Treat as expired if older than 20 minutes
  const age = Date.now() - (entry.at ?? 0);
  if (age > 20 * 60 * 1000) return null;
  return entry.value;   // "Bearer eyJ..."
}

async function aurorFetch(path, params) {
  const jwt = await getJwt();
  if (!jwt) throw new Error("NO_JWT");

  let url = `${AUROR_BASE}${path}`;
  if (params) {
    const qs = new URLSearchParams(params).toString();
    url += "?" + qs;
  }

  const resp = await fetch(url, {
    headers: {
      "Authorization":    jwt,
      "X-Requested-With": "XMLHttpRequest",
    },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText} — ${url}`);
  return resp.json();
}

// ── Search ORC events in a region ────────────────────────────────────────────

export async function searchOrcEvents(region, timeFilter = "Last30days") {
  return aurorFetch("/GlobalSearch/globalSearch", {
    isOrganizedRetailCrime: "true",
    intelTypeFilters:       "Event",
    searchString:           "",
    siteTraits:             region,
    skip:                   "0",
    includeTotalResultCount: "true",
    startDate:              "",
    endDate:                "",
    timeRangeFilter:        timeFilter,
  });
}

// ── Event profile → person IDs ────────────────────────────────────────────────

export async function getEventPersonIds(eventId) {
  try {
    const profile = await aurorFetch(`/EventProfile/event/${eventId}`);
    const persons = profile?.eventProfileResult?.eventPersons ?? [];
    return persons.map(p => p.identityGroupId).filter(Boolean);
  } catch {
    return [];
  }
}

// Same, but a failure throws instead of reading as "nobody on this event" —
// the cache must not remember a network error as an empty event.
export async function fetchEventPersonIds(eventId) {
  const profile = await aurorFetch(`/EventProfile/event/${eventId}`);
  return (profile?.eventProfileResult?.eventPersons ?? []).map(p => p.identityGroupId).filter(Boolean).map(String);
}

// ── Person profile ────────────────────────────────────────────────────────────

export async function getPersonProfile(personId) {
  return aurorFetch(`/PersonProfile/person/${personId}`);
}

// ── Profile feed (events with dates) ─────────────────────────────────────────

export async function getProfileFeed(personId) {
  return aurorFetch(`/ProfileFeed/p${personId}`, { filter: "Events" });
}

// ── Newest ORC events for one region inside a lookback window ────────────────
// globalSearch pages are a fixed 10 and NOT date-ordered, so every page is
// read (up to MAX_PAGES) and sorted here. Only Last7days / Last30days are valid
// presets; anything else is timeRangeFilter="" + YYYY-MM-DD dates (inclusive).
// A "Custom" filter, or dates with a time part, is a 400.
// (dev/ORCMONITOR_AUROR_FINDINGS.md §1)

const TIME_FILTER = { 7: "Last7days", 30: "Last30days" };
const MAX_PAGES = 20;
const ymd = d => d.toISOString().slice(0, 10);

export async function listRegionEvents(regionNum, days = 30, max = 60) {
  const preset = TIME_FILTER[days];
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400000);
  const all = [];
  for (let page = 0, skip = 0; page < MAX_PAGES; page++) {
    const d = await aurorFetch("/GlobalSearch/globalSearch", {
      isOrganizedRetailCrime:  "true",
      intelTypeFilters:        "Event",
      searchString:            "",
      siteTraits:              `REGION: ${regionNum}`,
      skip:                    String(skip),
      includeTotalResultCount: "true",
      startDate:               preset ? "" : ymd(start),
      endDate:                 preset ? "" : ymd(end),
      timeRangeFilter:         preset ?? "",
    });
    const rows = d?.searchResults ?? [];
    all.push(...rows);
    skip += rows.length;
    if (rows.length < 10 || (d?.totalResultCount != null && skip >= d.totalResultCount)) break;
  }
  all.sort((a, b) => String(b.occurredAt ?? "").localeCompare(String(a.occurredAt ?? "")));
  return all.slice(0, max);
}

// ── Sites (stores) with lat/lon ──────────────────────────────────────────────
// RegionDashboard/siteStats lists every site with >=1 event in the range, so a
// range back to 2020 covers the whole BU (801 of 802 SE sites).
// region is a "KEY:VALUE" site trait, e.g. "BUSINESS UNIT:A - SOUTHEAST BU".

export async function getSiteStats(regionTrait, rangeStart = "2020-01-01") {
  const rows = await aurorFetch("/RegionDashboard/12/siteStats", {
    region: regionTrait, rangeStart, rangeEnd: ymd(new Date()),
  });
  return (Array.isArray(rows) ? rows : []).map(r => ({
    siteId: String(r.siteId), name: r.siteName,
    lat: Number(r.siteLatitude), lon: Number(r.siteLongitude),
    eventCount: r.eventCount ?? 0,
  })).filter(r => r.name && Number.isFinite(r.lat) && Number.isFinite(r.lon) && (r.lat || r.lon));
}

// Site traits (WALMART MARKET, REGION, ORC CORRIDOR…) for one Auror siteId.
export async function getSiteProfile(siteId) {
  return aurorFetch(`/SiteDashboard/${siteId}/profile`);
}
