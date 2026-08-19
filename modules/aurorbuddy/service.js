// modules/aurorbuddy/service.js
//
// Service-worker handlers for AurorBuddy. Loaded lazily by the suite SW
// dispatcher when the first AurorBuddy message arrives.
//
// Adapted from donor extension/background.js. Key changes:
//   - chrome.runtime.onMessage switch → handlers object exported for the
//     suite SW dispatcher to route by (module, type)
//   - Auror JWT capture replaces module-level webRequest listener with
//     auth.captureHeader (registered on first import — same effect)
//   - SSO auto-click → auth.clickSso(tabId, selectors)
//   - APPRISS cookie check → auth.hasSessionCookie(domain)
//   - Tab helpers → shared/tabs.js equivalents inline where convenient
//   - Nextiva HLS segment-header capture from the donor was DEAD CODE in
//     the donor (the removed evidence_downloader.js accepted but never read the
//     getSegmentHeaders callback — the CDP-based capture made it
//     unnecessary). Dropped in the migration.

import { createAuth, AUROR_SSO_SELECTORS, APPRISS_SSO_SELECTORS } from "../../shared/auth.js";
import { reloadTabAndWait } from "../../shared/auth.js";
import { searchPeople }  from "./lib/auror.js";
import { apprissLookupAll, probeApprissApiAuth } from "./lib/appriss.js";
import { findNearbyStores } from "./lib/stores.js";
import { fillAurorEvent, fromTransaction as fromTransactionForEvent } from "./lib/auror_event.js";
import { Timings } from "./lib/timings.js";
import { suspectsFromRaws, suspectToWire } from "./lib/models.js";
import { classifyAll } from "./lib/event_classifier.js";
import {
  captureAurorIdentityFromJwt,
  writeScan,
  writeEvent,
  writeFinalEventValue,
  fetchAwaitingFinalValue,
} from "./lib/firestore.js";
import { startWorkflow, transitionWorkflow, failWorkflow } from "./lib/workflow_status.js";
import { recordMetric, recordError } from "./lib/usage_metrics.js";

// ── Constants ──────────────────────────────────────────────────────────
const MODULE_ID    = "aurorbuddy";
const AUROR_HOME   = "https://app.us.auror.co/";
// /platform/cpf/ throws a 500 on a fresh device session. /platform/portal
// redirects to /secure/cpf/auth/logon (manual sign-in page with a Sign In
// button → /secure/sso/saml2 → IdP → portal). Going DIRECTLY to the SAML
// endpoint skips the logon page + click-Sign-In entirely: when AAD/SSO is
// cached (the common case) the chain completes silently and lands on
// /platform/portal#/index. Same trick SparkFraud uses for pfedprod.
// Verified live via CDP: cookies-cleared tab opened at the SAML URL
// arrives at /platform/portal#/index?page=executive within ~6s with no
// clicks needed.
const APPRISS_HOME = "https://wmtus.apprissretailcloud.com/secure/sso/saml2?RelayState=/platform/portal";
const APPRISS_DOMAIN = "wmtus.apprissretailcloud.com";

const JWT_TTL_MS = 20 * 60 * 1000;

// ── Auth wiring — JWT capture is registered by the shell SW from this
//    module's manifest.webRequestFilters (synchronous, persistent). Here we
//    only need a reader for the cached value.
const auth = createAuth(MODULE_ID);

// Reads chrome.storage.session.<MODULE_ID>.auror.jwt — keep the storageKey
// in sync with module.js::manifest.webRequestFilters[0].storageKey.
const aurorJwt = auth.getCapturedHeader("auror.jwt", JWT_TTL_MS);

const getAurorToken = () => aurorJwt.get();

// ── Scan cancellation ──────────────────────────────────────────────────
let activeScanAbort = null;
function freshScanSignal() {
  if (activeScanAbort) {
    try { activeScanAbort.abort("superseded by newer scan"); } catch {}
  }
  activeScanAbort = new AbortController();
  return activeScanAbort.signal;
}

// ── Tab helpers (small enough to keep inline) ──────────────────────────
async function findTab(urlPattern) {
  const tabs = await chrome.tabs.query({ url: urlPattern });
  return tabs[0] ?? null;
}

async function waitForTabLoad(tabId, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return false;
    if (t.status === "complete") return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function pollForAurorToken(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (getAurorToken()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// ── Auror person resolve helper (called by create_event) ───────────────
async function resolveAurorPerson(personId) {
  const token = getAurorToken();
  if (!token || !personId) return null;
  const term = /^p/i.test(personId) ? personId.toUpperCase() : `P${personId}`;
  try {
    const r = await fetch(
      `https://app.us.auror.co/api/spa/EditEvent/personIdentitySearch?searchString=${encodeURIComponent(term)}`,
      { headers: { Authorization: token }, credentials: "include", signal: AbortSignal.timeout(8_000) }
    );
    if (!r.ok) return null;
    const json = await r.json();
    const hit = Array.isArray(json) ? json[0] : json?.results?.[0] ?? null;
    if (!hit) return null;
    return {
      identityGroupId: hit.identityGroupId ?? hit.id ?? null,
      displayName:     hit.displayName ?? hit.name ?? hit.fullName ?? null,
      pNumber:         hit.pNumber ?? hit.personNumber ?? term,
    };
  } catch {
    return null;
  }
}

// ── Auror auth flow ────────────────────────────────────────────────────
// Direct Auth0 connection URL for the Walmart SAML tenant. "wm-us" matches
// the connection name baked into the JWT `sub` claim (samlp|wm-us|<username>),
// so going here skips the unauthenticated landing page, the "Sign in with
// SSO" button click, AND the Auth0 universal-login identifier-page email
// auto-fill — Auth0 sees the connection in the URL and routes straight to
// the Walmart IdP. When AAD/SSO is cached the whole thing flips through to
// a JWT-bearing portal load in one network round-trip.
//
// Same architectural shape as the Appriss APPRISS_HOME above. Earlier
// versions navigated to /unauthenticated?r=%2F and relied on
// auth.clickSso + fillAurorIdentifierWhenReached to walk through the
// universal-login flow; that worked but broke whenever Auror tweaked the
// page or the email-input selector.
const AUROR_LOGIN_URL = "https://app.us.auror.co/login/sso/wm-us";
const AUROR_FAST_MS = 5_000;
const AUROR_SLOW_MS = 60_000;

// ── Auror Auth0 identifier-page auto-fill ──────────────────────────────
// Some Auror tenants (notably Walmart-managed Edge) get a simplified login
// flow: clicking "Sign in" lands on login.us.auror.co/u/login/identifier
// which has a single <input id="username"> + "Continue" submit. Auth0 won't
// auto-redirect to SSO until that form is submitted with a recognized
// email. We watch for that URL on the auth tab and auto-fill from
// chrome.storage.sync["aurorbuddy.aurorUsername"] (set by the user in the
// AurorBuddy "Auror auto-login settings" panel). If no username is
// configured but a JWT is currently cached, derive the username from its
// `sub` claim (Auror's Auth0 issues subs like "samlp|wm-us|<username>") and
// guess @walmart.com — works for the common case where the user has logged
// in via the suite at least once.

function _deriveUsernameFromCachedJwt() {
  try {
    const token = getAurorToken();
    if (!token) return "";
    const jwt = token.replace(/^Bearer\s+/i, "");
    const payloadPart = jwt.split(".")[1];
    if (!payloadPart) return "";
    const json = atob(payloadPart.replace(/-/g, "+").replace(/_/g, "/"));
    const claims = JSON.parse(json);
    const sub = String(claims?.sub ?? "");
    // sub format observed in the wild: "samlp|wm-us|ses008s.s01458"
    const m = sub.match(/\|([^|]+)$/);
    if (!m) return "";
    const id = m[1].trim();
    if (!id) return "";
    // Heuristic: append @walmart.com if the id has no @ already.
    return id.includes("@") ? id : `${id}@walmart.com`;
  } catch {
    return "";
  }
}

async function fillAurorIdentifierWhenReached(tabId, {
  maxWaitMs = 30_000,
  pollMs = 500,
} = {}) {
  const stored = await chrome.storage.sync.get(`${MODULE_ID}.aurorUsername`);
  let username = stored?.[`${MODULE_ID}.aurorUsername`] || "";
  if (!username) {
    username = _deriveUsernameFromCachedJwt();
    if (username) console.log("[AurorBuddy.fillAurorIdentifier] no stored username — derived from cached JWT:", username);
  }
  if (!username) {
    console.log("[AurorBuddy.fillAurorIdentifier] no username configured and no cached JWT to derive from; skipping (set one in the AurorBuddy auto-login settings)");
    return false;
  }

  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return false;
    if (!/login\.us\.auror\.co\/u\/login\/identifier/.test(t.url || "")) continue;

    console.log("[AurorBuddy.fillAurorIdentifier] identifier page detected — filling username");
    try {
      const [{ result } = {}] = await chrome.scripting.executeScript({
        target: { tabId },
        args: [username],
        func: (name) => {
          const input = document.querySelector('input#username, input[name="username"], input[autocomplete="email"]');
          if (!input) return { ok: false, reason: "no username input" };
          // Use a native setter so React/Auth0's framework picks up the change.
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
          setter.call(input, name);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          const submit = document.querySelector('button[type="submit"], button[name="action"]');
          if (!submit) return { ok: false, reason: "no submit button" };
          submit.click();
          return { ok: true };
        },
      });
      console.log("[AurorBuddy.fillAurorIdentifier] inject result:", result);
      if (result?.ok) {
        // After submitting the identifier, Auth0 may EITHER redirect silently
        // to SAML (if the account is SAML-only and AAD is cached) OR land on
        // a password page that needs manual input. Wait a tick to let the
        // navigation settle, then if we ended up on the password page,
        // foreground the tab so the user can see it and finish.
        await new Promise((r) => setTimeout(r, 2500));
        const after = await chrome.tabs.get(tabId).catch(() => null);
        if (after && /login\.us\.auror\.co\/u\/login\/(password|reset|mfa)/.test(after.url || "")) {
          console.log("[AurorBuddy.fillAurorIdentifier] landed on", after.url, "— foregrounding tab for user");
          try {
            await chrome.tabs.update(tabId, { active: true });
            if (after.windowId != null) {
              await chrome.windows.update(after.windowId, { focused: true });
            }
          } catch {}
        }
      }
      return !!result?.ok;
    } catch (e) {
      console.warn("[AurorBuddy.fillAurorIdentifier] inject threw:", e?.message ?? e);
      return false;
    }
  }
  console.log("[AurorBuddy.fillAurorIdentifier] timed out waiting for identifier page");
  return false;
}

async function ensureAurorAuth() {
  console.log("[AurorBuddy.ensureAurorAuth] start");
  if (getAurorToken()) {
    console.log("[AurorBuddy.ensureAurorAuth] cached token hit");
    return { ok: true, token: getAurorToken(), reason: "cached" };
  }

  let tab = await findTab("https://app.us.auror.co/*");
  const opened = !tab;
  console.log("[AurorBuddy.ensureAurorAuth] tab lookup:", { existed: !opened, id: tab?.id, url: tab?.url });
  if (!tab) tab = await chrome.tabs.create({ url: AUROR_HOME, active: false });
  console.log("[AurorBuddy.ensureAurorAuth] using tab", { id: tab.id, url: tab.url });

  if (!opened) {
    try { await chrome.tabs.reload(tab.id, { bypassCache: false }); } catch {}
  }
  await waitForTabLoad(tab.id).catch(() => {});
  const afterLoadFast = await chrome.tabs.get(tab.id).catch(() => null);
  console.log("[AurorBuddy.ensureAurorAuth] after fast-path load:", { url: afterLoadFast?.url, status: afterLoadFast?.status });

  if (await pollForAurorToken(AUROR_FAST_MS)) {
    console.log("[AurorBuddy.ensureAurorAuth] FAST PATH success — token captured");
    captureAurorIdentityFromJwt(getAurorToken()).catch(() => {});
    return { ok: true, token: getAurorToken(), reason: "captured (fast)" };
  }
  console.log("[AurorBuddy.ensureAurorAuth] fast path missed, entering slow path");

  try { await chrome.tabs.update(tab.id, { url: AUROR_LOGIN_URL }); } catch (e) {
    console.warn("[AurorBuddy.ensureAurorAuth] tabs.update threw:", e?.message ?? e);
  }
  await waitForTabLoad(tab.id).catch(() => {});
  const afterLoadSlow = await chrome.tabs.get(tab.id).catch(() => null);
  console.log("[AurorBuddy.ensureAurorAuth] after slow-path navigation:", { url: afterLoadSlow?.url, status: afterLoadSlow?.status });

  const ssoResult = await auth.clickSso(tab.id, AUROR_SSO_SELECTORS);
  console.log("[AurorBuddy.ensureAurorAuth] clickSso returned:", ssoResult);

  // Some Auror tenants serve a simplified "Sign in" button that redirects to
  // an Auth0 universal-login *identifier* page (login.us.auror.co/u/login/identifier)
  // which then asks for the user's email before routing to SSO. Without the
  // email, the flow stalls — donor "worked" only because the user was typing
  // the email manually. Watch for that page and auto-fill if we have a
  // username saved in chrome.storage.sync.
  fillAurorIdentifierWhenReached(tab.id).catch((e) =>
    console.warn("[AurorBuddy.ensureAurorAuth] identifier auto-fill watcher errored:", e?.message ?? e)
  );

  if (await pollForAurorToken(AUROR_SLOW_MS)) {
    console.log("[AurorBuddy.ensureAurorAuth] SLOW PATH success — token captured");
    captureAurorIdentityFromJwt(getAurorToken()).catch(() => {});
    return {
      ok: true,
      token: getAurorToken(),
      reason: ssoResult ? `SSO auto-clicked (${ssoResult})` : "signed in manually",
    };
  }

  const afterTab = await chrome.tabs.get(tab.id).catch(() => null);
  console.log("[AurorBuddy.ensureAurorAuth] slow path timed out; final tab state:", { url: afterTab?.url, status: afterTab?.status, ssoResult });
  if (!afterTab) {
    return { ok: false, reason: "Auror tab was closed before the JWT could be captured." };
  }
  const u = (afterTab.url || "").toLowerCase();
  if (u.includes("/unauthenticated") || u.includes("/login") || u.includes("/sso")) {
    return {
      ok: false,
      reason: ssoResult
        ? "Auto-clicked SSO but the sign-in didn't complete in 60s. Finish the MFA / login in the Auror tab, then click Search again."
        : "Auror needs sign-in and I couldn't find the SSO button on the page. Sign in manually in the Auror tab, then click Search again.",
    };
  }
  return {
    ok: false,
    reason: "Auror tab loaded but we didn't see a JWT on any auror.co request within " +
            `${Math.round(AUROR_SLOW_MS / 1000)}s. Switch to the Auror tab, click anywhere or scroll, then retry.`,
  };
}

// ── APPRISS auth flow ──────────────────────────────────────────────────
//
// Two-attempt autonomous reauth. First attempt: open/find the APPRISS
// tab in the background and let clickSso drive the SAML chain. If
// 30s of polling cookie+probe doesn't succeed, reload the tab once and
// poll again for another 30s. Only after both rounds fail do we return
// ok:false — and even then, the message is passive ("autonomous reauth
// did not complete"); callers must NOT surface user-action prompts per
// the suite-wide policy. The caller's data simply doesn't render this
// cycle; the next time anything triggers ensureApprissAuth (next scan,
// next dashboard mount) the autonomous cycle runs again.

// Drive one cycle of "click SSO + poll for cookie/probe." Returns true
// on success. Caller is responsible for opening/reloading the tab — this
// just does the per-attempt detection work.
async function _apprissPollForAuth(tabId, waitMs) {
  // Re-check landing state in case caller skipped the click.
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab?.url?.includes("/logon") || tab?.url?.includes("/login")) {
    await auth.clickSso(tabId, APPRISS_SSO_SELECTORS).catch((e) =>
      console.warn("[AurorBuddy.ensureApprissAuth] clickSso threw:", e?.message)
    );
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (await auth.hasSessionCookie(APPRISS_DOMAIN)) return { ok: true, reason: "cookie appeared" };
    if (await probeApprissApiAuth()) return { ok: true, reason: "api probe ok" };
    await new Promise((r) => setTimeout(r, 600));
  }
  return { ok: false };
}

async function ensureApprissAuth({ waitMs = 30_000 } = {}) {
  console.log("[AurorBuddy.ensureApprissAuth] start");
  const cookieOk = await auth.hasSessionCookie(APPRISS_DOMAIN);
  console.log("[AurorBuddy.ensureApprissAuth] hasSessionCookie:", cookieOk);
  if (cookieOk) {
    const probeOk = await probeApprissApiAuth();
    console.log("[AurorBuddy.ensureApprissAuth] probeApprissApiAuth:", probeOk);
    if (probeOk) {
      console.log("[AurorBuddy.ensureApprissAuth] SHORT-CIRCUIT — already authenticated, no tab needed");
      return { ok: true, reason: "cookie + api probe ok" };
    }
  }

  // Open / find the APPRISS tab in BACKGROUND. The shell auto-clicks
  // SSO; if SAML/AAD is cached the chain completes silently.
  let tab = await findTab(`https://${APPRISS_DOMAIN}/*`);
  const opened = !tab;
  console.log("[AurorBuddy.ensureApprissAuth] tab lookup:", { existed: !opened, id: tab?.id, url: tab?.url });
  if (!tab) {
    tab = await chrome.tabs.create({ url: APPRISS_HOME, active: false });
    console.log("[AurorBuddy.ensureApprissAuth] created tab:", { id: tab?.id, url: tab?.url });
  }
  await waitForTabLoad(tab.id).catch(() => {});

  // Attempt 1: clickSso + poll.
  const first = await _apprissPollForAuth(tab.id, waitMs);
  if (first.ok) {
    console.log(`[AurorBuddy.ensureApprissAuth] attempt 1 ok — ${first.reason}`);
    // Cookies persist independently of this tab. Close it on success if
    // WE opened it so the user isn't left with mystery background tabs.
    if (opened) {
      chrome.tabs.remove(tab.id).catch((e) =>
        console.warn("[AurorBuddy.ensureApprissAuth] post-success tab close failed:", e?.message)
      );
    }
    return { ok: true, reason: opened ? "opened + signed in (background)" : "signed in (background)" };
  }

  // Attempt 2: reload the auth tab and poll again. Most "first attempt
  // missed" cases are timing — SAML round-trip took longer than 30s, or
  // AAD was in the middle of refreshing its cookie. A reload kicks off
  // a fresh chain and the second poll usually catches it silently.
  console.log("[AurorBuddy.ensureApprissAuth] attempt 1 timed out; reloading tab for autonomous reauth attempt 2");
  const tabStillThere = await chrome.tabs.get(tab.id).catch(() => null);
  if (!tabStillThere) {
    // User closed the auth tab mid-attempt. Open a fresh one and try again.
    tab = await chrome.tabs.create({ url: APPRISS_HOME, active: false });
    await waitForTabLoad(tab.id).catch(() => {});
  } else {
    const reloaded = await reloadTabAndWait(tab.id, {
      settleMs: 2500,
      timeoutMs: 30_000,
      waitForReady: async (tabId) => {
        const t = await chrome.tabs.get(tabId).catch(() => null);
        return !!t?.url && t.url.includes(APPRISS_DOMAIN) && t.status === "complete";
      },
    });
    if (!reloaded.ok) {
      console.log(`[AurorBuddy.ensureApprissAuth] reauth reload failed: ${reloaded.reason}`);
    }
  }

  const second = await _apprissPollForAuth(tab.id, waitMs);
  if (second.ok) {
    console.log(`[AurorBuddy.ensureApprissAuth] attempt 2 ok — ${second.reason}`);
    if (opened) {
      chrome.tabs.remove(tab.id).catch(() => {});
    }
    return { ok: true, reason: `signed in (autonomous reauth attempt 2: ${second.reason})` };
  }

  // Both autonomous attempts failed. Likely AAD genuinely needs interactive
  // MFA renewal (rare; ~every 90 days). Return ok:false with a passive
  // message — caller surfaces it as a status line, NOT a click-to-act
  // prompt. The next caller will trigger a fresh autonomous cycle.
  const finalTab = await chrome.tabs.get(tab.id).catch(() => null);
  console.log("[AurorBuddy.ensureApprissAuth] both autonomous attempts exhausted; final tab state:", { url: finalTab?.url, status: finalTab?.status });
  if (finalTab?.url && !finalTab.url.includes("/logon") && !finalTab.url.includes("/login")) {
    // Off logon = probably signed in but missed the cookie/probe race.
    if (opened) chrome.tabs.remove(tab.id).catch(() => {});
    return { ok: true, reason: "off logon page (autonomous attempt 2)" };
  }
  return {
    ok: false,
    reason: "Autonomous APPRISS reauth did not complete (2 attempts). " +
            "Background SAML chain may need interactive MFA — will retry on next operation.",
  };
}

// ── Broadcast helper for streaming progress to the UI ──────────────────
function broadcast(type, payload = {}) {
  chrome.runtime.sendMessage({ module: MODULE_ID, type, ...payload })
    .catch(() => { /* UI may be closed; ignore */ });
}

// ── V1.5 DOM-scrape probe helper (FINAL_VALUE_CAPTURE_PLAN.md §2 Option B) ──
// Called by the probe_auror_event_value_scrape handler AND fired in parallel
// from mark_event_submitted. Pure observation — never writes to
// finalEventValue. The companion metric event captures candidates + the
// comparison-to-user value so we can decide later whether scrape is reliable.
async function _probeAurorEventValueScrape(aurorEventId) {
  try {
    const tabs = await chrome.tabs.query({ url: `https://app.us.auror.co/event/${aurorEventId}*` });
    const tab = tabs[0] || null;
    if (!tab) return { ok: true, candidates: [], reason: "no_open_tab" };
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        function parseMoney(s) {
          if (typeof s !== "string") return null;
          const m = s.match(/-?\$?\s*([\d,]+(?:\.\d{1,2})?)/);
          if (!m) return null;
          const n = Number(m[1].replace(/,/g, ""));
          return Number.isFinite(n) ? n : null;
        }
        const candidates = [];
        function probe(selector, kind) {
          try {
            const els = document.querySelectorAll(selector);
            els.forEach((el, i) => {
              const text = (el.innerText || el.textContent || el.value || "").trim();
              if (!text) return;
              const sample = text.length > 80 ? text.slice(0, 80) + "…" : text;
              candidates.push({
                selector: selector + (els.length > 1 ? `[${i}]` : ""),
                kind,
                rawText: sample,
                parsedValue: parseMoney(text),
              });
            });
          } catch {}
        }
        probe('[data-locator*="Value" i] input',             "data-locator-value-input");
        probe('[data-locator*="Value" i]',                   "data-locator-value");
        probe('[data-locator*="Loss" i]',                    "data-locator-loss");
        probe('[data-locator*="Amount" i]',                  "data-locator-amount");
        probe('[aria-label*="Value" i] input',               "aria-value-input");
        probe('[aria-label*="Value" i]',                     "aria-value");
        probe('[data-testid*="value" i]',                    "testid-value");
        probe('[data-testid*="loss" i]',                     "testid-loss");
        probe('label + input[type="number"]',                "labeled-number-input");
        probe('label + input[type="text"]',                  "labeled-text-input");
        probe('dt + dd',                                     "dt-dd-pair");
        return { candidates, url: location.href, title: document.title };
      },
    });
    return { ok: true, ...(result || { candidates: [] }) };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err), candidates: [] };
  }
}

// Fire-and-forget: scrape the Auror page, compare to the user-confirmed
// value, emit a metric event with the comparison verdict. NEVER writes to
// finalEventValue. Verdict categories per FINAL_VALUE_CAPTURE_PLAN.md §2:
//   - "match":              at least one candidate parsedValue === userValue
//   - "value_disagrees":    at least one candidate parsed, none matched user
//   - "selector_miss":      no candidates parsed a value
//   - "no_tab":             no open Auror tab on /event/{id}
function _fireScrapeObservation(aurorEventId, userValue) {
  _probeAurorEventValueScrape(aurorEventId).then((probe) => {
    const candidates = probe?.candidates || [];
    const parsed = candidates.filter((c) => c.parsedValue != null);
    let verdict;
    if (probe?.reason === "no_open_tab") verdict = "no_tab";
    else if (!parsed.length)             verdict = "selector_miss";
    else if (parsed.some((c) => Math.abs(c.parsedValue - userValue) < 0.005)) verdict = "match";
    else                                 verdict = "value_disagrees";

    const top = parsed.slice(0, 3).map((c) => `${c.kind}:$${c.parsedValue}`).join("|");
    recordMetric({
      moduleName:  "aurorbuddy",
      actionName:  "auror_page_value_scrape_attempt",
      result:      verdict === "match" ? "success" : "failure",
      contextHint: `verdict=${verdict},user=$${userValue},candidates=${parsed.length},top=${top}`,
      errorCode:   verdict === "match" ? null : `scrape_${verdict}`,
    }).catch(() => {});
  }).catch(() => {});
}

// ── Exported handlers ──────────────────────────────────────────────────
export const handlers = {
  async preflight() {
    const t = new Timings();
    const [auror, appriss] = await t.measure("preflight.total", () =>
      Promise.all([
        t.measure("preflight.auror",   () => ensureAurorAuth()),
        t.measure("preflight.appriss", () => ensureApprissAuth()),
      ])
    );
    return { ok: true, auror, appriss, timings: t.toDict() };
  },

  async find_stores(msg) {
    const t = new Timings();
    const { store, miles } = msg;
    const result = await t.measure("find_stores.total", () =>
      findNearbyStores(store, miles)
    );
    return { ok: true, result, timings: t.toDict() };
  },

  async scan_auror(msg) {
    const manifest = chrome.runtime.getManifest?.() ?? {};
    console.log(`[AurorBuddy v${manifest.version || "?"}] scan_auror starting`);

    const t = new Timings();
    const t0 = Date.now();
    const signal = freshScanSignal();
    const a = await t.measure("auror.auth_topup", () => ensureAurorAuth());
    if (!a.ok) {
      recordError("aurorbuddy", "search_auror_person", "auth_failed", a.reason).catch(() => {});
      return { ok: false, error: a.reason, timings: t.toDict() };
    }

    const { stores, homeStore, days } = msg;
    let suspects, diag;
    try {
      ({ suspects, diag } = await t.measure("auror.total", () =>
        searchPeople({ token: a.token, stores, homeStore, days, signal })
      ));
    } catch (err) {
      const isAuthErr = /401|403/.test(String(err?.message ?? ""));
      if (!isAuthErr) {
        recordError("aurorbuddy", "search_auror_person", "auror_api_error", String(err?.message ?? "")).catch(() => {});
        throw err;
      }
      if (signal.aborted) return { ok: false, error: "cancelled", cancelled: true, timings: t.toDict() };
      console.warn("[AurorBuddy.scan_auror] 401/403 with cached JWT — invalidating + re-authing");
      aurorJwt.clear();
      const a2 = await t.measure("auror.auth_topup_retry", () => ensureAurorAuth());
      if (!a2.ok) {
        recordError("aurorbuddy", "search_auror_person", "auth_retry_failed", a2.reason).catch(() => {});
        return { ok: false, error: a2.reason, timings: t.toDict() };
      }
      ({ suspects, diag } = await t.measure("auror.total_retry", () =>
        searchPeople({ token: a2.token, stores, homeStore, days, signal })
      ));
    }
    if (signal.aborted) {
      recordMetric({ moduleName: "aurorbuddy", actionName: "search_auror_person", result: "canceled", durationMs: Date.now() - t0, contextHint: `store=${homeStore}` }).catch(() => {});
      return { ok: false, error: "cancelled", cancelled: true, timings: t.toDict() };
    }
    recordMetric({
      moduleName: "aurorbuddy",
      actionName: "search_auror_person",
      result: "success",
      durationMs: Date.now() - t0,
      contextHint: `store=${homeStore},suspects=${Array.isArray(suspects) ? suspects.length : 0}`,
    }).catch(() => {});
    // tool_scans is written by the view after appriss_lookup completes, via
    // the record_scan_complete handler — that's the only point where we
    // know actionableSuspects + secureMatched. Don't write here.
    return { ok: true, suspects, diag, timings: t.toDict() };
  },

  async appriss_lookup(msg) {
    const t = new Timings();
    const signal = freshScanSignal();
    const apAuth = await t.measure("appriss.auth_topup", () =>
      ensureApprissAuth({ waitMs: 30_000 })
    );
    if (!apAuth.ok) return { ok: false, error: apAuth.reason, timings: t.toDict() };

    const { suspects, homeStore, concurrency } = msg;
    const onProgress = (evt) => broadcast("appriss_progress", evt);
    const { suspects: matched, errors } = await t.measure("appriss.total", () =>
      apprissLookupAll(
        suspects, homeStore,
        { concurrency: concurrency ?? 5, onProgress, signal },
      )
    );
    if (signal.aborted) return { ok: false, error: "cancelled", cancelled: true, timings: t.toDict() };

    // ── Event-level model + classification (passthrough) ──────
    // Convert raw scraper dicts to typed Suspect objects and run the per-event
    // classifier. PASSTHROUGH today — no `documentedKeys` is supplied so every
    // event keeps status="unknown", and suspectToWire() emits BOTH the new
    // `events` flat list AND the legacy `appriss_cards` shape so the existing
    // UI keeps rendering byte-for-byte unchanged. Once the Auror per-person
    // events API is sniffed, this is where the sniffed `documentedKeys` set
    // gets passed into classifyAll.
    const wire = await t.measure("appriss.classify", async () => {
      const typed = suspectsFromRaws(matched);
      classifyAll(typed, homeStore, null);
      return typed.map(suspectToWire);
    });
    return { ok: true, matched: wire, errors, timings: t.toDict() };
  },

  // CCTV evidence download was removed along with the "debugger" permission.
  // It read m3u8 segment bodies via CDP Network.getResponseBody, and MV3 offers
  // no other way to do that — webRequest cannot read response bodies. Kept as
  // an explicit handler so the UI shows a real explanation rather than failing
  // with a generic "unknown message type".
  async download_evidence() {
    return {
      ok: false,
      removed: true,
      error: "Evidence download has been removed. It needed the debugger permission, " +
             "which was dropped so the suite could ship through the Chrome Web Store. " +
             "Download the clip from Auror directly.",
    };
  },

  async create_event(msg) {
    console.log("[AurorBuddy] create_event msg received", {
      store:        msg?.store,
      suspectName:  msg?.suspectName,
      personId:     msg?.personId,
      storeDetails: msg?.storeDetails,
      txnId:        msg?.transaction?.transaction_id,
      // Truthy-only — no PII values in the log line.
      hasLicensePersonInfo: !!msg?.licensePersonInfo,
    });
    const t = new Timings();
    const t0 = Date.now();
    const { store, suspectName, personId, storeDetails, transaction, licensePersonInfo } = msg;
    if (!store || !transaction) {
      return { ok: false, error: "store and transaction are required" };
    }
    // Start a workflow row in /tool_workflows — best-effort, never blocks.
    let workflowId = null;
    try {
      workflowId = await startWorkflow({
        suspectName:          String(suspectName || ""),
        suspectAurorPersonId: personId ? String(personId) : null,
        storeNumber:          String(store || ""),
      });
    } catch (err) {
      console.warn("[AurorBuddy.create_event] startWorkflow failed:", err?.message || err);
    }
    const data = fromTransactionForEvent(transaction, {
      store, suspectName, personId, storeDetails, licensePersonInfo,
    });
    // Stash the transaction snapshot on the workflow (NEVER the value field).
    if (workflowId) {
      const txnTotal = Number(transaction?.amount ?? transaction?.total ?? 0) || 0;
      transitionWorkflow(workflowId, "import_prefilled", {
        patch: {
          transactionContext: {
            transactionTotalCandidateSum: txnTotal,
            candidateCount: 1,
            transactions: [{
              transactionId:             String(transaction?.transaction_id ?? ""),
              transactionStore:          String(transaction?.store ?? store ?? ""),
              transactionRegister:       String(transaction?.register ?? ""),
              transactionDate:           String(transaction?.datetime ?? ""),
              transactionTotalCandidate: txnTotal,
              paymentSummaryRedacted:    "",
            }],
          },
        },
      }).catch(() => {});
    }
    const resolved = await t.measure("fill.person_resolve", () =>
      resolveAurorPerson(personId)
    );
    if (resolved) {
      data.resolvedPersonName = resolved.displayName;
      data.resolvedPersonId   = resolved.identityGroupId;
      console.log("[AurorBuddy] person pre-resolved:", resolved);
      if (workflowId) {
        transitionWorkflow(workflowId, "auror_person_matched", {
          patch: {
            aurorPersonMatchStatus: "matched",
            aurorPersonId:          String(resolved.identityGroupId || ""),
          },
        }).catch(() => {});
      }
    } else if (workflowId) {
      transitionWorkflow(workflowId, "auror_person_no_match", {
        patch: { aurorPersonMatchStatus: "no_match" },
      }).catch(() => {});
    }
    const onLog = (line) => broadcast("fill_progress", { line });
    try {
      const result = await t.measure("fill.total", () =>
        fillAurorEvent(data, { onLog })
      );
      console.log("[AurorBuddy] create_event done", { status: result?.status, url: result?.url });
      // Try to capture aurorEventId from the result URL — /event/(\d+).
      const eventIdMatch = String(result?.url || "").match(/\/event\/(\d+)/);
      const aurorEventId = eventIdMatch ? eventIdMatch[1] : null;
      if (workflowId) {
        transitionWorkflow(workflowId, "auror_draft_filled", {
          patch: {
            aurorEventDraftStatus: "filled",
            aurorEventUrl: String(result?.url || ""),
            aurorEventId,
          },
        }).catch(() => {});
        transitionWorkflow(workflowId, "awaiting_user_completion", {
          patch: { aurorSubmitStatus: "unknown" },
          note: "filler completed; awaiting user Publish",
        }).catch(() => {});
      }
      // If we already have the aurorEventId from the draft URL, create the
      // tool_events row preemptively so the dashboard surfaces it in
      // "Awaiting final value." The actual Publish detection still happens
      // post-fill (V1.5/V2 per FINAL_VALUE_CAPTURE_PLAN). For V1 the
      // analyst clicks "Mark Submitted" from the UI to confirm.
      if (aurorEventId) {
        writeEvent({
          aurorEventId,
          workflowId,
          aurorEventUrl: String(result?.url || ""),
          aurorEventStatus: "draft",
          suspectName: String(suspectName || ""),
          suspectAurorPersonId: personId ? String(personId) : null,
          storeNumber: String(store || ""),
          transactionTotalCandidate: Number(transaction?.amount ?? 0) || 0,
          transactionTotalCandidateSource: "appriss",
        }).catch(() => {});
      }
      recordMetric({
        moduleName: "aurorbuddy",
        actionName: "import_to_auror",
        result: result?.status === "filled" ? "success" : "failure",
        durationMs: Date.now() - t0,
        workflowId,
        contextHint: `store=${store}` + (aurorEventId ? `,aurorEventId=${aurorEventId}` : ""),
      }).catch(() => {});
      return { ok: result.status === "filled", workflowId, aurorEventId, ...result, timings: t.toDict() };
    } catch (err) {
      console.error("[AurorBuddy] create_event threw:", err);
      if (workflowId) failWorkflow(workflowId, "fill_threw", String(err?.message ?? "")).catch(() => {});
      recordError("aurorbuddy", "import_to_auror", "fill_threw", String(err?.message ?? "")).catch(() => {});
      return {
        ok: false,
        status: "error",
        error: String(err?.message ?? err),
        stack: err?.stack ?? null,
        workflowId,
        timings: t.toDict(),
      };
    }
  },

  // V1 final-value capture: the UI calls this when the analyst clicks
  // "Mark Submitted" in the AurorBuddy module (FINAL_VALUE_CAPTURE_PLAN.md §2 Option A).
  // The handler ONLY writes confirmed values; if value is null/undefined,
  // we record "user skipped" with unknown confidence.
  async mark_event_submitted(msg) {
    const { aurorEventId, workflowId, finalEventValue, skipped } = msg || {};
    if (!aurorEventId) return { ok: false, error: "aurorEventId required" };
    try {
      if (skipped || finalEventValue == null) {
        await writeFinalEventValue({
          aurorEventId,
          finalEventValue: null,
          finalEventValueSource: null,
          finalEventValueConfidence: "unknown",
          finalEventValueUnknownReason: "user_skipped_mark_submitted",
        });
        if (workflowId) {
          transitionWorkflow(workflowId, "submitted_detected", {
            patch: { aurorSubmitStatus: "submitted_detected" },
          }).catch(() => {});
          transitionWorkflow(workflowId, "final_value_captured", {
            patch: {
              finalEventValueConfidence: "unknown",
              finalEventValueUnknownReason: "user_skipped_mark_submitted",
              valueDisplayLabel: "Final event value unknown",
            },
            note: "user_skipped",
          }).catch(() => {});
        }
        recordMetric({
          moduleName: "aurorbuddy",
          actionName: "final_value_captured",
          result: "skipped",
          workflowId,
        }).catch(() => {});
        return { ok: true, captured: false };
      }
      const value = Number(finalEventValue);
      if (!Number.isFinite(value) || value < 0) {
        return { ok: false, error: "finalEventValue must be a non-negative number" };
      }
      await writeFinalEventValue({
        aurorEventId,
        finalEventValue: value,
        finalEventValueSource: "user_confirmed",
        finalEventValueConfidence: "confirmed_by_analyst",
      });
      if (workflowId) {
        transitionWorkflow(workflowId, "submitted_detected", {
          patch: { aurorSubmitStatus: "submitted_detected" },
        }).catch(() => {});
        transitionWorkflow(workflowId, "final_value_captured", {
          patch: {
            finalEventValue: value,
            finalEventValueSource: "user_confirmed",
            finalEventValueConfidence: "confirmed_by_analyst",
            valueDisplayLabel: "Final event value confirmed",
          },
        }).catch(() => {});
        transitionWorkflow(workflowId, "completed", {}).catch(() => {});
      }
      recordMetric({
        moduleName: "aurorbuddy",
        actionName: "final_value_captured",
        result: "success",
        workflowId,
        contextHint: `aurorEventId=${aurorEventId}`,
      }).catch(() => {});
      // V1.5 observation — scrape the Auror page in the background and log
      // the comparison verdict so we can decide whether to promote DOM scrape
      // to a fallback capture path. NEVER writes finalEventValue.
      _fireScrapeObservation(aurorEventId, value);
      return { ok: true, captured: true };
    } catch (err) {
      console.error("[AurorBuddy] mark_event_submitted threw:", err);
      recordError("aurorbuddy", "final_value_captured", "mark_submitted_failed", String(err?.message ?? "")).catch(() => {});
      return { ok: false, error: String(err?.message ?? err) };
    }
  },

  // Reader for the "Awaiting final value" surface. Returns the analyst's
  // own /tool_events rows still in unknown-confidence so the UI can list
  // them. Best-effort: returns [] on any failure.
  async list_awaiting_final_value() {
    try {
      const rows = await fetchAwaitingFinalValue();
      return { ok: true, rows };
    } catch (err) {
      return { ok: true, rows: [] };
    }
  },

  // Open the Secure-lookup popup window. Triggered by the "Secure" pill
  // injected onto Auror search-feed cards / Person Card page by
  // content/secure_pill.js. The popup HTML calls appriss_lookup itself
  // with a synthesised one-item suspects[] payload and renders the
  // returned cards/transactions inline.
  //
  // Window sizing: 980×720 fits one card + ~10 transactions without
  // scrolling on a typical 1080p layout. Type "popup" strips the address
  // bar / tab strip so the user stays focused on the lookup result.
  async open_secure_lookup(msg) {
    const name     = String(msg?.name ?? "").trim();
    const personId = String(msg?.personId ?? "").trim();
    const url = chrome.runtime.getURL("modules/aurorbuddy/secure_lookup.html")
      + `?name=${encodeURIComponent(name)}&id=${encodeURIComponent(personId)}`;
    try {
      // Reuse any open lookup window so a quick succession of pill clicks
      // doesn't spawn a pile of popups. Match by the window's tab URL prefix.
      const all = await chrome.windows.getAll({ populate: true });
      const existing = all.find((w) =>
        w.type === "popup" && (w.tabs || []).some((t) =>
          (t.url || "").startsWith(chrome.runtime.getURL("modules/aurorbuddy/secure_lookup.html"))
        )
      );
      if (existing) {
        const tab = existing.tabs[0];
        await chrome.tabs.update(tab.id, { url, active: true });
        await chrome.windows.update(existing.id, { focused: true, drawAttention: true });
        return { ok: true, windowId: existing.id, reused: true };
      }
      const w = await chrome.windows.create({
        url,
        type:   "popup",
        focused: true,
        width:  980,
        height: 720,
      });
      return { ok: true, windowId: w.id, reused: false };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  },

  // Called by view.js::runFullScan once the full scan + appriss_lookup
  // pipeline finishes. Writes /tool_scans with the accurate post-pipeline
  // counts (storesFound + aurorSuspects + actionableSuspects + secureMatched
  // + elapsedMs). Separated from scan_auror so the values exist before
  // we commit them — see docs/BACKEND_TELEMETRY_AUDIT.md §3.
  async record_scan_complete(msg = {}) {
    const payload = {
      homeStore:          String(msg.homeStore ?? ""),
      miles:              Number(msg.miles ?? 0) || 0,
      days:               String(msg.days ?? ""),
      storesFound:        Number(msg.storesFound ?? 0) || 0,
      aurorSuspects:      Number(msg.aurorSuspects ?? 0) || 0,
      actionableSuspects: Number(msg.actionableSuspects ?? 0) || 0,
      secureMatched:      Number(msg.secureMatched ?? 0) || 0,
      elapsedMs:          Number(msg.elapsedMs ?? 0) || 0,
    };
    writeScan(payload).catch(() => {});
    recordMetric({
      moduleName: "aurorbuddy",
      actionName: "scan_completed",
      result: "success",
      durationMs: payload.elapsedMs,
      contextHint: `store=${payload.homeStore},auror=${payload.aurorSuspects},actionable=${payload.actionableSuspects},secure=${payload.secureMatched}`,
    }).catch(() => {});
    return { ok: true };
  },

  // V1.5 observation probe per FINAL_VALUE_CAPTURE_PLAN.md §2 Option B.
  // Tries a set of candidate DOM selectors on the Auror /event/{id} page
  // and returns what they each yielded. NEVER writes to finalEventValue —
  // this is purely observational data so we can decide later whether the
  // scrape is reliable enough to promote to a fallback capture path.
  //
  // The companion call site is `mark_event_submitted` below, which fires
  // this probe in parallel (non-blocking) whenever the analyst confirms a
  // value AND emits comparison data via the auror_page_value_scrape_attempt
  // metric event. Production capture stays user-confirmed only.
  async probe_auror_event_value_scrape(msg = {}) {
    const aurorEventId = String(msg?.aurorEventId ?? "").trim();
    if (!aurorEventId) return { ok: false, error: "aurorEventId required" };
    return await _probeAurorEventValueScrape(aurorEventId);
  },
};
