// modules/orcmonitor/service.js
// Service-worker handlers for orcmonitor.
// Auto-authenticates to Auror in a background tab when the JWT is absent —
// the same pattern aurorbuddy uses (find/open tab → SSO auto-click → close).

import { createAuth, AUROR_SSO_SELECTORS } from "../../shared/auth.js";
import { fetchEventPersonIds, listRegionEvents, getSiteStats, getSiteProfile,
         getPersonProfile, getProfileFeed }  from "./lib/auror_api.js";
import { resolveStoreCoords }                from "./lib/resolve_coords.js";
import { buildThreatCard }                   from "./lib/trajectory.js";
import * as cache                            from "./lib/cache.js";
import { haversine }                         from "./lib/corridors.js";
import { getStoreCoords, SE_BU_REGIONS }     from "./lib/store_coords.js";

const MODULE_ID     = "orcmonitor";
const AUROR_HOME    = "https://app.us.auror.co/feed";
const AUROR_FAST_MS = 8_000;
const AUROR_SLOW_MS = 45_000;
const EVENTS_PER_REGION = 200;  // newest ORC events listed per SE region (listing is cheap; only new ones cost a call)
const CONCURRENCY       = 3;    // parallel Auror calls for event / person fetches
const MAX_PROFILES      = 150;  // people profiled per run (2 requests each)
const SITES_KEY   = `${MODULE_ID}.seSites.v1`;     // chrome.storage.local
const MARKET_KEY  = `${MODULE_ID}.marketOf.v1`;    // chrome.storage.local
const SITES_TTL   = 3 * 86400000;
const MARKET_TTL  = 7 * 86400000;
const SE_BU_TRAIT = "BUSINESS UNIT:A - SOUTHEAST BU";

// "Walmart 3660 - 3550 Cummings Hwy, Chattanooga, TN" → "3660"
const walmartNum = name => (String(name ?? "").match(/^Walmart\s+(\d{1,5})\b/i)?.[1] ?? null);

// ── Store catalog: every SE Walmart with lat/lon, one call, cached 3 days ─────
async function loadSeSites() {
  const got = await chrome.storage.local.get(SITES_KEY).catch(() => ({}));
  const c = got?.[SITES_KEY];
  if (c?.sites?.length && Date.now() - (c.at ?? 0) < SITES_TTL) return c.sites;
  try {
    const sites = (await getSiteStats(SE_BU_TRAIT))
      .filter(s => walmartNum(s.name))
      .map(s => ({ siteId: s.siteId, name: s.name, lat: s.lat, lon: s.lon }));
    if (sites.length) await chrome.storage.local.set({ [SITES_KEY]: { at: Date.now(), sites } }).catch(() => {});
    return sites;
  } catch (e) {
    console.warn("[orcmonitor] siteStats:", e?.message);
    return c?.sites ?? [];
  }
}

// ── The target store's WALMART MARKET and its stores, cached 7 days ──────────
async function marketFor(storeNum, sites) {
  const key = String(Number(storeNum));
  const got = await chrome.storage.local.get(MARKET_KEY).catch(() => ({}));
  const all = got?.[MARKET_KEY] ?? {};
  if (all[key] && Date.now() - (all[key].at ?? 0) < MARKET_TTL) return all[key];
  const site = sites.find(s => walmartNum(s.name) === key);
  if (!site) return null;
  try {
    const prof = await getSiteProfile(site.siteId);
    const trait = (prof?.siteTraits ?? []).find(t => /^WALMART MARKET$/i.test(t.key ?? ""));
    const number = String(trait?.value ?? "").trim();
    if (!number) return null;
    const stores = (await getSiteStats(`WALMART MARKET:${number}`))
      .map(s => walmartNum(s.name)).filter(Boolean).map(n => String(Number(n)));
    if (!stores.includes(key)) stores.push(key);
    const region = (prof?.siteTraits ?? []).find(t => /^REGION$/i.test(t.key ?? ""))?.value ?? null;
    const out = { number, region, stores, at: Date.now() };
    all[key] = out;
    await chrome.storage.local.set({ [MARKET_KEY]: all }).catch(() => {});
    return out;
  } catch (e) {
    console.warn("[orcmonitor] market lookup:", e?.message);
    return null;
  }
}

// ── Auth — reads JWT captured by shell's declarative webRequest listener ──
const _auth    = createAuth(MODULE_ID);
const aurorJwt = _auth.getCapturedHeader("auror.jwt", 20 * 60 * 1000);

// Run fn over items with at most n in flight.
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

// ── Tab helpers ────────────────────────────────────────────────────────────
async function _findAurorTab() {
  const tabs = await chrome.tabs.query({ url:"https://app.us.auror.co/*" });
  return tabs[0] ?? null;
}

async function _waitLoad(tabId, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return false;
    if (t.status === "complete") return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

async function _pollToken(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (aurorJwt.get()) return true;
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

// ── Auto-auth: open background Auror tab, capture token, close tab ─────────
async function ensureAurorAuth() {
  if (aurorJwt.get()) return { ok:true, reason:"cached" };

  let tab = await _findAurorTab();
  const weOpened = !tab;
  if (!tab) {
    tab = await chrome.tabs.create({ url:AUROR_HOME, active:false });
  } else {
    await chrome.tabs.reload(tab.id, { bypassCache:false }).catch(() => {});
  }

  try {
  await _waitLoad(tab.id);
  if (await _pollToken(AUROR_FAST_MS)) {
    return { ok:true, reason:"captured" };
  }

  // SSO wasn't triggered by reload — click the SSO button
  const ssoResult = await _auth.clickSso(tab.id, AUROR_SSO_SELECTORS);
  if (await _pollToken(AUROR_SLOW_MS)) {
    return { ok:true, reason: ssoResult ? `sso:${ssoResult}` : "manual" };
  }

  // Leave the tab open if MFA is needed
  const finalTab = await chrome.tabs.get(tab.id).catch(() => null);
  const atLogin  = (finalTab?.url ?? "").match(/unauthenticated|login/);
  return {
    ok: false,
    reason: atLogin
      ? "Sign in to Auror in the background tab, then click Analyze."
      : "Could not establish Auror session automatically.",
  };
  } finally {
    // A fresh device may require MFA. Keep our tab until a token is captured.
    if (weOpened && aurorJwt.get()) await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// ── Handlers ───────────────────────────────────────────────────────────────

export const handlers = {

  async getStatus(msg, _sender) {
    let tokenReady = !!aurorJwt.get();
    if (!tokenReady) {
      const r = await ensureAurorAuth();
      tokenReady = r.ok;
    }
    const st = await cache.stats().catch(() => ({ events: 0, persons: 0 }));
    return { tokenReady, cachedProfiles: st.persons, cachedEvents: st.events };
  },

  async analyzeThreats(msg, _sender) {
    const { targetStore, days = 30 } = msg;

    if (!aurorJwt.get()) {
      const r = await ensureAurorAuth();
      if (!r.ok) return { ok:false, error:`Auth failed: ${r.reason}` };
    }

    const seSites = await loadSeSites();
    const siteHit = seSites.find(s => walmartNum(s.name) === String(Number(targetStore)));
    const coords = getStoreCoords(targetStore)
      ?? (siteHit ? [siteHit.lat, siteHit.lon] : null)
      ?? await resolveStoreCoords(targetStore).catch(() => null);
    if (!coords) return { ok:false, error:`Unknown store: ${targetStore}` };
    const [targetLat, targetLon] = coords;
    const target = { store:targetStore, lat:targetLat, lon:targetLon };
    const market = await marketFor(targetStore, seSites);

    const progress = (p) => chrome.storage.session.set({ [`${MODULE_ID}.progress`]: p }).catch(() => {});

    // ── 1. List ORC events per region (cheap: 10 per call) ──────────────────
    // The listing is always live, so nothing new is missed. What each event
    // costs after that (EventProfile → who was on it) comes from the local
    // cache unless the event is new or still young enough to gain people.
    const full = !!msg.full;
    const siteByNum = new Map(seSites.map(s => [walmartNum(s.name), s]));
    const listed = [];
    let regionsChecked = 0;
    for (const regionNum of SE_BU_REGIONS) {
      try {
        for (const ev of await listRegionEvents(regionNum, days, EVENTS_PER_REGION)) {
          const id = String(ev.resourceLocator ?? "").replace(/^e/, "");
          if (id) listed.push({ id, occurredAt: ev.occurredAt ?? ev.localOccurredAt ?? null,
                                siteNum: walmartNum(ev.description), region: regionNum });
        }
      } catch (e) {
        console.warn(`[orcmonitor] region ${regionNum}:`, e?.message);
      }
      regionsChecked++;
      await progress({ stage:"events", regionsChecked, regionsTotal:SE_BU_REGIONS.length,
                       eventsScanned: listed.length, personsFound: 0, profilesDone: 0 });
    }
    const uniq = [...new Map(listed.map(e => [e.id, e])).values()];

    // ── 2. People on each event: cached, or one EventProfile call ───────────
    const now = Date.now();
    const cachedEvents = full ? new Map() : await cache.getEvents(uniq.map(e => e.id)).catch(() => new Map());
    const young = e => e.occurredAt && now - Date.parse(e.occurredAt) < cache.EVENT_YOUNG_DAYS * 86400000;
    const needEvent = uniq.filter(e => {
      const c = cachedEvents.get(e.id);
      return !c || (young(e) && now - (c.fetchedAt ?? 0) > cache.EVENT_RECHECK_MS);
    });
    let eventsFetched = 0;
    const freshEvents = [];
    await pool(needEvent, CONCURRENCY, async e => {
      try {
        const persons = await fetchEventPersonIds(e.id);
        const rec = { ...e, persons, fetchedAt: Date.now() };
        cachedEvents.set(e.id, rec);
        freshEvents.push(rec);
      } catch (err) {
        console.warn(`[orcmonitor] event ${e.id}:`, err?.message);
      }
      eventsFetched++;
      if (eventsFetched % 5 === 0) {
        await progress({ stage:"events", regionsChecked, regionsTotal:SE_BU_REGIONS.length,
                         eventsScanned: uniq.length, eventsNew: needEvent.length, eventsFetched,
                         personsFound: 0, profilesDone: 0 });
      }
    });
    await cache.putEvents(freshEvents).catch(e => console.warn("[orcmonitor] cache events:", e?.message));

    const personIds = new Set();
    const personNearest = new Map();     // pid → miles from target of their closest event
    const personEvents = new Map();      // pid → [eventId] seen in this run's listing
    const links = [];
    for (const e of uniq) {
      const rec = cachedEvents.get(e.id);
      if (!rec) continue;
      const site = siteByNum.get(e.siteNum);
      const miles = site ? haversine(targetLat, targetLon, site.lat, site.lon) : 9999;
      for (const pid of rec.persons ?? []) {
        personIds.add(pid);
        personNearest.set(pid, Math.min(personNearest.get(pid) ?? Infinity, miles));
        (personEvents.get(pid) ?? personEvents.set(pid, []).get(pid)).push(e.id);
      }
      const ps = rec.persons ?? [];
      for (let i = 1; i < ps.length; i++) links.push([ps[0], ps[i]]);
    }

    // ── 3. Profiles: cached unless they have an event we have not seen ──────
    // Nearest first: the cap should drop people 500 miles away, not whichever
    // region happened to be listed last.
    const toProfile = [...personIds]
      .sort((a, b) => (personNearest.get(a) ?? 9999) - (personNearest.get(b) ?? 9999))
      .slice(0, MAX_PROFILES);
    const cachedPersons = full ? new Map() : await cache.getPersons(toProfile).catch(() => new Map());
    const needPerson = new Set(toProfile.filter(pid => {
      const c = cachedPersons.get(pid);
      if (!c || now - (c.fetchedAt ?? 0) > cache.PERSON_TTL_MS) return true;
      const known = new Set(c.eventIds ?? []);
      return (personEvents.get(pid) ?? []).some(eid => !known.has(eid));
    }));

    const marketOpts = market?.stores?.length
      ? { marketStores: new Set(market.stores.map(String)), marketLabel: `Market ${market.number}` } : {};
    const threats = [];
    const sites = new Map();       // every store any profile has a marker for
    const touched = [];
    let profilesDone = 0, profilesFetched = 0;
    const publish = () => progress({
      stage:"profiles", regionsChecked, regionsTotal:SE_BU_REGIONS.length,
      eventsScanned: uniq.length, eventsNew: needEvent.length,
      personsFound: personIds.size, personsToProfile: toProfile.length, profilesDone,
      profilesNew: needPerson.size, profilesFetched,
      partialThreats: [...threats].sort((a,b) => (b.riskScore ?? 0) - (a.riskScore ?? 0)), links, target,
    });
    await pool(toProfile, CONCURRENCY, async personId => {
      try {
        let rec = cachedPersons.get(personId);
        if (needPerson.has(personId)) {
          const [profile, feed] = await Promise.all([ getPersonProfile(personId), getProfileFeed(personId) ]);
          const slimF = cache.slimFeed(feed);
          rec = { id: personId, profile: cache.slimProfile(profile), feed: slimF,
                  eventIds: cache.feedEventIds(slimF), fetchedAt: Date.now() };
          profilesFetched++;
        }
        if (!rec) return;
        touched.push({ ...rec, lastUsedAt: Date.now() });
        const { profile, feed } = rec;
        for (const m of profile?.personLocationCardView?.eventsPerMarker ?? []) {
          const lat = parseFloat(m.latitude), lon = parseFloat(m.longitude);
          if (m.name && lat && lon && !sites.has(m.name)) sites.set(m.name, { name:m.name, lat, lon });
        }
        // Auror's own associate list links people who never shared one of the
        // events we pulled. Only repeat associates (2+ shared events): a single
        // shared event we did not pull is too thin to merge two crews on.
        for (const a of profile?.associatedPersons ?? []) {
          const aid = a.id ?? a.entityIdentityGroupId ?? a.identityGroupId;
          if (aid && (a.eventCount ?? 0) >= 2) links.push([personId, String(aid)]);
        }
        const card = buildThreatCard(personId, profile, feed, targetLat, targetLon, marketOpts);
        if (card) threats.push(card);
      } catch(e) {
        console.warn(`[orcmonitor] profile ${personId}:`, e?.message);
      } finally {
        profilesDone++;
        if (profilesDone % 5 === 0 || profilesDone === toProfile.length) await publish();
      }
    });
    await cache.putPersons(touched).catch(e => console.warn("[orcmonitor] cache persons:", e?.message));
    cache.prune().catch(() => {});

    threats.sort((a,b) => (b.riskScore ?? 0) - (a.riskScore ?? 0));
    const result = {
      target,
      threats,
      links,
      sites:          [...seSites, ...sites.values()],
      market,
      eventsScanned:  uniq.length,
      totalPersons:   personIds.size,
      profiled:       toProfile.length,
      fetched:        { events: needEvent.length, people: profilesFetched, full },
      pulledAt:       Date.now(),
      days,
    };
    await cache.saveResult(targetStore, days, result).catch(e => console.warn("[orcmonitor] cache result:", e?.message));
    return result;
  },

  // Map centring: built-in table, then the cached SE store list (no tab opens).
  async storeCoords(msg, _sender) {
    const n = String(msg.store ?? "").trim();
    const fixed = getStoreCoords(n);
    if (fixed) return { coords: fixed };
    const site = (await loadSeSites()).find(s => walmartNum(s.name) === String(Number(n)));
    return { coords: site ? [site.lat, site.lon] : null };
  },

  async getPersonDetail(msg, _sender) {
    const { personId } = msg;
    if (!personId) return { ok:false, error:"personId required" };
    try {
      const [profile, feed] = await Promise.all([
        getPersonProfile(personId), getProfileFeed(personId),
      ]);
      const slimF = cache.slimFeed(feed);
      await cache.putPersons([{ id: String(personId), profile: cache.slimProfile(profile), feed: slimF,
                                eventIds: cache.feedEventIds(slimF), fetchedAt: Date.now(), lastUsedAt: Date.now() }]).catch(() => {});
      return { profile, feed };
    } catch(e) {
      return { ok:false, error:e?.message ?? String(e) };
    }
  },
};
