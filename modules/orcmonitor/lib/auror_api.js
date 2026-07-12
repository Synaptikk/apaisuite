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

// ── Person profile ────────────────────────────────────────────────────────────

export async function getPersonProfile(personId) {
  return aurorFetch(`/PersonProfile/person/${personId}`);
}

// ── Profile feed (events with dates) ─────────────────────────────────────────

export async function getProfileFeed(personId) {
  return aurorFetch(`/ProfileFeed/p${personId}`, { filter: "All" });
}
