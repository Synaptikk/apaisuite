// modules/assocpurchases/service.js
//
// Service-worker handlers for assocpurchases.
// Runs in the SW; no access to host.storage — use chrome.storage with the
// "assocpurchases." prefix.

import { fetchMumdData }                              from "./lib/mumd.js";
import { fetchMarkdownPurchases, probeApprissAuth }  from "./lib/appriss_purchases.js";
import { lookupNames }                                from "../../shared/associateLookup.js";
import { createAuth, APPRISS_SSO_SELECTORS }          from "../../shared/auth.js";
import { APPRISS_DOMAIN, APPRISS_HOME, APPRISS_TAB_PATTERN,
         isApprissSignInUrl }                         from "../../shared/appriss.js";

const LOG = (...a) => console.log("[assocpurchases]", ...a);

// ── APPRISS auth ────────────────────────────────────────────────────────────

const _auth = createAuth("assocpurchases");

async function _waitForTabLoad(tabId, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return false;
    if (t.status === "complete") return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

async function ensureApprissAuth() {
  // Fast path: session cookie present + API probe passes → already authed.
  if (await _auth.hasSessionCookie(APPRISS_DOMAIN) && await probeApprissAuth()) {
    LOG("ensureApprissAuth: already authenticated");
    return { ok: true };
  }

  // Slow path: open background tab to the SAML2 endpoint.
  // When the Walmart AAD/SSO session is cached the chain completes silently;
  // otherwise land on the logon page and auto-click the SSO button.
  const existing = await chrome.tabs.query({ url: APPRISS_TAB_PATTERN });
  let tab = existing[0] ?? null;
  const weOpened = !tab;
  if (!tab) {
    tab = await chrome.tabs.create({ url: APPRISS_HOME, active: false });
    LOG("ensureApprissAuth: opened background APPRISS tab", tab.id);
  }
  await _waitForTabLoad(tab.id);

  // If we landed on the sign-in page, click the SSO button.
  const current = await chrome.tabs.get(tab.id).catch(() => null);
  if (isApprissSignInUrl(current?.url)) {
    LOG("ensureApprissAuth: on sign-in page — clicking SSO");
    await _auth.clickSso(tab.id, APPRISS_SSO_SELECTORS).catch(() => {});
  }

  // Poll up to 30 s for the session cookie / probe to flip.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await _auth.hasSessionCookie(APPRISS_DOMAIN) || await probeApprissAuth()) break;
    await new Promise(r => setTimeout(r, 600));
  }

  if (weOpened) chrome.tabs.remove(tab.id).catch(() => {});

  const ok = await probeApprissAuth();
  LOG("ensureApprissAuth:", ok ? "authenticated" : "timed out");
  return {
    ok,
    reason: ok ? "session established" : "sign in to APPRISS in the browser, then try again",
  };
}

export const handlers = {

  // ── Pull MUMD markdowns ─────────────────────────────────────────────────
  // Opens sf-reports-ui.walmart.com in a background tab (or reuses an open
  // one), runs the API fetch in the MAIN world so the browser's full auth
  // context handles SSO automatically.  msg: { storeNo, startDate, endDate }
  async "assocpurchases.pullMarkdowns"(msg) {
    const { storeNo = "1458", startDate, endDate } = msg;
    const today = new Date().toISOString().slice(0, 10);
    LOG("pullMarkdowns", { storeNo, startDate: startDate || today, endDate: endDate || today });
    const result = await fetchMumdData(storeNo, startDate || today, endDate || today);
    LOG("pullMarkdowns done:", result.rows?.length, "rows,", result.error ?? "no error");
    return { ok: true, ...result };
  },

  // ── Pull APPRISS markdown purchases ────────────────────────────────────
  // msg: { storeNo: number|string }
  // Returns: { rows: ApprissRow[], error? }
  async "assocpurchases.pullAppriss"(msg) {
    const { storeNo } = msg;
    LOG("pullAppriss", { storeNo });
    try {
      const authResult = await ensureApprissAuth();
      if (!authResult.ok) {
        return { ok: true, rows: [], error: `APPRISS sign-in required — ${authResult.reason}` };
      }
      const rows = await fetchMarkdownPurchases(storeNo);
      LOG("pullAppriss done:", rows.length, "rows");
      return { ok: true, rows };
    } catch (e) {
      const error = e?.message ?? String(e);
      LOG("pullAppriss error:", error);
      return { ok: true, rows: [], error };
    }
  },

  // ── Resolve WINs → real names via Workvivo ──────────────────────────────
  // msg: { wins: string[] }
  // Returns: { names: { [win]: string|null } }
  async "assocpurchases.resolveNames"(msg) {
    const { wins } = msg;
    LOG("resolveNames", wins?.length, "wins");
    try {
      const map    = await lookupNames(wins);
      const names  = Object.fromEntries(map);
      LOG("resolveNames done:", Object.keys(names).filter(k => names[k]).length, "resolved");
      return { ok: true, names };
    } catch (e) {
      const error = e?.message ?? String(e);
      LOG("resolveNames error:", error);
      return { ok: true, names: {}, error };
    }
  },
};
