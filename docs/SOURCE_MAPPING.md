> ⚠️ **STALE — frozen 2026-05-31.** This tracker stopped being maintained
> after the initial migration. It covers only 3 of 6 live modules
> (claimsdisposition, digitallocks, workvivo are missing) and the
> `copied / adapted / verified / shared` status fields were never updated.
> `git log` is authoritative for "which file came from where". **Do not
> act on the contents.** For current status, see [`DOC_STATUS.md`](DOC_STATUS.md).
> Slated for archive under `docs/_archive/` after one review pass.

---

# Source Mapping

Tracks every file copied from a donor extension into APAISuite, and every shared helper extracted from donor code.

**Migration statuses**

| Status | Meaning |
|---|---|
| **planned** | Will be copied/extracted in a later phase; not started |
| **copied** | Copied verbatim, may still depend on donor APIs |
| **adapted** | Copied and refactored to use shell `host` APIs |
| **verified** | Adapted and verified to work end-to-end alongside other modules |
| **shared** | Extracted into `shared/` for reuse across modules |
| **blocked** | Migration paused; see notes |
| **deprecated** | Donor file is being retired in favor of a different approach |
| **retired** | Original is no longer needed; can be uninstalled |

---

## Modules

### ClosingList → `modules/closinglist/`

| Module file | Original file | Status | Notes |
|---|---|---|---|
| `module.js` | — (new) | adapted | Module manifest + register hook |
| `view.html` | `popup/popup.html` | adapted | Fixed 440×600 dims removed; restructured for fluid layout inside viewport; IDs prefixed `cl-` to avoid collisions in shared DOM |
| `view.js` | `popup/popup.js` | adapted | Rewritten as `mount(host, container)`; all `chrome.*` calls routed through `host.*`; fetches view.html at mount time |
| `styles.css` | `popup/popup.css` | adapted | All selectors scoped under `.module-closinglist`; donor `--wm-*` tokens replaced with suite `--apai-*` + `--module-accent` |
| `service.js` | `background.js` | adapted | Three handlers: `collect-ivr-absences`, `get-last-ivr-result`, `ivr-absences-collected` (inbound from IVR content script — routed through dispatcher to a pending-resolver pattern instead of an ad-hoc `chrome.runtime.onMessage` listener) |
| `content/casevisibility.js` | `content/casevisibility.js` | adapted | Message filter narrowed to `module="closinglist"`; install guard preserved |
| `content/ivr.js` | `content/ivr.js` | adapted | Storage key namespaced `closinglist.ivrFlowState`; outbound message carries `module="closinglist"` |
| `lib/parse.js` | `lib/parse.js` | adapted | Converted IIFE to ES module exports; logic verbatim. Generic helpers (`parseTimestamp`, `titleCase`, `formatShiftRange`) flagged for Phase 4 extraction to `shared/dates.js` + `shared/strings.js`. |
| `registries/endpoints.json` | `registries/endpoints.json` | copied | Docs only |
| `registries/fields.json` | `registries/fields.json` | copied | Docs only |
| `registries/selectors.json` | `registries/selectors.json` | copied | Docs only |
| `registries/store_config.json` | `registries/store_config.json` | copied | Docs only |

### AurorBuddy → `modules/aurorbuddy/`

Tracking donor version 0.1.62 (re-synced 2026-05-23 after the donor added typed `models.js`, `event_classifier.js`, and per-stage `timings.js`).

| Module file | Original file | Status | Notes |
|---|---|---|---|
| `module.js` | — (new) | adapted | Module manifest declaring all needed perms including `debugger` (audit correction — required by `lib/evidence_downloader.js` for CDP capture) |
| `view.html` | `app.html` | adapted | Restructured for shell viewport; IDs prefixed `ab-`; includes the new `#ab-timings-card` panel |
| `view.js` | `app.js` | adapted | Mount-style; `chrome.*` calls routed through `host.*`; `host.messaging.on` subscriptions tracked + unsubscribed on cleanup; show-all-stores class moved from `<body>` to module root; merges per-handler `timings` via `mergeTimings` from `./lib/timings.js`; renders ⏱ Scan timings panel at end of scan |
| `styles.css` | `styles.css` | adapted | Scoped under `.module-aurorbuddy`; `:root` palette dropped; new `.ab-timings-card` / `.ab-timings-body` styles |
| `service.js` | `background.js` | adapted | Handlers exported for SW dispatcher; every handler wraps work in `Timings.measure` and returns `timings: t.toDict()`; `appriss_lookup` converts raw matches → typed `Suspect` via `suspectsFromRaws` → `classifyAll` (passthrough) → wire format via `suspectToWire`; **dead-code Nextiva HLS capture from donor dropped** |
| `lib/auror.js` | `lib/auror.js` | copied | Verbatim |
| `lib/appriss.js` | `lib/appriss.js` | copied | Verbatim |
| `lib/appriss_http.js` | `lib/appriss_http.js` | copied | Verbatim — donor for `shared/http.js` |
| `lib/appriss_names.js` | `lib/appriss_names.js` | copied | Verbatim |
| `lib/stores.js` | `lib/stores.js` | copied | Verbatim |
| `lib/auror_event.js` | `lib/auror_event.js` | copied | Verbatim |
| `lib/evidence_downloader.js` | `lib/evidence_downloader.js` | copied | Verbatim — CCTV download via CDP capture + receipt fetch |
| `lib/models.js` | `lib/models.js` | copied | Verbatim — typed Suspect/Event domain (2026-05-23 addition) |
| `lib/event_classifier.js` | `lib/event_classifier.js` | copied | Verbatim — per-event documentation-status classifier (passthrough today, awaits Auror events API sniff) |
| `lib/timings.js` | `lib/timings.js` | copied | Verbatim — per-stage wall-clock recorder + `mergeTimings` helper |

### SparkFraud → `modules/sparkfraud/`

Migrated 2026-05-24 (donor v0.1.0). All storage keys + the MAIN-world capture global are suite-prefixed at migration time to avoid the coexistence trap that bit ClosingList.

| Module file | Original file | Status | Notes |
|---|---|---|---|
| `module.js` | — (new) | adapted | Declares perms (`cookies, storage, tabs, scripting, browsingData`) + hosts + the MAIN-world content_script entry. Static `import { handlers } from "./service.js"` per the MV3-no-dynamic-import rule. |
| `view.html` | `app.html` | adapted | Standalone wrappers removed; IDs prefixed `sf-`; buttons use shared `.btn` classes; checkboxes use shared `.check`/`.fieldset` |
| `view.js` | `app.js` (1300+ lines) | adapted | Mount-style; `chrome.runtime.sendMessage` → `host.messaging.sendRaw` (preserves the donor's `{ok, error}` flow-control pattern); `chrome.runtime.getURL(...)` → `host.url(...)` for fixtures + registries; storage key `omsHeaders` → `sparkfraud.omsHeaders`; debug globals `__SPARK_*` → `__APAISUITE_SPARKFRAUD_*`. Confidence-rendering / OMS-batching / streaming-render pipeline preserved verbatim. |
| `styles.css` | `app.css` | adapted | Scoped under `.module-sparkfraud`; color literals swapped to `--apai-*` tokens; donor's bespoke buttons use shared `.btn`/`.check`/`.fieldset` system; confidence badge palette kept (semantic colors) |
| `service.js` | `background.js` | adapted | Handlers exported for SW dispatcher (`clearGscopeState, getItemImage, openOrderInDispatcher, openOrderInGscope, driveOrderResolution, getCapturedRequest, fetchJson, getGscopeCookies`); storage keys namespaced; `getGscopeCookies` uses `host.auth.readCookiesViaTab`; SSO auto-click uses `host.auth.clickSso`; `auth-cookies-missing` no longer foregrounds the gscope tab (full-background-auth policy) |
| `content/capture.js` | `capture.js` | adapted | MAIN-world install guard renamed `window.__SPARK_CAP` → `window.__APAISUITE_SPARKFRAUD_CAP`; per-instance XHR tag renamed `__spark` → `__sparkfraud`. Consumer in service.js updated to match. |
| `journal.js` | `journal.js` | adapted | Storage key `"investigations"` → `"sparkfraud.investigations"`; otherwise verbatim |
| `telemetry/events.js` | `telemetry/events.js` | adapted | Storage key `"telemetry"` → `"sparkfraud.telemetry"`; otherwise verbatim (Phase 4 may promote this pattern to `shared/logging.js`) |
| `models/index.js` + 6 model files | `models/*.js` | copied | Verbatim — typed Trip/Order/Item/Driver/Evidence/CandidateMatch domain |
| `registries/*.json` (6 files) | `registries/*.json` | copied | Verbatim — endpoints, enums (incl. deliveryTypes for the UI), selectors, store_config, auth_modes, realmids |
| `fixtures/*.json` | `fixtures/*.json` | copied | Verbatim — replay-mode dispatcher fixture(s) |

---

## Shared platform extractions

Filled in as helpers are extracted in Phase 4. Until then, all entries are `planned`.

| Shared file | Source | Status | Notes |
|---|---|---|---|
| `shared/registry.js` | — (new) | planned | Module loader; reads `modules/_registry.js` |
| `shared/storage.js` | — (new) | planned | Namespaced `chrome.storage` wrapper; injects `<moduleId>.` prefix |
| `shared/messaging.js` | AurorBuddy `app.js::send`, ClosingList `popup.js::sendToTab` | planned | Generalize re-injection fallback pattern from ClosingList |
| `shared/tabs.js` | AurorBuddy `background.js::openOrFocus,waitForTabLoad`, ClosingList `popup.js`, SparkFraud `background.js::waitForTabUrl` | planned | Union of three donors' tab helpers |
| `shared/auth.js` | AurorBuddy `background.js::clickAurorSsoButton,clickApprissSsoButton,hasApprissSession`, SparkFraud `background.js::tryClickGscopeSso,getGscopeCookies` | adapted | Implemented in Phase 3: `clickSso(tabId, selectors)`, `captureHeader({urls, headerName, storageKey, ttlMs, predicate})`, `hasSessionCookie(domain, {include, exclude})`, `readCookiesViaTab(tabId)`. Already used by AurorBuddy; ready for SparkFraud in Phase 5. |
| `shared/http.js` | AurorBuddy `lib/appriss_http.js::postJson` | planned | Generalize: caller passes own `isTransientResponse`, `isAuthWall` predicates |
| `shared/ui.js` | — (new) | planned | `$`, `delegate`, `escapeHtml`, `status`, `spinner`, `modal`, `toast` |
| `shared/config.js` | — (new) | planned | Per-module config get/set on top of storage |
| `shared/logging.js` | SparkFraud `telemetry/events.js` | planned | Adopt verbatim; storage key becomes `shell.telemetry`; PII regex extended per module needs |
| `shared/dates.js` | ClosingList `lib/parse.js::parseTimestamp,formatShiftRange,formatTime12h` | planned | Extracted in Phase 4 once a second consumer validates the API |
| `shared/strings.js` | ClosingList `lib/parse.js::titleCase,parseExcludePatterns,matchesExclusion` | planned | Same |

---

## Companion Python tools (out of scope, documented for context)

These exist in the donor source trees but are NOT migrated. They remain operational at their original paths.

| Companion | Path | Relationship to module |
|---|---|---|
| AurorBuddy Python webapp | `<user-home>\Documents\puppy_workspace\aurorbuddy\webapp.py` + `pipeline/` | Earlier engine; the extension's `lib/auror.js`, `lib/appriss.js`, `lib/stores.js` are documented as ports of `pipeline/auror_scraper.py`, `pipeline/appriss_scraper.py`, `pipeline/store_lookup.py`. Field names + behaviour deliberately kept in parity. |
| AurorBuddy Python launch + setup scripts | `start.bat`, `setup.bat`, `_launch_webapp.bat`, `enable_edge_debug.ps1` | Pre-extension workflow; obsolete for the extension path. |
| SparkFraud Python recon | `<user-home>\Desktop\SparkFraud\recon\` + `src/` + `capture_filter.py` | Used to discover gscope/swift APIs that the extension consumes; not runtime-coupled. Useful for future endpoint discoveries. |

---

## Original extensions retirement status

Updated after Phase 6 verification.

| Original | Path | Status | Retire-after-N-weeks-success | Decision date |
|---|---|---|---|---|
| AurorBuddy | `<user-home>\Documents\puppy_workspace\aurorbuddy\extension\` | active-coexist | TBD | TBD |
| ClosingList | `<user-home>\Desktop\ClosingList\extension\` | active-coexist | TBD | TBD |
| SparkFraud | `<user-home>\Desktop\SparkFraud\extension\` | active-coexist | TBD | TBD |

`active-coexist` = original extension remains installed in Edge as a fallback while the unified suite is being verified.
