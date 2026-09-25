// shared/appriss.js — the one place that knows where Secure/APPRISS lives.
// ─────────────────────────────────────────────────────────────────────────────
// Appriss moved the Walmart tenant off `wmtus.apprissretailcloud.com` onto a
// shared multi-tenant host: `apps.apprissretail.com/walmart-usa/...`. The app
// itself is unchanged — every path we already used exists on the new host with
// the tenant prefix in front of it:
//
//   old  https://wmtus.apprissretailcloud.com/platform/cpf/searchlite/...
//   new  https://apps.apprissretail.com/walmart-usa/platform/cpf/searchlite/...
//
// The prefix is MANDATORY. Verified 2026-08-23: the same path without
// `/walmart-usa` returns 403, not a redirect — so a half-migrated caller fails
// hard rather than silently hitting someone else's tenant. That's why BASE
// carries the prefix and every call site concatenates onto BASE, never onto
// ORIGIN.
//
// This is a CUTOVER, not a dual-run. The old host's edge still answers with a
// redirect to its own sign-in page, so probing it looks healthy — but the
// tenant behind it is gone (confirmed by the analyst 2026-08-23). Its
// host_permission has been removed; don't re-add it as a "fallback", because a
// fallback that can never succeed only turns a clear failure into a slow one.
//
// ORIGIN (no prefix) is still needed on its own for two things that are
// host-scoped rather than path-scoped: the cookie domain and `tabs.query`
// match patterns.
//
// Before this file the origin was copy-pasted across five files in two modules
// (aurorbuddy + assocpurchases). It has now been renamed once; assume it will
// be renamed again.
import { createAuth, APPRISS_SSO_SELECTORS } from "./auth.js";
import { findOrOpenTracked, closeIfOpened } from "./tabs.js";

export const APPRISS_DOMAIN = "apps.apprissretail.com";
export const APPRISS_ORIGIN = `https://${APPRISS_DOMAIN}`;
export const APPRISS_TENANT = "/walmart-usa";
export const APPRISS_BASE   = `${APPRISS_ORIGIN}${APPRISS_TENANT}`;

// `tabs.query` / host_permissions pattern — host-scoped, no tenant prefix.
export const APPRISS_TAB_PATTERN = `${APPRISS_ORIGIN}/*`;

// Direct SP-initiated SAML entry. Going straight here skips the sign-in page
// and its "Sign In" button: when AAD/SSO is cached the chain completes
// silently and lands on the portal. Verified live 2026-08-23 — 302s to
// pfedprod `/idp/SSO.saml2` exactly as the old host did.
//
// NO RelayState. Until 2026-09 the server re-prefixed a tenant-relative
// RelayState (`/platform/portal`) itself. Verified 2026-09-15 that it no
// longer does: the ACS now redirects to `origin + "/" + RelayState`, so
// `/platform/portal` lands on `apps.apprissretail.com//platform/portal`
// (Cloudflare "Sorry, you have been blocked") and `/walmart-usa/platform/portal`
// lands on `//walmart-usa/...`, which bounces to the logon page. With the
// parameter omitted the chain finishes at `/walmart-usa/secure` → `/secure/portal`
// → `/walmart-usa/platform/portal` and the Portal renders. Don't put a
// RelayState back without re-running the redirect probe.
export const APPRISS_HOME = `${APPRISS_BASE}/secure/sso/saml2`;

// Sign-in-page detection. The new host renamed the page: `/secure/cpf/auth/logon`
// 302s to `/walmart-usa/signin`. Callers that only tested for `logon`/`login`
// read that page as "signed in" — which is worse than reading it as signed out,
// because it makes a failed reauth report success.
export const isApprissSignInUrl = (url) =>
  /\/(logon|login|signin)\b/i.test(url ?? "");

// ─────────────────────────────────────────────────────────────────────────────
// Silent background reauth
// ─────────────────────────────────────────────────────────────────────────────
//
// Every APPRISS caller in the suite hits the same wall: the server session is
// cold on the first call after the browser starts (and dies again daily), the
// JSON endpoint answers with the sign-in page, and the module tells the analyst
// to go open Secure by hand. Opening the SAML entry (APPRISS_HOME) in a
// BACKGROUND tab lets the cached AAD/SSO session finish the chain by itself;
// only if it lands on the sign-in page does the SSO button get clicked. A tab
// the analyst already has open is adopted — never navigated or reloaded — and a
// tab we opened is closed again on the way out.
//
// This was written three times (aurorbuddy, assocpurchases,
// registerls/lib/workview) before `boblisa` became the fourth caller and
// shipped without it — which is what made the analyst open Secure manually
// before every name lookup. It lives here now.
//
//   apprissReauthInBackground(probe, opts) → { ok, res?, opened?, reason? }
//   apprissAuthGate(opts)                  → { run(fn), reauthed, reason }
//
// `probe` is the caller's OWN real request, and it is the only honest readiness
// test: the session cookie can be present while the server session is dead, so
// cookie-only polling reports success too early. Pass null only when there is
// no cheap request to repeat — then "cookie present AND the tab is off the
// sign-in page" is the (weaker) signal.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Does this failed result mean "the APPRISS session is gone"? Covers the three
// shapes the suite's APPRISS callers return: errorClass "AUTH" (aurorbuddy,
// boblisa, workview), "AUTH_OR_HTTP" (open_drawer, cash_research — those
// endpoints answer a dead session and a bad search the same way), and anything
// that carries a `loginUrl` for the user to click.
export function isApprissAuthFailure(res) {
  if (!res || res.ok) return false;
  const cls = String(res.errorClass || "");
  if (cls === "AUTH" || cls === "AUTH_OR_HTTP") return true;
  return !!res.loginUrl && cls !== "NETWORK";
}

export async function apprissReauthInBackground(probe, { moduleId = "suite", waitMs = 30_000, loadMs = 15_000 } = {}) {
  const auth = createAuth(moduleId);
  let state;
  try { state = await findOrOpenTracked(APPRISS_HOME, { active: false, match: APPRISS_TAB_PATTERN }); }
  catch (e) { return { ok: false, reason: `could not open APPRISS tab: ${e?.message || e}` }; }
  const tabId = state.tab?.id;
  if (tabId == null) return { ok: false, reason: "no APPRISS tab" };
  try {
    const loadEnd = Date.now() + loadMs;
    while (Date.now() < loadEnd) {
      const t = await chrome.tabs.get(tabId).catch(() => null);
      if (!t) return { ok: false, reason: "APPRISS tab disappeared" };
      if (t.status === "complete") break;
      await sleep(200);
    }
    const landed = await chrome.tabs.get(tabId).catch(() => null);
    if (isApprissSignInUrl(landed?.url)) {
      await auth.clickSso(tabId, APPRISS_SSO_SELECTORS).catch(() => {});
    }
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (await auth.hasSessionCookie(APPRISS_DOMAIN).catch(() => false)) {
        if (!probe) {
          const t = await chrome.tabs.get(tabId).catch(() => null);
          if (t && !isApprissSignInUrl(t.url)) return { ok: true, opened: state.opened };
        } else {
          const res = await probe();
          if (res?.ok) return { ok: true, res, opened: state.opened };
          // A non-auth failure (HTTP 500, bad search, network) means the
          // session is not the problem — stop burning the wait on it.
          if (!isApprissAuthFailure(res)) return { ok: false, res, reason: "probe failed for a non-auth reason" };
        }
      }
      await sleep(1000);
    }
    return { ok: false, reason: "APPRISS session did not come back within the wait" };
  } finally {
    await closeIfOpened(state);
  }
}

// One silent reauth for a whole batch of APPRISS calls.
//
//   const gate = apprissAuthGate({ moduleId: "boblisa" });
//   const res  = await gate.run(() => fetchOpenDrawer(store, reg, date));
//
// `run` executes the call, and on an auth failure drives ONE background reauth
// and retries the call once. Every later call through the same gate reuses that
// single attempt: a run of 80 drawer fetches therefore costs at most one SSO
// tab, and a session that genuinely needs interactive MFA fails fast instead of
// opening a tab per call. Callers get the original failure back when the reauth
// did not take, so their existing `loginUrl` messaging still works.
export function apprissAuthGate({ moduleId = "suite", waitMs = 30_000 } = {}) {
  let pending = null, tried = false, reason = null;
  return {
    get reauthed() { return tried; },
    get reason() { return reason; },
    async run(fn) {
      const res = await fn();
      if (!isApprissAuthFailure(res)) return res;
      if (tried && !pending) return res;
      let mine = false;
      if (!pending) {
        mine = true;
        pending = apprissReauthInBackground(fn, { moduleId, waitMs })
          .finally(() => { tried = true; pending = null; });
      }
      const out = await pending;
      if (!out?.ok) { reason = out?.reason || null; return res; }
      // `out.res` is the probe result, and the probe was the INITIATOR's call —
      // anyone else waiting on the same reauth has to run their own.
      return (mine && out.res) || fn();
    },
  };
}
