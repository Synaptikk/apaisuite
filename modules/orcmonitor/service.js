// modules/orcmonitor/service.js
// Service-worker handlers for orcmonitor.
// Auto-authenticates to Auror in a background tab when the JWT is absent —
// the same pattern aurorbuddy uses (find/open tab → SSO auto-click → close).

import { createAuth, AUROR_SSO_SELECTORS } from "../../shared/auth.js";
import { getJwt, searchOrcEvents, getEventPersonIds,
         getPersonProfile, getProfileFeed }  from "./lib/auror_api.js";
import { buildThreatCard }                   from "./lib/trajectory.js";
import { getStoreCoords, SE_BU_REGIONS }     from "./lib/store_coords.js";

const MODULE_ID     = "orcmonitor";
const PROFILE_KEY   = `${MODULE_ID}.profileCache`;
const AUROR_HOME    = "https://app.us.auror.co/feed";
const AUROR_FAST_MS = 8_000;
const AUROR_SLOW_MS = 45_000;

// ── Auth — reads JWT captured by shell's declarative webRequest listener ──
const _auth    = createAuth(MODULE_ID);
const aurorJwt = _auth.getCapturedHeader("auror.jwt", 20 * 60 * 1000);

// ── In-memory profile cache ────────────────────────────────────────────────
const _profileCache = new Map();
chrome.storage.session.get(PROFILE_KEY).then(got => {
  for (const [k,v] of Object.entries(got?.[PROFILE_KEY] ?? {})) _profileCache.set(k,v);
}).catch(() => {});

async function _saveProfile(id, profile, feed) {
  _profileCache.set(id, { profile, feed, at: Date.now() });
  await chrome.storage.session.set({
    [PROFILE_KEY]: Object.fromEntries(_profileCache.entries()),
  }).catch(() => {});
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

  await _waitLoad(tab.id);
  if (await _pollToken(AUROR_FAST_MS)) {
    if (weOpened) chrome.tabs.remove(tab.id).catch(() => {});
    return { ok:true, reason:"captured" };
  }

  // SSO wasn't triggered by reload — click the SSO button
  const ssoResult = await _auth.clickSso(tab.id, AUROR_SSO_SELECTORS);
  if (await _pollToken(AUROR_SLOW_MS)) {
    if (weOpened) chrome.tabs.remove(tab.id).catch(() => {});
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
}

// ── Handlers ───────────────────────────────────────────────────────────────

export const handlers = {

  async getStatus(msg, _sender) {
    let tokenReady = !!aurorJwt.get();
    if (!tokenReady) {
      const r = await ensureAurorAuth();
      tokenReady = r.ok;
    }
    return { tokenReady, cachedProfiles: _profileCache.size };
  },

  async analyzeThreats(msg, _sender) {
    const { targetStore, radius = 400, days = 60 } = msg;

    if (!aurorJwt.get()) {
      const r = await ensureAurorAuth();
      if (!r.ok) return { ok:false, error:`Auth failed: ${r.reason}` };
    }

    const coords = getStoreCoords(targetStore);
    if (!coords) return { ok:false, error:`Unknown store: ${targetStore}` };
    const [targetLat, targetLon] = coords;

    const personIds = new Set();
    let regionsChecked = 0;
    for (const regionNum of SE_BU_REGIONS) {
      try {
        const d = await searchOrcEvents(`REGION: ${regionNum}`, "Last30days");
        for (const ev of (d.searchResults ?? []).slice(0, 8)) {
          const eid = (ev.resourceLocator ?? "").replace(/^e/, "");
          if (!eid) continue;
          for (const pid of await getEventPersonIds(eid)) personIds.add(pid);
        }
        regionsChecked++;
        await chrome.storage.session.set({
          [`${MODULE_ID}.progress`]: { stage:"events", regionsChecked, personsFound:personIds.size, profilesDone:0 },
        }).catch(() => {});
      } catch(e) {
        console.warn(`[orcmonitor] region ${regionNum}:`, e?.message);
      }
    }

    const threats = [];
    let profilesDone = 0;
    for (const personId of [...personIds].slice(0, 60)) {
      try {
        let profile, feed;
        const cached = _profileCache.get(personId);
        if (cached && Date.now() - (cached.at ?? 0) < 20 * 60 * 1000) {
          ({ profile, feed } = cached);
        } else {
          [profile, feed] = await Promise.all([
            getPersonProfile(personId),
            getProfileFeed(personId),
          ]);
          await _saveProfile(personId, profile, feed);
        }
        const card = buildThreatCard(personId, profile, feed, targetLat, targetLon);
        if (card) threats.push(card);
        profilesDone++;
        // Sort and publish partial results so the view can render incrementally
        threats.sort((a,b) => (b.riskScore ?? 0) - (a.riskScore ?? 0));
        await chrome.storage.session.set({
          [`${MODULE_ID}.progress`]: {
            stage:"profiles", regionsChecked,
            personsFound:personIds.size, profilesDone,
            partialThreats: threats,
            target: { store:targetStore, lat:targetLat, lon:targetLon },
          },
        }).catch(() => {});
      } catch(e) {
        console.warn(`[orcmonitor] profile ${personId}:`, e?.message);
      }
    }

    threats.sort((a,b) => (b.riskScore ?? 0) - (a.riskScore ?? 0));
    return {
      target:         { store:targetStore, lat:targetLat, lon:targetLon },
      threats,
      totalPersons:   personIds.size,
      profilesCached: _profileCache.size,
    };
  },

  async getPersonDetail(msg, _sender) {
    const { personId } = msg;
    if (!personId) return { ok:false, error:"personId required" };
    try {
      const [profile, feed] = await Promise.all([
        getPersonProfile(personId), getProfileFeed(personId),
      ]);
      await _saveProfile(personId, profile, feed);
      return { profile, feed };
    } catch(e) {
      return { ok:false, error:e?.message ?? String(e) };
    }
  },
};
