# Extension Suite Audit

Code-level audit of the three browser extensions in scope for consolidation. Findings are derived from reading the source — README claims that conflict with code are flagged.

Auditors: Claude (lead architect role), 2026-05-23.
Source extensions (untouched, treated as read-only donors):

| Extension | Source path |
|---|---|
| AurorBuddy | `<user-home>\Documents\puppy_workspace\aurorbuddy\extension\` |
| ClosingList | `<user-home>\Desktop\ClosingList\extension\` |
| SparkFraud | `<user-home>\Desktop\SparkFraud\extension\` |

---

## 1. Per-extension brief

### 1.1 AurorBuddy

- **Type:** MV3 full-page. Toolbar action opens `chrome-extension://<id>/app.html` in a new tab (`background.js:652-660`). No `default_popup`. `web_accessible_resources` lists `app.html` for `app.us.auror.co` + `wmtus.apprissretailcloud.com`.
- **Purpose:** Cross-references Auror suspect feeds against APPRISS/Secure for fraud investigation. Includes evidence download (CCTV + receipt) and Auror `/event/new` form auto-fill.
- **Auth model — Auror:** JWT captured passively via `chrome.webRequest.onBeforeSendHeaders` on `*.auror.co` requests (`background.js:68-88`). Stored in `chrome.storage.session` under key `aurorJwt` with a 20-minute TTL. Warm-cached into a module-level `cachedAurorToken` on every SW wake.
- **Auth model — APPRISS:** Cookie-based; verified by a two-stage check: cookie presence (`hasApprissSession`) plus an API probe (`probeApprissApiAuth` POSTs the real search endpoint and inspects content-type — HTML means logged out, JSON means logged in). On miss, opens the APPRISS tab in **foreground**, auto-clicks SSO via `chrome.scripting.executeScript`, polls 30s for auth.
- **Storage keys used:**
  - `chrome.storage.session.aurorJwt` — JWT cache
  - `localStorage["aurorbuddy:show-all-stores"]` — UI preference (page-scoped)
  - No use of `chrome.storage.local` for app data
- **Messaging (UI → SW):** `preflight`, `find_stores`, `scan_auror`, `appriss_lookup`, `download_evidence`, `create_event`, `open_ui`. SW → UI broadcasts: `appriss_progress`, `download_progress`, `fill_progress`. All routed through one `chrome.runtime.onMessage.addListener` switch in `background.js:462`.
- **API layer:** Two domain libs (`lib/auror.js`, `lib/appriss.js`) each implement their own `fetch` calls; APPRISS has its own HTTP wrapper (`lib/appriss_http.js`) with sophisticated retry: 429 with Retry-After honour, 5xx back-off, `running:true` async-poll, HTML auth-wall detection, per-request 90s timeout merged with outer scan-abort signal. **No shared HTTP layer between Auror and APPRISS.** Both use `signal: AbortSignal` for scan cancellation, plumbed from `background.js::freshScanSignal`.
- **MAIN-world / page automation:** Yes, via `chrome.scripting.executeScript` — SSO auto-click on Auror login page, SSO auto-click on APPRISS logon page, store-finder DOM read (`lib/stores.js`). Not via declarative content scripts.
- **CCTV / evidence:** Captures Nextiva HLS segment headers via `webRequest` on `*.wal-mart.com/hls/*` (`background.js:102-139`), replays them on SW fetches to evade per-session throttle. `evidence_downloader.js` (20KB) handles segment fetch + writeout to `chrome.downloads` under `AurorBuddyDownloads\<suspect>\`.
- **Permissions actually used:**
  - `storage` ✅ session cache
  - `webRequest` ✅ JWT + HLS header capture
  - `scripting` ✅ SSO auto-click, store-finder DOM read, future fill flows
  - `cookies` ✅ `chrome.cookies.getAll` for APPRISS session check (`background.js:447`)
  - `downloads` ✅ evidence save
  - `tabs` ✅ tab create/query/update everywhere
  - `debugger` ❓ **declared but I find no `chrome.debugger.*` call in `background.js`, `lib/auror_event.js`, `lib/evidence_downloader.js`.** Likely legacy from an earlier CDP-based design (the README explicitly says "no CDP"). Candidate for removal in the unified manifest.
- **CSP-relevant patterns:** MV3 CSP blocks inline event handlers. UI uses delegated `click`/`error` listeners on `document` to dispatch by class (`app.js:81-110`) — a pattern the unified shell should adopt.
- **Risks for migration:**
  - The `web_accessible_resources` entry for `app.html` is referenced by name. In the unified suite, `app.html` is renamed to the suite's shell. The reference must be updated if any external page tries to embed it (currently nothing does — it's only opened via `chrome.tabs.create`).
  - `freshScanSignal` is global; if other modules also issue cancelable scans, they need their own AbortControllers — the unified shell should expose a per-module scan-controller helper.
  - Storage key `aurorJwt` is generic; namespace as `auror.jwt` to avoid collision with future Auror-adjacent modules.
  - `lib/auror_event.js` (28KB) and `lib/evidence_downloader.js` (20KB) are large discrete features that may warrant being sub-modules of the AurorBuddy module rather than monolithic.

### 1.2 ClosingList

(Captured in full by audit subagent — summary below; full brief was integrated directly from agent output. Key points:)

- **Type:** MV3 popup (`popup/popup.html`, 440×600) + two declarative content scripts + service worker.
- **Purpose:** Generates a closing-shift email draft by collecting the afternoon associate schedule from CaseVisibility (Walmart internal scheduling app) and cross-referencing it with IVR ATT Cloud call-offs.
- **Auth model:** None — leverages user's existing same-origin sessions. `casevisibility.js` does a same-origin `POST credentials:'include'` to `Main.ashx?func=init`; `ivr.js` scrapes the rendered DOM.
- **Storage keys:**
  - `chrome.storage.sync` — user prefs: `storeNbr`, `recipient`, `startHour`, `endHour`, `excludeOvernight`, `excludeJobs`, `includeIvr`, `showJobTitles`. All unnamespaced.
  - `chrome.storage.local` — transient `ivrFlowState`, `ivrLastResult`. Unnamespaced.
- **Messaging:** `collect-schedule` (popup→CV CS), `collect-ivr-absences` (popup→SW), `ivr-absences-collected` (IVR CS→SW), plus three debug-only IVR messages with no production callers.
- **Registries pattern (`registries/*.json`):** Four files (`endpoints`, `fields`, `selectors`, `store_config`) with a shared envelope `{$schema_version, last_updated, reconArtifact, notes, confidence, status, lastVerified, source}`. **No runtime loader — they are pure documentation/recon artifacts.** Code references the same field names but does not consume the JSON. Worth elevating the envelope schema (status/confidence/lastVerified) as a documentation pattern for the suite.
- **lib/parse.js:** Pure, testable; exports `module.exports` when in Node. Contains genuinely generic helpers (`parseTimestamp` handling 4 Walmart timestamp formats, `formatShiftRange`, `titleCase`) plus domain-specific email-render logic. Split point is clear.
- **Permissions:** All 4 used (`scripting`, `tabs`, `storage`, `clipboardWrite`). Lean.
- **UI surface:** Compact reusable components — Walmart brand bar with Spark SVG, `.card` containers, `<details>` filter panel, `.primary`/`.secondary` buttons, `.status` strip with `ok`/`error` left-border variants, Spark Yellow CTA. Tokens: `--wm-blue: #0071CE`, `--wm-blue-dark: #004F9A`, `--wm-yellow: #FFC220`.
- **Risks for migration:**
  - Popup window lifecycle: closing popup mid-poll orphans the CaseVisibility tab; `ivrLastResult` is written to storage but never read by the popup. Migrating to full-page eliminates this risk.
  - Fixed 440×600 needs to become fluid.
  - Defensive content-script re-injection pattern (`popup.js:98-128`) is a sound MV3 idiom — extract to shared messaging helper.

### 1.3 SparkFraud

- **Type:** MV3 full-page-ish. Toolbar action opens `app.html` (`background.js:173-175`) via `chrome.runtime.getURL`. **No `web_accessible_resources` declared for `app.html`** — this works because the extension page is opened via `chrome.tabs.create` (the extension's own context can load it), but it means external pages cannot embed it. Plus one declarative MAIN-world content script.
- **Purpose:** Correlates register events to candidate Spark/Express/GMD delivery driver trips and order items. Surfaces orders + items + driver identity for AP investigation.
- **MAIN-world content script (`capture.js`):** Injected at `document_start` into `gscope.walmartlabs.com/mfe/ordermanagement/orderresolution*` and `/mfe/spark/dashboard*`, `all_frames: true`. Monkey-patches `window.fetch` and `XMLHttpRequest` to record up to 200 captured requests (`url, method, headers, body, responseText`) on `window.__SPARK_CAP`. Background later reads these via `executeScript` to extract real auth headers and response bodies.
- **Auth model (the unusual one):**
  - **Swift Dispatcher** (`swift.walmart.com`) — pure header-based auth. App constructs ~20 specific headers (`x-authheader`, `x-authtoken`, `x-storeid`, `x-realmid: DISPATCHER_WEB_UI`, etc.) from cookies harvested out of an open gscope tab. No cookies attached.
  - **gscope** (`gscope.walmartlabs.com`) — same-origin in-tab `fetch` via `executeScript` (browser auto-attaches HttpOnly `JSESSIONID` + `authToken` + `authHeader`).
  - **Cookie extraction workaround:** Walmart-managed Edge gutted `chrome.cookies.getAll({})` (returns only 2 cookies for entire profile). Workaround documented in `registries/auth_modes.json::cookie_extraction_strategy`: read non-HttpOnly cookies via `executeScript` (`document.cookie`) into a gscope tab, merge with `chrome.cookies.getAll({url})` for HttpOnly. Implementation in `background.js:640-766`.
  - **SSO auto-click:** Background opens `gscope.walmartlabs.com/login` in a background tab and auto-clicks "Sign in using Company SSO" button (`background.js:71-105`). Foregrounds the tab only if SSO didn't complete silently.
- **`browsingData` permission** — used exactly once: `clearGscopeState` message handler (`background.js:182-211`) wipes cookies/cache/SW/IDB/localStorage for three gscope/swift origins. Recovery button for stuck gscope SWs. **Heavyweight permission for a recovery utility.** Consider replacing with manual user instructions or scoping more narrowly in unified manifest.
- **Two-tier OMS fetch (clever pattern, worth preserving):** Fast path replays cached headers via in-gscope-tab `fetch` (`omsHeaders` in `chrome.storage.session`); slow path drives the Order Resolution form in a fresh helper tab, captures the natural response via `__SPARK_CAP`, persists headers for next time. On 401/403 with cached headers, clears cache and falls through (`background.js:413-534`).
- **Storage keys:**
  - `chrome.storage.session.authTabId` — auth-tab tracking
  - `chrome.storage.session.omsHeaders` — captured OMS headers (intentionally session-scoped, dies with Edge)
  - `chrome.storage.local.investigations` (`journal.js`) — last 500 investigation summaries (no PII, summary only by design)
  - `chrome.storage.local.telemetry` (`telemetry/events.js`) — 500-event ring buffer of structured events; sanitize() strips forbidden key patterns (`/authtoken|authheader|cookie|password|secret|phonenumber|firstname|lastname|email|address|orderid|orderno|driveruuid|driveruserid/i`)
  - `chrome.storage.local["img:<itemId>"]` — per-item `og:image` URL cache (7-day positive TTL, 24-hour negative)
- **Models layer (`models/`):** Driver, Trip, Order, Item, Evidence, CandidateMatch — pure functions imported from `models/index.js`. Per the README comment, currently `invoked-but-ignored` to validate shapes; not yet consumers in the real rendering path. Clean enough to survive into the unified suite.
- **Telemetry:** 500-event ring buffer with debounced flush; sanitize() defends against PII leakage via a forbidden-key-name regex. Local-only, never sent anywhere.
- **Journal:** Per-investigation summary log (500 entries, summary-only — no PII) for "did I already investigate this register event last week?".
- **Confidence model:** UI ships VERIFIED/LIKELY/POSSIBLE/UNKNOWN/CONFLICTING badges; rendering in `app.css:165-184`. Discipline worth elevating suite-wide.
- **Permissions:** All used (`cookies`, `storage`, `tabs`, `scripting`, `browsingData`). `browsingData` is the only candidate for narrowing/removal.
- **Risks for migration:**
  - MAIN-world capture script monkey-patches global `fetch`/`XHR`. Self-guarded by `window.__SPARK_CAP` — multiple injections are no-ops. Safe alongside other modules.
  - Domain-specific `__SPARK_CAP` namespace is hard-coded — rename to a suite-wide token (`window.__APAI_CAP_<module>`) when migrating.
  - Telemetry & journal storage keys `telemetry` and `investigations` are too generic and will collide if other modules adopt the same pattern. Namespace as `sparkfraud.telemetry`, `sparkfraud.investigations` (or move to a shared per-module storage helper).
  - `omsHeaders` and `authTabId` in `chrome.storage.session` are also unnamespaced; same fix.

---

## 2. Cross-cutting patterns and overlap

### 2.1 Shared architectural shapes

| Pattern | AurorBuddy | ClosingList | SparkFraud | Unify? |
|---|---|---|---|---|
| MV3 manifest | ✅ | ✅ | ✅ | Single manifest |
| Service worker (ES module) | ✅ | ✅ | ✅ | Single SW, registry-dispatched |
| `chrome.runtime.onMessage` switch router | ✅ (1 listener, 7 cases) | ✅ (2 listeners) | ✅ (1 listener, 6 cases) | **Yes** — shared `messaging` dispatcher |
| Defensive content-script re-injection | ✅ (in app.js) | ✅ (in popup.js) | ❌ (uses MAIN-world capture) | **Yes** — shared `messaging.sendToTab` |
| Tab find-or-create-or-focus | ✅ | ✅ | ✅ | **Yes** — shared `tabs.findOrOpen` |
| Wait-for-tab-load polling | ✅ | ✅ | ✅ | **Yes** — shared `tabs.waitForLoad` |
| SSO auto-click via `executeScript` | ✅ Auror + APPRISS | ❌ | ✅ gscope | **Yes** — shared `auth.clickSsoButton(selectors)` |
| `webRequest`-based header capture | ✅ Auror JWT + Nextiva HLS | ❌ | ❌ (uses MAIN-world capture instead) | Keep per-module — patterns differ enough |
| Same-origin in-tab `fetch` via `executeScript` | ❌ | ❌ | ✅ | Keep per-module |
| Registries-as-JSON | ❌ | ✅ (docs only) | ✅ (active reference, not loaded) | **Yes** — adopt envelope schema suite-wide |
| Walmart blue/yellow brand tokens | ✅ (Auror palette) | ✅ (Walmart palette) | ✅ (Walmart palette) | **Yes** — single token set; allow module accent overrides |
| Pill buttons (`border-radius: 999px`) | ✅ | ✅ | ✅ | **Yes** — shared component |
| Status pills (auth state / ok / error) | ✅ `.pill .pill-{ok,fail,checking}` | ✅ `.status.ok .status.error` | ✅ `.badge.ok .badge.err` | **Yes** — unify naming |
| Spinner | Implicit | Implicit | ✅ `.spinner` | **Yes** — shared component |
| Table styling | ✅ `.suspects`, `.txns` | ❌ | ✅ `.items` | **Yes** — shared `.data-table` |
| Card containers | ✅ `.card` / `.card-block` | ✅ `.card` | ✅ `.trip` | **Yes** — shared `.card` primitive |
| Confidence/severity badges | ✅ THREAT/ORC/HOME | ❌ | ✅ VERIFIED/LIKELY/POSSIBLE/etc. | **Yes** — shared badge component |

### 2.2 Duplicated logic inventory

| Concern | AurorBuddy | ClosingList | SparkFraud | Consolidation target |
|---|---|---|---|---|
| Tab management (find/open/focus/wait) | `background.js:197-223, 246-302` | `popup.js:71-96`, `background.js:15-24` | `background.js:4-14, 107-168, 282-369` | `shared/tabs.js` |
| Defensive `sendMessage` w/ re-inject on disconnect | `app.js` send helper | `popup.js:98-128` | n/a | `shared/messaging.js::sendToTab` |
| SSO auto-click | `background.js:318-356` (Auror), `:392-420` (APPRISS) | n/a | `background.js:71-105` | `shared/auth.js::clickSso(tabId, selectors)` |
| Tab-load polling | `background.js:214-223` | `popup.js:84-96`, `background.js` | `background.js:4-14` | `shared/tabs.js::waitForLoad` |
| Title-case helper | n/a | `lib/parse.js::titleCase` | likely in `app.js` | `shared/strings.js` |
| Timestamp parsing (multi-format Walmart) | n/a | `lib/parse.js::parseTimestamp` | likely | `shared/dates.js` |
| Per-request HTTP retry/timeout/auth-wall detection | `lib/appriss_http.js` (sophisticated) | absent | absent in HTTP form (drives UI instead) | `shared/http.js` — base it on `appriss_http.js`, generalize |
| Storage key namespacing | none — all flat | none — all flat | none — all flat | `shared/storage.js` wrapper enforces `module.<key>` prefix |
| Telemetry / event log | none | none | `telemetry/events.js` (well-designed) | **Adopt SparkFraud's pattern** as `shared/logging.js` |
| Investigation journal / audit trail | none | none | `journal.js` | Optional `shared/journal.js` — opt-in per module |

### 2.3 Permissions overlap (see `PERMISSIONS_MATRIX.md` for full table)

Union of all permissions across the three: `storage`, `webRequest`, `scripting`, `cookies`, `downloads`, `tabs`, `debugger`, `clipboardWrite`, `browsingData`.

After audit:
- `debugger` — **drop** (AurorBuddy declares but doesn't use)
- `browsingData` — **scope down or drop** (only used in SparkFraud's recovery flow; consider replacing with user instructions or scoping to a sub-permission)
- Everything else — keep, all genuinely used

Union of host_permissions: 11 distinct origins covering Auror, APPRISS, walmart.com / wal-mart.com, walmartimages CDN, gscope, swift, CaseVisibility, IVR. No conflicts. Many already overlap on `*.walmart.com` / `*.wal-mart.com` wildcards.

---

## 3. Risks and constraints

1. **AurorBuddy's `debugger` permission** — declared but unused. Carrying it forward is a needless install-prompt scare. Verify by `grep "chrome.debugger"` in donor; confirmed not present.
2. **SparkFraud's MAIN-world capture is a tab-singleton** — `window.__SPARK_CAP` self-guards, so multiple injections are safe. But the buffer is shared by every module that hooks `fetch` on a gscope tab. If another module ever does the same on the same hosts, the captures interleave. Mitigation: namespace per-module (`__APAI_CAP_sparkfraud`).
3. **Storage key collisions** — all three extensions use flat unnamespaced keys (e.g., `telemetry`, `investigations`, `omsHeaders`, `aurorJwt`, `ivrFlowState`). Migrating to a single extension means a shared `chrome.storage.*` namespace. **Mandatory** namespacing convention: `<module>.<key>`. Provide via `shared/storage.js` wrapper that enforces prefix.
4. **Service worker `onMessage` listener stacking** — AurorBuddy and SparkFraud both register a single `onMessage` listener with a switch on `msg.type`. ClosingList has a small one too. In the unified SW, naive concatenation would race (each listener calling `sendResponse`). The shared `messaging` layer must dispatch by a namespaced `msg.module + msg.type` to a per-module handler registered at module-init.
5. **APPRISS auth cycle relies on foregrounding the APPRISS tab** — interrupts user flow. Acceptable as-is; document in DESIGN_SYSTEM.md as a known UX cost when migrating AurorBuddy.
6. **SparkFraud's two-tier OMS fetch is fragile but valuable** — cached headers expire silently, fallback re-drives the UI. Worth preserving as a SparkFraud-specific pattern; do not try to generalize.
7. **Web-accessible resources for `app.html`** — only AurorBuddy declares this, and only because the original design contemplated embedding the page in Auror/APPRISS tabs. Not actually used at runtime. The unified shell does not need this declaration.
8. **Companion Python tools** — AurorBuddy and SparkFraud have Python companions (FastAPI webapp / recon scripts). Out of scope for this consolidation but should be referenced in `SOURCE_MAPPING.md` so the relationship isn't lost.
9. **Edge corp policies (`chrome.cookies` gutted)** — SparkFraud's workaround pattern must be available to any module that touches gscope. Promote to `shared/auth.js::readCookiesViaTab(url)`.

---

## 4. Feature inventory (input to `FEATURE_PARITY.md`)

### AurorBuddy
- Search for fraud suspects across N Walmart stores within X miles of a home store, over a Last30/60/90 day window
- Display per-suspect APPRISS card matches with transaction tables
- Filter to "home store only" vs "show all stores"
- Streaming progress bar during APPRISS scan with two-layer text (dark on empty, white on filled)
- Per-transaction CCTV link (opens APPRISS viewer)
- Per-transaction receipt popup window (uses `chrome.windows.create` not `window.open`)
- Save Evidence: download CCTV clip + receipt image to `Downloads\AurorBuddyDownloads\<suspect>\`
- Create Auror Event: drive the Auror `/event/new` form via injected script, pre-populate with txn data and pre-resolved person identity
- Auror SSO auto-click flow
- APPRISS SSO auto-click flow
- Nearby-store lookup via Walmart store finder DOM scrape

### ClosingList
- Collect afternoon associate schedule from CaseVisibility for a store + business date
- Cross-reference with IVR ATT Cloud call-offs ("LAST, FIRST" format)
- Configurable cutoff hours, job-description exclusion list, overnight-shift toggle
- Render plain-text email draft, editable inline
- One-click copy to clipboard
- One-click "Open in Outlook" (OWA deep-link, 8000-char body cap)
- Auto-progress IVR form (clicks through menu→criteria→display report)
- Optional job-title frequency report for tuning exclusions

### SparkFraud
- Find delivery trips (Spark / Express / Unscheduled GMD / Scheduled Grocery) near a register event time
- Filter by store + date + event time + window (± minutes)
- Filter by item name / UPC across all surfaced trips
- "Only viable" toggle — only show trips whose in-store window contains the event time
- Per-trip driver identity, status, in-store window display
- Per-trip order list with item-detail expansion (thumbnails, item links, quantities, prices)
- Confidence badging (VERIFIED / LIKELY / POSSIBLE / UNKNOWN / CONFLICTING)
- Direct lookup by order ID (bypass Dispatcher, drive Order Resolution)
- "Print trip" per trip
- Persistent investigation journal (last 500 searches, no PII)
- Local telemetry ring buffer for diagnostics
- Open-order-in-Dispatcher (drives global search + "In Orders" disambiguation)
- Open-order-in-Gscope (drives Order Resolution form)
- One-click cookie/cache/SW reset for stuck gscope state
- Item image cache (og:image scrape from walmart.com/ip/)

---

## 5. What this audit does NOT change

The audit is read-only. No files were modified in any of the three source extensions. All three remain operational on disk at their original paths and can continue to be sideloaded independently while the unified suite is built.
