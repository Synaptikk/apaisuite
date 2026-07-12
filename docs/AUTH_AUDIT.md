# Auth / Session Audit — Phase 1

**Date:** 2026-06-10 · **Scope:** every module + dashboard that makes
authenticated requests in `unified-extension-suite`.

> **Pass 1 status (2026-06-10):** all five quick-wins shipped. See
> [Pass 1 changes](#pass-1-changes-shipped-2026-06-10) at the bottom of
> this doc. The audit text above is preserved as the pre-Pass-1 state
> for the Pass 2 plan to build on.
>
> **Pass 1.5 status (2026-06-10, same day):** user directive replaced
> Pass 1's manual-action prompts with autonomous reload-and-retry. See
> [Pass 1.5 changes](#pass-15-changes-shipped-2026-06-10) at the end.

Goal: name every backend the suite talks to, describe HOW each one
authenticates today, and call out the bugs that produce the symptoms
reported in the task brief (tabs left open, false-positive auth, infinite
loops, silent failures, duplicated logic).

This document is the input to the Phase-2 shared `sessionManager`
contract. **No code has changed yet.**

---

## Shared primitives that already exist

Live today in `shared/`:

| File | Surface | Used by |
|---|---|---|
| `shared/auth.js::createAuth(moduleId)` | `getCapturedHeader`, `captureHeader`, `clickSso`, `hasSessionCookie`, `readCookiesViaTab` | aurorbuddy, closinglist, sparkfraud, licenseintake (via aurorbuddy ns) |
| `shared/tabs.js::createTabs()` | `findOrOpen`, `waitForLoad`, `waitForUrl`, `focus`, `execute` | claimsdisposition (only) |
| `shared/captured_headers.js` | in-memory map for SW-wake-safe header capture | shell SW writes; `auth.js::getCapturedHeader` reads |
| `shared/http.js::createHttp(moduleId)` | `postJson` / `getJson` — **stub, throws if called** | nobody |
| `shared/logging.js::createLogging(moduleId)` | `emit({event,payload})` with PII sanitization (auto-strips `jwt`/`bearer`/`cookie`/etc) | `licenseintake` (only) |
| `background/service_worker.js` | Walks each module's `manifest.webRequestFilters[]` and registers one `chrome.webRequest.onBeforeSendHeaders` per filter at SW boot (the only way Chrome wakes the SW on a matching request after idle-shutdown) | aurorbuddy is the only module declaring a filter today |

There is **no** shared `ensureAuthenticated()` contract. Every module
rolls its own `ensure*Auth()` with a different signature and a different
return shape.

---

## Per-backend inventory table

Status column: ✅ = works, ⚠️ = works but has a smell, 🔴 = known bug
producing one of the reported symptoms.

| # | Module | Backend / Domain | Auth Method | Validation | Reauth Path | Tab Cleanup | Failure Mode (worst case) | Status |
|---|---|---|---|---|---|---|---|---|
| 1 | aurorbuddy | Auror (`app.us.auror.co`) | JWT bearer captured by declarative webRequestFilter on `Authorization` | Cached-token TTL (20m wall-clock from capture, **not JWT `exp`**) + 401/403 retry once | Background tab → `/login/sso/wm-us` → `clickSso` → `fillAurorIdentifierWhenReached` (foregrounds tab if Auth0 lands on password/MFA page) | **None.** Auth tab stays open | Near-expiry token slips TTL → 401 → JWT cleared → reauth opens *another* tab if the original was closed | ⚠️ |
| 2 | aurorbuddy | APPRISS Secure (`wmtus.apprissretailcloud.com`) | Cookie session (corp SAML) | **Real probe** — `probeApprissApiAuth()` POSTs the search endpoint and checks `Content-Type: json` (HTML body = login wall). Cookie presence is just a fast pre-check | Background tab to direct SAML URL (`/secure/sso/saml2?RelayState=…`) → `clickSso` → poll cookie OR probe every 600ms for 30s | **None.** Tab stays open | If SAML lands on MFA the user is told "the tab is open in the background — finish there" but the tab never gets focused — easy to miss | ⚠️ |
| 3 | aurorbuddy | Auror `/event/{id}` DOM scrape (V1.5 final-value probe) | Reuses existing Auror tab; no extra auth | N/A — fire-and-forget read-only observation | None | N/A — never opens its own tab | None — observation only | ✅ |
| 4 | sparkfraud | gscope (`gscope.walmartlabs.com`) | Cookie session via SAML chain (`pfedprod.wal-mart.com/idp/startSSO.ping?PartnerSpId=…`) | **Cookie-presence only** — checks for `authtoken` + `authheader` keys in merged cookie bag (`readCookiesViaTab` hybrid: `document.cookie` + `chrome.cookies.getAll`). No authenticated API probe | Background tab + CDP-debugger drive: `_spoofVisibility` patches `visibilityState→"visible"`, polls every 500ms up to 45s, clicks "Go" via `Runtime.evaluate`. On timeout `_foregroundIfStillStuck` pops the tab into a focused window for MFA | **None.** Auth tab becomes persistent in `chrome.storage.session["sparkfraud.authTabId"]`. **CDP debugger may leak** if `_unspoofVisibility` is skipped on exception | Cookie keys present but JSESSIONID dead → cookie-presence check passes → fetch fails silently with a generic error. The `clearGscopeState` "🧹 recovery" handler exists for this but only via manual UI | 🔴 |
| 5 | sparkfraud | Swift/Dispatcher (`swift.walmart.com`) | OMS header bag derived from gscope cookies (case-insensitive lookup of `authToken`, `authHeader`, `loginId`, etc.) | Implicit — fast-replay path detects 401/403 and clears `sparkfraud.omsHeaders`; slow-drive path has no independent staleness check | Falls back to gscope drive (see row 4) which reruns the SAML chain | N/A (no tab for this backend) | Slow-drive path times out silently after 30s when session is dead — no error class distinguishes auth-fail from real timeout | ⚠️ |
| 6 | sparkfraud | gscope OMS drive (`provider-oms/orders`) | Same-origin cookies (helper gscope tab) | Fast: HTTP 200 + JSON. Slow: 30s timeout polling capture buffer | Fast-path 401/403 → clear cached headers → slow path | **Closes helper tab in `finally`** ✅ | Two concurrent watchlist polls + manual drive could race; no mutex (registry note: "NEVER reuse a tab") | ⚠️ |
| 7 | sparkfraud | `walmart.com` product image scrape | None (`credentials: omit`) | N/A | N/A | N/A | N/A | ✅ |
| 8 | livedashboard | Hoops tRPC (`hoops.wal-mart.com/ops-portal/v1/trpc/…`) | SSO cookies via `credentials: include` | Inferred from data call. 401/403 → `errorClass: "AUTH"` | SW direct fetch → fallback `executeScript` into hoops tab; opens background hoops tab if missing | **None.** Background hoops tab not closed. Can accumulate across store-switches | If direct fetch throws for ANY network reason, fallback is taken silently with no log. `waitForOpsPortalTab` busy-polls 25s with no cancel-if-tab-closed | 🔴 |
| 9 | livedashboard | Enviance (`go.enviance.com`) | Capture-and-replay: MAIN-world content script monkey-patches fetch+XHR, ring-buffers WfAdapt.getWfs envelopes (16 slots, key `__APAISUITE_LIVEDASHBOARD_ENV_CAP`). Replay reuses page session cookies | Stale threshold 5min; no HTTP-status check on replay result — only `replay.ok` | None automatic. User must visit Enviance to re-populate ring | Closes tab only if WE opened it (`didOpen` flag) ✅ | 401 from Enviance returns `{ok:true, status:401, body:"<html>…login…"}` → falls into JSON.parse → reported as confusing `PARSE` error (not `AUTH`) | 🔴 |
| 10 | livedashboard | Power BI Register (`pbidedicated.windows.net/.../QES/Query`) | Capture-and-replay; captured `Authorization: Bearer …` token replayed verbatim | None for token expiry. Decoded zero cells → `EMPTY` | None — user must return to report tab to refresh bearer | Closes tab only if WE opened it ✅ | Bearer expires after ~1h. Stale-token replay returns HTML error body → `EMPTY` or `PARSE`, never `AUTH`. **Two capture scripts (register + recognition) chain-monkey-patch `window.fetch` on the same origin** — load order not guaranteed across reloads | 🔴 |
| 11 | livedashboard | Power BI Recognition (same origin as row 10) | Same as row 10 | Same as row 10 | Same as row 10 | Same as row 10 | Same as row 10 | 🔴 |
| 12 | livedashboard | GCS Accident static HTML (`storage.googleapis.com/cas_storage`) | None (public bucket, `credentials: omit`) | HTTP status only | N/A | N/A | N/A | ✅ |
| 13 | livedashboard | IVR/Absences via closinglist bridge | Delegated to closinglist | Delegated | Delegated | Delegated | Inherits closinglist's bugs (rows 18-19) | — |
| 14 | claimsdisposition | Looker Studio (`datastudio.google.com/embed/batchedDataV2`) | Google SSO cookies via in-tab fetch | Checks `r.ok`, parses `)]}'` prefix. **No 401 detection** — a Google SSO redirect returns 200 HTML which fails JSON parse silently | None automatic | **None.** Embed tab opened on first pull, never closed (only removed on timeout during ensureEmbedTab) | Google SSO redirect → 0 rows for all stores → IndexedDB not written → view's "auto-pull on empty" fires AGAIN on next mount → **rapid re-pull loop** with no backoff | 🔴 |
| 15 | claimsdisposition | Hoops GraphQL (`api.hoops.wal-mart.com/report-hub/v1/graphql`) | SSO cookies, direct SW fetch, no fallback | Checks `resp.ok` + `json.errors`. No 401 detection | None — non-fatal; pull proceeds with `cvp: null` | N/A (no tab) | Hoops down → blank Sell-Through cells with no in-UI indicator. **Duplicates** livedashboard's Hoops auth logic against a different endpoint with inconsistent failure handling | 🔴 |
| 16 | digitallocks | Power BI Lock Events (`app.powerbi.com` + `pbidedicated.windows.net`) | Capture-and-replay; `MWCToken` from captured `Authorization` header is self-contained auth (no cookies needed) | HTTP status only — `if (!resp.ok) throw …` | None automatic | **None.** Background Power BI tab not closed | Captured token stale → throw with raw HTTP status, no AUTH classification. Same chained-monkey-patch fragility on `window.fetch` as livedashboard's two Power BI scripts | ⚠️ |
| 17 | workvivo | QRCallBox (`qrcallbox.com/api/workvivo/token-heartbeat`) | API-key header to QRCallBox (no browser session). Source token read from `window.v2.chatConfig.access_token` in workvivo.walmart.com tab MAIN world | Heartbeat tracks `lastSuccess.at`; `STALE_AFTER_MS = 12h` triggers auto-open of background workvivo tab on next alarm | Auto-opens background workvivo.walmart.com tab + waits 30s for token to appear, then posts | **None.** Auto-opened workvivo tab not closed after heartbeat | Sendbird token revoked but `window.v2.chatConfig.access_token` still present → POST will succeed locally but QRCallBox rejects → status logged as failure. No expired-token detection on extension side | ⚠️ |
| 18 | closinglist | CaseVisibility (`radapps3.wal-mart.com`) | Content-script driven via injected scrape on the page. No SW auth involvement | N/A — runs in user's existing tab | None — user navigates manually | N/A — never opens auth tab | If user is logged out, scrape returns empty rows with no error class | ⚠️ |
| 19 | closinglist | IVR ATT Cloud (`ivrattcloud-prod.wal-mart.com`) | Cookie session via SAML | `ensureIvrAuth`: opens/finds IVR tab, if landed off-IVR calls `clickSso`, polls for redirect back to IVR within 45s | `clickSso` with shared `SSO_SELECTORS` set; on success re-navigates to `IVR_ROOT_URL` to re-anchor the content script | **None.** Reuses persistent IVR tab — intentional | 3-min `FLOW_TIMEOUT_MS` then generic "make sure you're signed in" message. No distinction between dead session vs slow IVR | ⚠️ |
| 20 | licenseintake | Auror (`app.us.auror.co`) — via aurorbuddy's JWT | Reads `createAuth("aurorbuddy").getCapturedHeader("auror.jwt")` (cross-module dependency on aurorbuddy's webRequestFilter) | 401/403 → throws `"…reload your Auror tab to refresh JWT and retry"`. No probe | None — operator must manually reload Auror tab on 401 | N/A — does not own a tab; relies on aurorbuddy's `preflight()` fallback to open one | (a) Near-expiry JWT passes the 20-min wall-clock TTL → 401 → user-actionable error. (b) If aurorbuddy is removed, this module silently breaks. Fragile cross-module dependency | ⚠️ |
| 21 | licenseintake | APPRISS — entirely delegated | Delegated to aurorbuddy `appriss_lookup` via direct in-process import | Delegated | Delegated | Delegated | **Auth-wall detection branch is unreachable** in `card_lookup_adapter.js` — placed after a `return` statement. APPRISS auth-walls surface as generic `status:"error"` not the actionable `status:"needs_manual"` | 🔴 |
| 22 | claimsbuddy | N/A — module currently exports `handlers = {}`; disabled in `_registry.js` | (n/a) | (n/a) | (n/a) | (n/a) | View talks directly to chrome APIs; outside this audit's scope until re-enabled | — |

---

## Cross-cutting findings

### Tab cleanup is inconsistent

| Closes its tab | Doesn't close it |
|---|---|
| sparkfraud OMS helper tab (`finally` block, service.js:878) | aurorbuddy Auror tab |
| claimsdisposition embed tab — only on *timeout* during open (service.js:95) | aurorbuddy APPRISS tab |
| livedashboard Enviance/PowerBI — only if WE opened it (`didOpen` flag) | sparkfraud gscope auth tab (becomes persistent) |
| | livedashboard Hoops fallback tab |
| | claimsdisposition Looker embed tab (after successful pull) |
| | workvivo auto-opened workvivo.walmart.com tab |
| | digitallocks Power BI tab |

**Pattern that works:** the `didOpen` flag — "close only the tab we
opened ourselves; never close a tab the user had already." The
`sessionManager` should standardize this.

### Validation strategies vary

- **Real authenticated probe:** APPRISS (`probeApprissApiAuth` —
  searches the search URL, content-type sniff for `json` vs `html`).
  Gold standard.
- **Cookie presence only:** sparkfraud gscope (`authtoken + authheader`
  key check). False-positives when keys exist but JSESSIONID is dead.
- **Captured token presence + wall-clock TTL:** aurorbuddy (20m from
  capture; ignores JWT `exp` claim).
- **Inferred from the data call:** hoops, looker, enviance, both Power
  BI, workvivo. Empty/login-HTML often parses as `EMPTY` or `PARSE`
  rather than `AUTH`.

### Login-HTML / SSO-redirect detection is the biggest missed signal

Only `probeApprissApiAuth` and the SparkFraud-side `auth_modes.json`
("HTML auth-wall detection") classify a 200-with-HTML response as auth
failure. **Every capture-and-replay backend** (Enviance, Power BI×2,
DigitalLocks Power BI) treats a login-HTML body as PARSE/EMPTY/UNKNOWN.

### No request deduplication across modules

Five modules needing Auror would each call `ensureAurorAuth()` and each
open a tab. There is no in-flight-promise sharing.

LicenseIntake already piggybacks aurorbuddy's JWT through
`createAuth("aurorbuddy").getCapturedHeader(...)` — proves the pattern
works for *reads*, but the `ensureAuthenticated()` side has no
equivalent.

### Logging is not structured

`shared/logging.js::createLogging` exists and auto-redacts auth
material, but **only `licenseintake` uses it**. AurorBuddy, SparkFraud,
LiveDashboard, ClaimsDisposition, etc. all use ad-hoc `console.log`.
There is no central event taxonomy (the `host.logging.EVENTS` reference
in CLAUDE.md doesn't actually exist).

### JWT TTL is wall-clock, not `exp`

`auth.js::getCapturedHeader(storageKey, ttlMs)` checks `Date.now() -
entry.at > ttlMs`. For JWTs that's wrong twice:
- Tokens captured near expiry slip through.
- Tokens whose `exp` is far in the future are dropped early.

Sane for opaque tokens (no `exp` to inspect), wrong for JWTs.

### `clickSso` selectors are duplicated

The same SSO_SELECTORS list shows up in:
- `closinglist/service.js::SSO_SELECTORS` (line 35-42)
- aurorbuddy's `ensureAurorAuth` clickSso call (inline, service.js:282-287)
- aurorbuddy's `ensureApprissAuth` clickSso call (different — has `a#sso-sign-in`, etc.)

Per `memory/feedback_background_auth.md`: "Reuse the shared SSO_SELECTORS
list" — but the shared list doesn't exist yet. The closinglist one is the
de-facto reference.

---

## Bugs grouped by reported symptom

### (a) Auth tabs left open after success
- **aurorbuddy Auror tab** — never closed (intentional? but the
  long-lived tab accumulates if user closes it and reauth opens
  another)
- **aurorbuddy APPRISS tab** — opened in background, never closed
- **sparkfraud gscope auth tab** — opened, stored in
  `chrome.storage.session["sparkfraud.authTabId"]`, never closed
- **claimsdisposition Looker embed tab** — opened on first pull,
  never closed
- **livedashboard Hoops fallback tab** — opened on direct-fetch fail,
  never closed
- **workvivo auto-opened workvivo.walmart.com tab** — when
  `STALE_AFTER_MS` fires the heartbeat opens a tab and leaves it
- **digitallocks Power BI tab** — opened, never closed

### (b) "Looks authenticated" but request fails
- **sparkfraud gscope** — cookie-presence check passes for dead
  JSESSIONID
- **livedashboard Enviance** — replay returns login HTML, surfaces as
  PARSE not AUTH
- **livedashboard Power BI Register/Recognition** — expired bearer
  returns HTML, surfaces as EMPTY/PARSE
- **claimsdisposition Looker** — SSO redirect returns HTML, surfaces
  as per-store JSON-parse error
- **claimsdisposition Hoops** — silent failure to user; blank
  Sell-Through cells with no tooltip
- **digitallocks Power BI** — stale MWCToken throws raw HTTP status
  with no AUTH class
- **aurorbuddy + licenseintake Auror** — near-expiry JWT passes
  20-min wall-clock TTL → 401

### (c) Infinite reauth loop risk
- **claimsdisposition Looker** — auto-pull-on-empty + 0-rows-on-SSO-redirect
  means rapid re-pulls when Google session expires. No backoff.
- **sparkfraud gscope** — comment at service.js:97-99 documents an
  earlier loop where pfedprod bounced to `/api/wmstoresso`. The current
  `isStuckGscopeUrl` predicate prevents it, but a regression there
  would reopen it.

### (d) Silent failure
- **claimsdisposition Hoops** — non-fatal, blank cells, no UI signal
- **livedashboard Hoops** — `tryDirectFetch` catches ALL network errors
  as `__authFail` with no log before falling to tab path
- **claimsdisposition Looker** — SSO redirect produces "JSON parse
  failed" per store, no actionable message
- **livedashboard Enviance/PowerBI** — confusing PARSE error on auth wall
- **closinglist CaseVisibility** — logged-out scrape returns empty rows
- **licenseintake APPRISS** — `if (!resp?.ok)` block in
  `card_lookup_adapter.js:229-247` is **unreachable** (after a return
  at :225). Auth-wall errors surface as generic error.

### (e) Duplicated / inconsistent auth logic
- **Hoops auth logic exists in two modules** with different endpoints,
  different failure handling, no shared code (livedashboard tRPC vs
  claimsdisposition GraphQL).
- **Three Power BI capture scripts** all monkey-patch the same
  `window.fetch` on `app.powerbi.com` and chain to the prior handler.
  Load order is not guaranteed.
- **`callAurorBuddy` helper** duplicated between
  `licenseintake/lib/card_lookup_adapter.js:37-46` and
  `auror_person_draft_adapter.js:26-35`.
- **`SSO_SELECTORS`** array re-declared in closinglist; aurorbuddy uses
  inline variants in two places.
- **OMS header strip list** in sparkfraud/service.js:863-869 mirrors
  `auth_modes.json::headers_strip_list_before_replay` but is not loaded
  from the registry — any divergence is silent.

---

## What's already in good shape (don't refactor)

- **`auth.captureHeader` declarative-filter wiring** in the shell SW is
  correct and the only MV3-compliant way to capture headers. Keep it.
- **`probeApprissApiAuth`** is the right shape for an authenticated
  probe — content-type sniff for `json` vs `html`. Use it as the
  template for other backends.
- **`auth.clickSso` polling** survives Auror's React hydration race.
  Keep it; just centralize the selectors.
- **`auth.readCookiesViaTab`** is a Walmart-Edge-specific workaround;
  load-bearing for SparkFraud. Keep as-is.
- **sparkfraud's `_foregroundIfStillStuck`** pattern is the right
  escape hatch for SAML/MFA — graduate it to a shared helper.
- **workvivo's `STALE_AFTER_MS` skip-if-fresh logic** is the only
  module that doesn't spam-retry. Use as the reference for cadence
  control.
- **`shared/logging.js` sanitizer** already strips JWT/cookie/bearer
  values. The `emit()` API is ready; modules just don't call it yet.

---

## Recommendation for Phase 2 contract

A `shared/sessionManager.js` with one method:

```js
await sessionManager.ensureAuthenticated(backendId, {
  /* optional override: */ openIfMissing: true, signal,
}) => AuthResult
```

…where `AuthResult` matches the contract in the task brief:

```js
{
  backend, authenticated, confidence /*HIGH|MEDIUM|LOW*/,
  method, status /*VALID|EXPIRED|MISSING|LOGIN_HTML|SSO_REDIRECT|NETWORK_ERROR|UNKNOWN*/,
  checkedAt, expiresAt,
  remediationRequired,
  remediationAction /*NONE|BACKGROUND_REAUTH|OPEN_AUTH_TAB|MANUAL_LOGIN_REQUIRED*/,
  authTabId, message
}
```

A `shared/authRegistry.js` keying each backend by id (`auror`,
`appriss`, `gscope`, `swift`, `hoops`, `looker`, `enviance`,
`powerbi-register`, `powerbi-recognition`, `powerbi-digitallocks`,
`ivr`, `workvivo-source`, `qrcallbox`) to its config (domains, probe,
selectors, reauth strategy, tab-close policy, max wait).

A `shared/authTabs.js` that owns the "tabs WE opened" set so we never
close a user-created tab; this is the existing `didOpen` pattern
generalized.

The hard part is **migrating each module** to call
`ensureAuthenticated()` instead of its bespoke `ensure*Auth()` — done
backend-by-backend, with the existing functions kept as thin shims
during the rollout so nothing breaks while we move.

---

## Scope warning

The task brief's Phases 2-11 will touch every module's `service.js`
file, every module's view-side error-handling, the manifest's
host_permissions in two places (probe endpoints), and add three new
shared files. Estimated 800-1500 LOC of new shared infrastructure
+ ~100-200 LOC of changes per module × 8 modules. **This is multi-day
work and risks colliding with the in-flight AurorBuddy backend
migration** (CURRENT_TASKS.md item 1 — suite-side writer code-complete,
awaiting first sideload distribution).

Recommended phasing in two passes:

1. **Pass 1 — quick wins** (no contract change yet):
   - Fix the unreachable auth-wall branch in
     `licenseintake/lib/card_lookup_adapter.js`
   - Add login-HTML detection to the four capture-replay paths
     (enviance, both livedashboard powerbi, digitallocks)
   - Distinguish "0 rows" from "SSO redirect" in claimsdisposition
     Looker pull (break the rapid-repull loop)
   - Add `didOpen` close-on-success to aurorbuddy APPRISS,
     claimsdisposition Looker, livedashboard Hoops fallback
   - Extract `SSO_SELECTORS` to `shared/auth.js`

2. **Pass 2 — contract + migration:** the full sessionManager +
   authRegistry per the Phase-2 brief, with module migrations done
   one backend at a time behind a feature gate.

Pass 1 is ~2-3 hours and fixes the most painful user-visible bugs
without touching architecture. Pass 2 is the multi-day rebuild.

---

## Pass 1 changes shipped (2026-06-10)

All five quick-wins landed in one pass. No new shared `sessionManager`
file yet — that's Pass 2. These changes preserve every module's existing
`ensure*Auth()` entry point and only add classification + cleanup behind
them.

### 1. Fixed unreachable APPRISS auth-wall branch

`modules/licenseintake/lib/card_lookup_adapter.js` — the `if (!resp?.ok)`
block was sitting after a `return` (lines 229-247), so APPRISS auth
failures surfaced as generic `status:"error"` instead of the actionable
`status:"needs_manual"` the UI knew how to handle. Reordered so the
`!resp.ok` check runs *before* the success-path early-return; also
broadened the auth-wall regex to match `/saml|mfa|secure|sign-in/i`,
not just `/auth-wall|session/i`.

### 2. Extracted SSO_SELECTORS to `shared/auth.js`

New named exports:
- `SSO_SELECTORS` — the generic Walmart-corp-SSO selector list
- `APPRISS_SSO_SELECTORS` — APPRISS-specific (`a#sso-sign-in`, etc.)
  layered on top of the generic list
- `AUROR_SSO_SELECTORS` — Auror-tuned subset

Imported by `closinglist/service.js` and `aurorbuddy/service.js`
(replacing two inline copies). A new SSO variant is now a one-place
edit instead of a hunt-and-grep across modules.

### 3. Login-HTML / SSO-redirect detection (4 capture-replay paths)

New shared classifier in `shared/auth.js`:

- `classifyAuthResponse({status, contentType, body})` — returns one of
  `VALID | EXPIRED | LOGIN_HTML | SSO_REDIRECT | NETWORK_ERROR | UNKNOWN`.
- `isAuthFailureStatus(authStatus)` — convenience predicate for the
  three failure variants.

The status strings match the Phase-2 `sessionManager` contract from the
task brief, so call sites that adopt this classifier now don't need to
be rewritten when sessionManager lands.

Wired into the four capture-and-replay sites that previously surfaced
login HTML as confusing PARSE/EMPTY errors:

- `livedashboard/lib/sources/compliance.js` (Enviance) — classifies
  both the replay response and the cached envelope body before
  `JSON.parse`. The in-tab fetch helper now also returns Content-Type
  so the classifier has full signal.
- `livedashboard/lib/sources/register.js` (Power BI Register) — same
  shape; explicit AUTH error message tells the user to refresh the
  Power BI tab so a new ~1h bearer is captured.
- `livedashboard/lib/sources/recognition.js` (Power BI Recognition) —
  same.
- `digitallocks/service.js` — classifies before JSON.parse; throws an
  `Error` with `errorClass:"AUTH"` and `authStatus:<class>` properties
  so the view layer can present an actionable message instead of a raw
  HTTP status.

### 4. Broke the claimsdisposition rapid-repull loop

`modules/claimsdisposition/service.js`:

- `pullStore()` now runs `classifyAuthResponse` on every per-store
  response. When the body is the Google SSO login HTML, the per-store
  record carries `authStatus: "LOGIN_HTML"` instead of an opaque "JSON
  parse failed" error.
- After the loop, when **every** store failed and **at least one**
  failure classifies as auth-shaped, the pull writes a sticky guard
  to `chrome.storage.local["claimsdisposition.lastAuthFail"]` with a
  30-minute TTL.
- Two new handlers: `lastAuthFail` (read the guard) and
  `clearAuthFail` (drop it).
- The handler return shape gains an `authFailure` field so callers
  see the auth signal directly without needing the new handlers.
- The handler also clears the guard on a successful pull
  (`totalRows > 0`) so the user isn't stuck after re-signing in.

`modules/claimsdisposition/view.js`:

- Cold-start path consults `lastAuthFail` before auto-triggering a
  pull on empty IndexedDB. If the guard is present and fresh, the
  view shows a "Looker auth failed (LOGIN_HTML). Sign back in to
  Google then click Pull now." message instead of re-triggering an
  identical failure.

This is the bug behind the reported "rapid re-pull loop when Google
session expires" — without the guard, an SSO redirect produced 0
rows for all stores → IndexedDB write skipped → next dashboard mount
sees empty DB → auto-pull → still expired → loop.

### 5. didOpen close-on-success — but only where it's safe

Re-scoped from "3 modules" after re-reading the code. Looker's embed
tab and Hoops' ops-portal tab are **session anchors** — their cookie
chains are bound to the tab and closing them forces a 30s reauth on
every subsequent pull. Closing those on success would trade one
reported symptom (tabs left open) for a worse one (visible latency on
every refresh).

The one place where closing is genuinely correct: **aurorbuddy
APPRISS auth tab.** Cookies persist in `chrome.cookies` regardless of
tab lifetime, so once the SAML bounce completes the tab has no
further purpose. Added close-on-success in three exit paths of
`ensureApprissAuth` (cookie appeared, API probe ok, off-logon-page
fallback) — only when `opened === true`, i.e. WE created the tab.
Pre-existing user tabs are left alone.

The Looker and Hoops sites got a TODO comment instead, pointing at
the Pass-2 sessionManager which will own tab-lifecycle as
"close idle tabs we opened after N minutes of no use."

### Files changed in Pass 1

| File | Change |
|---|---|
| `shared/auth.js` | Added `SSO_SELECTORS`, `APPRISS_SSO_SELECTORS`, `AUROR_SSO_SELECTORS`, `classifyAuthResponse`, `isAuthFailureStatus` |
| `modules/licenseintake/lib/card_lookup_adapter.js` | Moved auth-wall check before early return; deleted unreachable block; broader regex |
| `modules/closinglist/service.js` | Import `SSO_SELECTORS` from shared/auth.js; drop the local copy |
| `modules/aurorbuddy/service.js` | Import `AUROR_SSO_SELECTORS` + `APPRISS_SSO_SELECTORS`; drop inline copies; close-on-success in `ensureApprissAuth` (3 exit paths, only when `opened`) |
| `modules/livedashboard/lib/sources/compliance.js` | Classify replay + cached body before parse; replay helper returns Content-Type |
| `modules/livedashboard/lib/sources/register.js` | Same as compliance.js for grid replay |
| `modules/livedashboard/lib/sources/recognition.js` | Same as compliance.js for recognition bundle |
| `modules/livedashboard/lib/sources/cvp.js` | TODO comment on tab-open path → Pass 2 sessionManager |
| `modules/digitallocks/service.js` | Classify Power BI replay; throw Error with `errorClass`+`authStatus` props |
| `modules/claimsdisposition/service.js` | `pullStore` classifies auth; pull handler writes sticky guard; new `lastAuthFail` + `clearAuthFail` handlers; TODO comment on `ensureEmbedTab` |
| `modules/claimsdisposition/view.js` | Cold-start consults `lastAuthFail` before auto-pull |

### What Pass 1 deliberately did NOT change

- No new `sessionManager`, `authRegistry`, `authTabs`,
  `authDiagnostics`, or `authTypes` files. Those are Pass 2.
- No structured logging migration (modules still use `console.log` /
  ad-hoc `recordMetric`). Pass 2 will route auth events through
  `shared/logging.js::emit` with the AUTH_PROBE_*/AUTH_TAB_* event
  taxonomy from the task brief.
- AurorBuddy's JWT TTL is still wall-clock — switching to the JWT's
  `exp` claim is a one-liner but better done alongside the rest of
  the JWT-aware sessionManager work.
- The two Power BI capture scripts on the same `app.powerbi.com`
  origin still chain-monkey-patch `window.fetch`. Order is still not
  guaranteed across extension reloads; consolidating them is a Pass-2
  cleanup once the contract knows about per-origin capture
  ownership.
- sparkfraud's gscope cookie-presence-only validation is unchanged —
  adding a real probe needs a Pass-2 design decision about which
  endpoint to hit (gscope has no equivalent of APPRISS's
  `getsearchresults` that reliably returns JSON-vs-HTML).

---

## Pass 1.5 changes shipped (2026-06-10)

User feedback after Pass 1: "i dont want if error = manual, i want
self correction autonomous actions". Pass 1 had replaced silent
failures with classified errors but still surfaced user-action prompts
("Sign back in to Google then click Pull now", "Open the Power BI tab
and let it reload"). Pass 1.5 replaces every such prompt with
autonomous reload-and-retry. The user sees no click-to-act UI for any
auth failure; failures only surface as passive status messages, and
the next operation will silently try again.

### Architecture

New shared helper `reloadTabAndWait(tabId, opts)` in `shared/auth.js`:

```js
const { ok, tab, reason } = await reloadTabAndWait(tabId, {
  settleMs: 3000,             // wait after tab reaches "complete"
  timeoutMs: 30_000,
  waitForReady: async (tabId) => { /* truthy = session ready */ },
  bypassCache: false,
});
```

Three-phase: reload → wait-for-complete → optional readiness probe.
Probe deadline is floored at 5s past the settle so a slow corp-network
reload that consumed most of the budget reaching "complete" still gets
a fair shot at the probe.

### Per-backend retry pattern

Each capture-and-replay / SW-fetch backend now wraps its existing
pipeline in a bounded retry loop:

```js
let result = await runPipeline(tabId, ...);
let reauthAttempts = 0;
while (result && !result.ok && result.errorClass === "AUTH" &&
       reauthAttempts < MAX_REAUTH_ATTEMPTS) {
  reauthAttempts++;
  const reloaded = await reloadTabAndWait(tabId, { ... });
  if (!reloaded.ok) break;
  result = await runPipeline(tabId, ...);
}
```

`MAX_REAUTH_ATTEMPTS = 2` everywhere. `NETWORK_ERROR` does NOT trigger
the retry (transient/connectivity, not session) — `isAuthFailureStatus`
excludes it at the definition level so the exclusion is structural,
not a per-call-site discipline.

### Per-module changes

- **claimsdisposition/service.js** — DELETED the 30-min sticky
  `lastAuthFail` guard. DELETED `lastAuthFail` + `clearAuthFail`
  handlers. EXTRACTED `runPerStoreLoop(...)` and
  `allFailedWithAuthSignal(...)`. The `pull` handler now runs the
  per-store loop, and if the result classifies as a whole-pull auth
  failure, calls `reloadTabAndWait` on the embed tab and re-runs the
  loop (up to 2 times). Final return shape gains `reauthAttempts`.

- **claimsdisposition/view.js** — REMOVED the cold-start
  `lastAuthFail` gate (auto-pulls again on empty IndexedDB). REMOVED
  the `sendSW("clearAuthFail")` call. Failure message changed from
  "Sign back in to Google then click Pull now" to "Looker auth still
  failing after N background retries. Will retry on next dashboard
  refresh." — purely passive.

- **livedashboard/lib/sources/compliance.js** — EXTRACTED
  `runCompliancePipeline(tabId)`. Outer `fetchCompliance` wraps it in
  the bounded-while retry loop. AUTH messages no longer reference
  "open enviance.com" — they say "autonomous reauth will retry."

- **livedashboard/lib/sources/register.js** — EXTRACTED
  `runRegisterPipeline(tabId, storeNbr, didOpen)`. Wrapped in retry
  loop. AUTH messages updated to passive.

- **livedashboard/lib/sources/recognition.js** — EXTRACTED
  `runRecognitionPipeline(tabId, storeNbr, didOpen)`. Same retry loop +
  passive messages.

- **digitallocks/service.js** — EXTRACTED `runSearchPipeline(...)`.
  The handler now returns `{ ok: false, errorClass: "AUTH",
  authExhausted: true, reauthAttempts, ... }` on exhaustion instead of
  throwing — matches the shape of the other autonomous-reauth
  modules so the view's existing `if (!resp.ok)` path produces a
  passive error.

- **licenseintake/lib/card_lookup_adapter.js** — REMOVED the
  `status: "needs_manual"` / `LookupNeedsManualAction` return for
  APPRISS auth failures (the `confirmed !== true` programmatic guard
  still returns `needs_manual`; only the auth-failure branch was
  changed). Auth failures now return `status: "error"` with a note
  that "appriss lookup failed after autonomous reauth" — passive.

- **aurorbuddy/service.js** — `ensureApprissAuth` rewritten as a
  two-attempt autonomous cycle. Factored `_apprissPollForAuth(tabId,
  waitMs)` runs once; on failure, the tab is reloaded via
  `reloadTabAndWait` and the poll runs again. Only after both attempts
  exhaust does it return `ok:false`, with a passive message ("…will
  retry on next operation"). The didOpen close-on-success behavior
  from Pass 1 is preserved across both attempts.

### What's NOT changed (intentional)

- **aurorbuddy/service.js::ensureAurorAuth** — already does the right
  thing: fast-path token check (5s) → slow-path with
  `fillAurorIdentifierWhenReached` watching for the Auth0 identifier
  page and auto-submitting the user's email. Only foregrounds the tab
  when AAD genuinely needs interactive MFA (the password/MFA page).
  That foregrounding IS appropriate — at that point physics requires
  user interaction. Pass 1.5 does not alter this.

- **sparkfraud gscope auth** — still cookie-presence-only validation
  with the existing CDP-debugger SAML drive. The user's directive was
  about manual prompts; sparkfraud's SAML drive is already autonomous,
  and its `_foregroundIfStillStuck` escape hatch only triggers after
  45s of automated polling. Pass 2's sessionManager will own the
  generalization.

- **workvivo heartbeat** — already cadence-aware (12h stale gate
  before auto-opening tab). No user prompts in this flow today.

### Files changed in Pass 1.5

| File | Change |
|---|---|
| `shared/auth.js` | Added `reloadTabAndWait(tabId, opts)`; probe deadline floored at +5s after settle |
| `modules/claimsdisposition/service.js` | Deleted sticky-guard storage + handlers; extracted `runPerStoreLoop`/`allFailedWithAuthSignal`; added retry loop |
| `modules/claimsdisposition/view.js` | Removed cold-start guard check + `clearAuthFail` call; passive failure message |
| `modules/livedashboard/lib/sources/compliance.js` | Extracted `runCompliancePipeline`; bounded-while retry loop |
| `modules/livedashboard/lib/sources/register.js` | Extracted `runRegisterPipeline`; bounded-while retry loop |
| `modules/livedashboard/lib/sources/recognition.js` | Extracted `runRecognitionPipeline`; bounded-while retry loop |
| `modules/digitallocks/service.js` | Extracted `runSearchPipeline`; retry loop; AUTH exhaustion returns `ok:false` (no throw) |
| `modules/licenseintake/lib/card_lookup_adapter.js` | Removed `status:"needs_manual"` auth branch — passive error instead |
| `modules/aurorbuddy/service.js` | Two-attempt autonomous APPRISS reauth via `_apprissPollForAuth` + `reloadTabAndWait` |

### Failure-mode escape hatch

When autonomous reauth genuinely cannot complete (AAD needs interactive
MFA renewal, ~every 90 days), the system:

1. Logs the exhaustion to console with attempt count.
2. Returns `ok:false` with a passive message: "Will retry on next
   dashboard refresh" / "will retry on next operation".
3. Does NOT show a modal, button, or click-to-act prompt anywhere.
4. The next caller (next alarm tick, next dashboard mount, next user
   scan) silently re-attempts the full autonomous cycle.

This relies on the observation that AAD/SAML/Google session cookies
are usually still cached and reload-induced bootstrap silently
re-validates. The pathological case where the user is genuinely
signed out across all their cookies for an extended period is
unrecoverable without their input — but that's a real-world constraint,
not something the suite can paper over.
