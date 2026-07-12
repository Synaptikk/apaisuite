// shared/auth.js
//
// Auth primitives shared across modules.
//
// Generalized from AurorBuddy's three patterns (Auror JWT capture, Auror SSO
// auto-click, APPRISS cookie session check) and ready for SparkFraud's gscope
// patterns in Phase 5 (SSO auto-click, cookies-via-tab workaround).
//
// API surface (every module gets its own scoped instance via createHost):
//
//   getCapturedHeader(storageKey, ttlMs)
//     → { get(): string|"", clear(): void }
//     Reads a header value captured by the shell's declarative webRequest
//     filter (see background/service_worker.js + the module manifest's
//     `webRequestFilters` array). The shell registers chrome.webRequest
//     listeners synchronously at SW boot — that's the only way Chrome will
//     wake the SW on matching events. Modules just read the cached value
//     here.
//
//   captureHeader({urls, headerName, storageKey, ttlMs, predicate})
//     → { get(): string|"", clear(): void }
//     DEPRECATED for new code. Imperative registration; the listener won't
//     reliably wake the SW because it runs inside an async eager-load chain.
//     Kept for backwards compatibility / non-SW use; prefer declarative
//     webRequestFilters in the module manifest + getCapturedHeader.
//
//   clickSso(tabId, selectors): Promise<string|null>
//     Injects an executeScript that finds + clicks the first matching button.
//     Selectors are tried in order — array of either CSS selectors OR
//     { text: RegExp } / { testId: "..." } / { css: "..." } entries.
//     Returns a short label describing which selector matched (for logging)
//     or null if nothing was clickable.
//
//   hasSessionCookie(domain, {exclude, include}): Promise<boolean>
//     chrome.cookies.getAll for the domain, filtered by include/exclude
//     regexes on cookie names. Default include = generic session-name regex.
//
//   readCookiesViaTab(tabId): Promise<Object>
//     The Walmart-corp-Edge workaround SparkFraud uses: reads document.cookie
//     in-tab via executeScript and merges with chrome.cookies.getAll for the
//     HttpOnly ones. Required for any module that needs gscope cookies.

const DEFAULT_TTL_MS = 20 * 60 * 1000; // 20 minutes

// ─── Shared SSO selector list ────────────────────────────────────────────
//
// Walmart corp login pages converge on a small set of button shapes.
// Modules that drive a background-auth flow should import and use these
// instead of re-declaring inline so a new SSO variant only needs to be
// added in one place.
//
// SSO_SELECTORS is the generic Walmart-corp-SSO list (closinglist + auror).
// APPRISS_SSO_SELECTORS adds APPRISS-specific selectors (`a#sso-sign-in`,
// `a[href*="sso"]`, `button[id*="sso"]`) FIRST, then falls through to the
// generic ones. Used by aurorbuddy's APPRISS auth flow.
//
// New per-backend variants belong here, not inline in service.js.
export const SSO_SELECTORS = Object.freeze([
  { testId: "sso" },
  { text: /sign in with company sso/i },
  { text: /sign in with sso/i },
  { text: /use company sso/i },
  { text: /\bsso\b/i },
  { text: /^sign in$/i },
]);

export const APPRISS_SSO_SELECTORS = Object.freeze([
  { css: "a#sso-sign-in" },
  { css: "a[href*='sso']" },
  { css: "button[id*='sso']" },
  ...SSO_SELECTORS,
]);

export const AUROR_SSO_SELECTORS = Object.freeze([
  { testId: "sso" },
  { text: /sign in with sso/i },
  { text: /\bsso\b/i },
  { text: /^sign in$/i },
]);

// ─── Response classification (real auth vs data response) ────────────────
//
// Centralizes "did this HTTP response actually authenticate?" so capture-
// replay paths stop misclassifying login HTML as PARSE/EMPTY errors.
//
// Returns the same `status` strings the Phase-2 sessionManager will use,
// so call sites that adopt this now don't have to be rewritten later:
//   "VALID"        — 2xx + JSON-shaped body
//   "EXPIRED"      — 401/403
//   "LOGIN_HTML"   — 200 OK but body is HTML and looks like a login page
//   "SSO_REDIRECT" — 3xx or 200 with the body unmistakably an SSO bounce
//   "NETWORK_ERROR"— fetch threw / body unreadable
//   "UNKNOWN"      — none of the above; treat as data response
//
// `body` is optional — if you've already read it, pass it for the HTML
// sniff. If omitted, only `status` + `contentType` are used.
//
// False-positive safety: the SSO/login HTML sniffs (`SSO_HINTS_RE`,
// `LOGIN_HINTS_RE`) are only ever evaluated AFTER `looksHtml` is true —
// a pure JSON response whose body happens to contain "saml" or "sign in"
// inside a string value will NOT trip this classifier. The 2KB body
// slice is both a performance guard and an isolation boundary: SSO-bounce
// HTML always announces itself in the head of the document.
const HTML_BODY_RE   = /^\s*(?:<!doctype\s+html|<html|<head|<body)/i;
const LOGIN_HINTS_RE = /<(?:title|h1|h2)[^>]*>[^<]*(?:sign[- ]?in|log[- ]?in|authenticate|session\s*expired|access\s*denied)/i;
const SSO_HINTS_RE   = /(?:saml|samlrequest|wresult|pingfederate|pfedprod|adfs|okta|onelogin|wmstoresso|aad\.azure)/i;

export function classifyAuthResponse({ status, contentType = "", body = "" }) {
  if (status === 401 || status === 403) return "EXPIRED";
  if (status === 0 || status == null)   return "NETWORK_ERROR";
  if (status >= 300 && status < 400)    return "SSO_REDIRECT";

  const ct = String(contentType || "").toLowerCase();
  const bodyHead = typeof body === "string" ? body.slice(0, 2048) : "";
  const looksHtml = ct.includes("html") || HTML_BODY_RE.test(bodyHead);

  if (status >= 200 && status < 300) {
    if (looksHtml) {
      // 200 OK + HTML body in a JSON-expected channel almost always means
      // the SSO/login page was served. Distinguish SSO bounce (more
      // actionable: "wait for reauth") from plain login HTML.
      if (SSO_HINTS_RE.test(bodyHead)) return "SSO_REDIRECT";
      return "LOGIN_HTML";
    }
    // Optional body-content cross-check: even a JSON content-type that
    // contains an explicit login marker counts as auth failure.
    if (LOGIN_HINTS_RE.test(bodyHead)) return "LOGIN_HTML";
    return "VALID";
  }

  // Anything else (4xx other than 401/403, 5xx): leave classification to
  // the caller — could be a real data error, not an auth issue.
  return "UNKNOWN";
}

// True when classifyAuthResponse() says the response represents an auth
// failure the caller should surface as an actionable "session expired"
// state rather than a PARSE/EMPTY data error.
//
// NETWORK_ERROR is DELIBERATELY EXCLUDED — a fetch that threw, a 30s
// timeout, or a DNS failure is transient/connectivity, not a session
// problem. Callers should handle NETWORK_ERROR with their own retry/
// backoff path; surfacing it as "sign in again" would confuse the user
// when the underlying issue is McAfee Web Gateway, VPN drop, or
// upstream-down.
export function isAuthFailureStatus(authStatus) {
  return authStatus === "EXPIRED" || authStatus === "LOGIN_HTML" || authStatus === "SSO_REDIRECT";
}

// ─── Autonomous reauth ────────────────────────────────────────────────────
//
// Reload an auth-bearing tab, wait for it to land in a usable state, then
// fire the caller's retry. This replaces "show a manual sign-in prompt to
// the user" patterns: most Walmart SAML / AAD sessions are still cached,
// so a tab reload silently re-establishes auth without any user action.
// MFA-required cases that genuinely need user input fail through the same
// path — but as a passive log entry rather than a blocking UI message.
//
// Usage:
//   const recovered = await reloadTabAndWait(tab.id, {
//     waitForReady: (tabId) => myCapture(tabId),  // optional
//     settleMs: 3000,                              // after tab "complete"
//     timeoutMs: 30_000,
//   });
//   if (recovered.ok) { /* retry the original operation */ }
//
// Returns { ok: true, tab } on success, { ok: false, reason } on timeout
// or if the tab is gone. Caller is responsible for actually doing the
// retry — this helper only handles the tab side.
export async function reloadTabAndWait(tabId, {
  waitForReady,
  settleMs = 3_000,
  timeoutMs = 30_000,
  bypassCache = false,
} = {}) {
  try {
    await chrome.tabs.reload(tabId, { bypassCache });
  } catch (e) {
    return { ok: false, reason: `reload threw: ${e?.message ?? e}` };
  }

  const deadline = Date.now() + timeoutMs;
  // Phase 1: wait for the tab to reach status === "complete" again.
  while (Date.now() < deadline) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return { ok: false, reason: "tab disappeared during reload" };
    if (t.status === "complete") break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (Date.now() >= deadline) return { ok: false, reason: `tab did not reach complete state within ${timeoutMs}ms` };

  // Phase 2: settle delay — SPA bootstrap usually still needs a beat after
  // "complete" before its session cookies / fetch interceptors are ready.
  if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));

  // Phase 3: optional readiness probe — caller-supplied check that returns
  // truthy when the tab's session/capture is usable. Polled until the probe
  // deadline, which is at-minimum 5s after the settle. Reason: if Phase 1
  // burned most of `timeoutMs` reaching `complete` and then Phase 2's settle
  // ate the rest, the original `deadline` could already be in the past and
  // the probe would never run — making the helper falsely report "not
  // ready" for a tab that's actually fine. Floor at 5s guarantees the
  // probe always gets a real chance.
  if (typeof waitForReady === "function") {
    const probeDeadline = Math.max(deadline, Date.now() + 5_000);
    while (Date.now() < probeDeadline) {
      const ready = await waitForReady(tabId).catch(() => false);
      if (ready) {
        const t = await chrome.tabs.get(tabId).catch(() => null);
        return { ok: true, tab: t };
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return { ok: false, reason: "readiness probe never returned true" };
  }

  const t = await chrome.tabs.get(tabId).catch(() => null);
  return t ? { ok: true, tab: t } : { ok: false, reason: "tab disappeared after settle" };
}

export function createAuth(moduleId) {
  if (!moduleId) throw new Error("createAuth: moduleId required");

  return {
    getCapturedHeader(storageKey, ttlMs = DEFAULT_TTL_MS) {
      return _getCapturedHeader(moduleId, storageKey, ttlMs);
    },
    captureHeader(opts) {
      return _captureHeader(moduleId, opts);
    },
    clickSso(tabId, selectors) {
      return _clickSso(tabId, selectors);
    },
    hasSessionCookie(domain, opts) {
      return _hasSessionCookie(domain, opts);
    },
    readCookiesViaTab(tabId) {
      return _readCookiesViaTab(tabId);
    },
  };
}

// ─── getCapturedHeader (READ-ONLY, paired with declarative SW listener) ──

import { readCapturedHeader, clearCapturedHeader } from "./captured_headers.js";

function _getCapturedHeader(moduleId, storageKey, ttlMs) {
  const fullKey = `${moduleId}.${storageKey}`;

  // Reads directly from the in-memory map maintained by the shell SW's
  // declarative webRequest listener (see background/service_worker.js +
  // shared/captured_headers.js). Synchronous — no storage roundtrip, no
  // onChanged event race. Cross-SW-wake persistence is handled by the
  // shell SW's boot-time pre-warm that reloads the map from
  // chrome.storage.session.
  return {
    get() {
      const entry = readCapturedHeader(fullKey);
      if (!entry?.value) return "";
      if (Date.now() - (entry.at ?? 0) > ttlMs) return "";
      return entry.value;
    },
    clear() {
      // Clear BOTH the in-memory map AND chrome.storage.session. The map
      // is what get() reads; not clearing it left stale tokens visible to
      // the caller after a "clear()" call, which broke 401 self-healing.
      clearCapturedHeader(fullKey);
      chrome.storage.session.remove(fullKey).catch(() => {});
    },
  };
}

// ─── captureHeader ───────────────────────────────────────────────────────

function _captureHeader(moduleId, {
  urls,
  headerName,
  storageKey,
  ttlMs = DEFAULT_TTL_MS,
  predicate, // optional: (headerValue) => bool
}) {
  if (!Array.isArray(urls) || !urls.length) throw new Error("captureHeader: urls required");
  if (!headerName) throw new Error("captureHeader: headerName required");
  if (!storageKey) throw new Error("captureHeader: storageKey required");

  const fullKey = `${moduleId}.${storageKey}`;
  const wantName = headerName.toLowerCase();

  let cachedValue = "";
  let cachedAt   = 0;

  // Warm cache from storage on construction (SW just woke up).
  chrome.storage.session.get(fullKey).then((got) => {
    const saved = got?.[fullKey];
    if (saved?.value && (Date.now() - saved.at) < ttlMs) {
      cachedValue = saved.value;
      cachedAt    = saved.at;
    }
  }).catch(() => {});

  chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      if (!details.requestHeaders) return;
      for (const h of details.requestHeaders) {
        if (h.name.toLowerCase() !== wantName) continue;
        if (!h.value) continue;
        if (predicate && !predicate(h.value)) continue;
        cachedValue = h.value;
        cachedAt    = Date.now();
        chrome.storage.session.set({
          [fullKey]: { value: cachedValue, at: cachedAt },
        }).catch(() => {});
        return;
      }
    },
    { urls },
    ["requestHeaders", "extraHeaders"]
  );

  return {
    get() {
      const age = Date.now() - cachedAt;
      if (!cachedValue || age > ttlMs) return "";
      return cachedValue;
    },
    clear() {
      cachedValue = "";
      cachedAt    = 0;
      chrome.storage.session.remove(fullKey).catch(() => {});
    },
  };
}

// ─── clickSso ────────────────────────────────────────────────────────────

async function _clickSso(tabId, selectors, { maxWaitMs = 10_000, pollMs = 400 } = {}) {
  // Normalize: accept string (CSS selector) or {css|text|testId} object.
  const normalized = selectors.map((s) => {
    if (typeof s === "string") return { kind: "css", value: s };
    if (s.css)    return { kind: "css",    value: s.css };
    if (s.testId) return { kind: "testId", value: s.testId };
    if (s.text)   return { kind: "text",   value: s.text.source ?? String(s.text), flags: s.text.flags };
    throw new Error("clickSso: selector must be string or {css|testId|text}");
  });

  console.log("[auth.clickSso] called", { tabId, selectorCount: normalized.length, maxWaitMs });

  let tabUrl = "(unknown)";
  try {
    const t = await chrome.tabs.get(tabId);
    tabUrl = t?.url || "(no url)";
  } catch (e) {
    console.warn("[auth.clickSso] chrome.tabs.get threw:", e?.message ?? e);
  }
  console.log("[auth.clickSso] tab URL at click time:", tabUrl);

  // Poll until something matches OR we time out. Reason: Auror's SPA reports
  // document.readyState=complete on the unauthenticated page well BEFORE the
  // React tree hydrates and renders the "Sign in with SSO" button. A single
  // try right after waitForTabLoad sees clickableCount=1 (just the logo
  // anchor) and bails. Polling lets us catch the button as soon as React
  // mounts it, which on a warm load is well under a second.
  const deadline = Date.now() + maxWaitMs;
  let lastDiag = null;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        args: [normalized],
        func: (selectors) => {
          function isVisible(el) {
            return el && el.offsetParent !== null;
          }
          const diag = {
            readyState: document.readyState,
            url: location.href,
            clickableCount: document.querySelectorAll("button, a, [role='button']").length,
            attempts: [],
            matched: null,
          };
          for (const s of selectors) {
            if (s.kind === "testId") {
              const el = document.querySelector(`[data-testid*="${s.value}" i],[data-testid*="${s.value}"]`);
              const vis = isVisible(el);
              diag.attempts.push({ kind: "testId", value: s.value, found: !!el, visible: vis });
              if (vis) { el.click(); diag.matched = `testId:${s.value}`; return diag; }
            } else if (s.kind === "css") {
              const el = document.querySelector(s.value);
              const vis = isVisible(el);
              diag.attempts.push({ kind: "css", value: s.value, found: !!el, visible: vis });
              if (vis) { el.click(); diag.matched = `css:${s.value}`; return diag; }
            } else if (s.kind === "text") {
              const re = new RegExp(s.value, s.flags ?? "");
              const clickables = document.querySelectorAll("button, a, [role='button']");
              let matchedTxt = null;
              let matchedVisible = false;
              for (const el of clickables) {
                const t = (el.textContent || "").trim();
                if (re.test(t)) {
                  matchedTxt = t.slice(0, 60);
                  if (isVisible(el)) {
                    matchedVisible = true;
                    el.click();
                    diag.attempts.push({ kind: "text", value: s.value, matchedText: matchedTxt, visible: true });
                    diag.matched = `text:${s.value}`;
                    return diag;
                  }
                }
              }
              diag.attempts.push({ kind: "text", value: s.value, matchedText: matchedTxt, visible: matchedVisible });
            }
          }
          return diag;
        },
      });
      lastDiag = results?.[0]?.result ?? null;
      if (lastDiag?.matched) {
        console.log(`[auth.clickSso] matched on attempt ${attempt} (clickableCount=${lastDiag.clickableCount}):`, lastDiag.matched);
        return lastDiag.matched;
      }
      // Not matched yet — page might still be hydrating. Sleep + retry.
    } catch (e) {
      // executeScript can fail mid-navigation. Log + retry; the next poll
      // will see whatever state the tab settled into.
      console.warn(`[auth.clickSso] attempt ${attempt} executeScript threw:`, e?.message ?? e);
    }
    if (Date.now() + pollMs >= deadline) break;
    await new Promise((r) => setTimeout(r, pollMs));
  }

  console.log(`[auth.clickSso] gave up after ${attempt} attempt(s); last diag:`, JSON.stringify(lastDiag, null, 2));
  return null;
}

// ─── hasSessionCookie ────────────────────────────────────────────────────

const DEFAULT_AUTHY  = /(SESSION|JSESSION|SSO|APSESS|AUTH|TOKEN|AWSALB|AWSELB)/i;
const DEFAULT_NOISE  = /^(ADRUM|_GA|_GID|_GAT|UTM_)/i;

async function _hasSessionCookie(domain, { include = DEFAULT_AUTHY, exclude = DEFAULT_NOISE } = {}) {
  const cookies = await chrome.cookies.getAll({ domain }).catch(() => []);
  if (!cookies.length) return false;
  return cookies.some((c) => !exclude.test(c.name) && include.test(c.name));
}

// ─── readCookiesViaTab (SparkFraud workaround) ───────────────────────────

async function _readCookiesViaTab(tabId) {
  // Walmart-managed Edge gutted chrome.cookies.getAll({}) — it returns only
  // 2 cookies for the entire profile. Workaround: read non-HttpOnly cookies
  // via executeScript (document.cookie), merge with chrome.cookies.getAll
  // for the HttpOnly ones. SparkFraud documents this in its
  // registries/auth_modes.json::cookie_extraction_strategy.
  //
  // The executeScript half is independently timed (3s) so it can't block
  // the chrome.cookies.getAll fallback. Pages that aren't normal HTML
  // (e.g. /api/wmstoresso returns JSON / unauthenticated stub) will hang
  // executeScript indefinitely; we fall through to the cookies API which
  // returns HttpOnly cookies even for tabs that can't run injected scripts.
  let inTab = {};
  try {
    const result = await Promise.race([
      chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const out = {};
          for (const part of document.cookie.split(";")) {
            const trimmed = part.trim();
            if (!trimmed) continue;
            const eq = trimmed.indexOf("=");
            if (eq === -1) continue;
            out[trimmed.slice(0, eq)] = decodeURIComponent(trimmed.slice(eq + 1));
          }
          return out;
        },
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("executeScript-3s-timeout")), 3000)),
    ]);
    inTab = result?.[0]?.result || {};
  } catch (_) {
    // Tab can't run scripts (intermediate SSO endpoint, JSON page, etc.).
    // Fall through and rely on chrome.cookies.getAll for whatever we can get.
  }

  // chrome.cookies.getAll for the HttpOnly cookies + any cookies whose path
  // doesn't match the tab's current URL. Querying by {domain} (not {url})
  // returns ALL cookies for the host regardless of path — important because
  // some auth/identity cookies (e.g. gscope's loginid/displayname) are
  // scoped to /apphome, and the tab may be on a different path mid-SSO.
  let httpOnly = [];
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.url) {
      const { hostname } = new URL(tab.url);
      httpOnly = await chrome.cookies.getAll({ domain: hostname });
    }
  } catch {}

  const merged = { ...inTab };
  for (const c of httpOnly) {
    if (!(c.name in merged)) merged[c.name] = c.value;
  }
  return merged;
}
