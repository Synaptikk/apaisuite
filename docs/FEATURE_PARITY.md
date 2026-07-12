> ⚠️ **STALE — frozen 2026-05-23.** This tracker stopped being maintained
> after the initial migration. Six modules are live in production but this
> file still shows every feature as `not-started`. **Do not act on the
> contents.** For current status, see [`DOC_STATUS.md`](DOC_STATUS.md).
> Slated for archive under `docs/_archive/` after one review pass.

---

# Feature Parity Matrix

Tracks every user-facing feature from the three source extensions and its status in the unified suite.

**Status legend**

| Status | Meaning |
|---|---|
| `not-started` | Module not yet migrated |
| `in-progress` | Migration underway |
| `parity` | Feature works in suite, matches original behavior |
| `parity-improved` | Feature works in suite and is better than the original (fluid layout, persistence, etc.) |
| `regressed` | Feature works but with a known regression — see Blocking issues |
| `blocked` | Cannot migrate yet — see Blocking issues |
| `retired` | Feature intentionally removed (with rationale) |

---

## ClosingList

| Feature | Original behavior | Suite status | Verified | Blocking issues | Notes |
|---|---|---|---|---|---|
| Collect schedule from CaseVisibility (store + date) | Popup posts to `Main.ashx?func=init` via content script | not-started | — | — | Same flow, popup → module viewport |
| IVR call-off cross-reference | Background opens IVR tab, auto-advances form, scrapes table | not-started | — | — | Same flow |
| Configurable cutoff hours (start/end) | Sliders/inputs persisted to `storage.sync` | not-started | — | — | Storage key namespaced to `closinglist.startHour` etc. |
| Job-description exclusion list | CSV input, persisted | not-started | — | — | |
| Overnight-shift exclusion toggle | Persisted | not-started | — | — | |
| "Reset to default" exclusions | Button restores default CSV | not-started | — | — | |
| Render plain-text email draft | Editable `<textarea>` in popup | not-started | — | — | Full-page version can use larger textarea (parity-improved candidate) |
| Copy email draft to clipboard | `navigator.clipboard.writeText` | not-started | — | — | |
| Open in Outlook (OWA deep-link) | URL capped at 8000 chars | not-started | — | — | 8000-char limit remains; clearer fallback message planned |
| Auto-progress IVR form | `ivr.js` reads `ivrFlowState` and clicks menu→criteria→display | not-started | — | — | Verbatim |
| Job-title frequency report (optional) | Toggle | not-started | — | — | |
| Show unmatched IVR absences | Section under main draft | not-started | — | — | |
| Silent migration of outdated exclusion defaults | One-time check on popup open | not-started | — | — | Not needed in suite (new install) — skip in v1 |
| Persist user prefs across devices | `chrome.storage.sync` | not-started | — | — | Storage wrapper preserves sync vs local distinction |
| Cached `ivrLastResult` (latent in donor) | Stored but never read by popup | retired | n/a | — | Suite can read it on module mount to handle popup-close edge case (parity-improved) |

---

## AurorBuddy

| Feature | Original behavior | Suite status | Verified | Blocking issues | Notes |
|---|---|---|---|---|---|
| Toolbar click opens full-page UI | New tab to `app.html` | parity (shell-level) | — | — | Shell already opens itself this way |
| Search suspects across nearby stores | Home store + radius + days | not-started | — | — | |
| Configurable radius (10-45 mi) | Range input | not-started | — | — | |
| Configurable date range (30/60/90 days) | Segmented button group | not-started | — | — | Reuses `.btn-group` from shared components |
| "Show all stores" toggle | Persisted to `localStorage`, hides non-home rows via CSS | not-started | — | — | Storage moves to `host.storage.local.aurorbuddy.showAllStores` |
| Auror SSO auto-click | Background injects script, clicks SSO button | not-started | — | — | Becomes `host.auth.clickSso` |
| APPRISS SSO auto-click | Foregrounds tab, injects script | not-started | — | — | Same — uses module's own selector list |
| Auror JWT capture | `webRequest.onBeforeSendHeaders` | not-started | — | — | Becomes `host.auth.captureHeader` |
| APPRISS session validation | Cookie check + API probe | not-started | — | — | |
| APPRISS preflight (parallel auror + appriss check) | `Promise.all` | not-started | — | — | |
| Nearby-store lookup | Opens walmart.com store finder, scrapes DOM | not-started | — | — | |
| Suspect list rendering with photo/name/event count/total | Streaming append as APPRISS results come back | not-started | — | — | Two-layer progress bar preserved (lifted to shared components) |
| Per-suspect APPRISS card matches | Per-card transaction table | not-started | — | — | |
| HOME badge on home-store transactions | CSS row-home class | not-started | — | — | |
| CCTV link (open APPRISS viewer) | New tab | not-started | — | — | |
| Receipt popup window | `chrome.windows.create` 720×1000 popup | not-started | — | — | Suite uses `host.shell.openPopup` wrapper |
| Save Evidence (CCTV + receipt) | Downloads to `AurorBuddyDownloads\<suspect>\` | not-started | — | — | Folder rename TBD — `APAISuite\Evidence\<suspect>\`? |
| Live save progress streaming | Phase-based messages | not-started | — | — | |
| Create Auror Event (form auto-fill) | Drives `/event/new` via injected script | not-started | — | — | |
| Auror person pre-resolve (typeahead) | Searches Auror API, returns name+id | not-started | — | — | |
| Nextiva HLS segment header capture | `webRequest` on `*.wal-mart.com/hls/*` | not-started | — | — | Replays player's headers to evade throttle |
| Scan cancellation (per-search abort) | `AbortController`, new scan aborts old | not-started | — | — | Becomes `host.freshAbortSignal()` |
| `debugger` permission removed | Declared but unused in original | **regressed-undone** | — | Audit was wrong; required by `lib/evidence_downloader.js` | Retained in suite manifest. See PERMISSIONS_MATRIX.md correction. |

---

## SparkFraud

| Feature | Original behavior | Suite status | Verified | Blocking issues | Notes |
|---|---|---|---|---|---|
| Toolbar click opens full-page UI | New tab to `app.html` | parity (shell-level) | — | — | |
| Find candidates (Spark/Express/GMD/Grocery) | Store + date + event time + window | not-started | — | — | |
| Service-type filter checkboxes | 4 toggles | not-started | — | — | |
| Direct order lookup (comma-separated) | Bypasses Dispatcher, drives Order Resolution | not-started | — | — | |
| Item filter (narrow by name/UPC) | Free-text input | not-started | — | — | |
| Only-viable toggle | Filters by in-store window | not-started | — | — | |
| Per-trip card with driver, status, in-store window | Expandable | not-started | — | — | |
| Per-trip orders with item-detail expansion | Thumbnails, item links, qty, price | not-started | — | — | |
| Item image scrape from walmart.com/ip/ | og:image, cached 7d positive / 24h negative | not-started | — | — | |
| Confidence badges (VERIFIED/LIKELY/POSSIBLE/UNKNOWN/CONFLICTING) | Color-coded | not-started | — | — | Lifted into shared `.badge` system |
| Per-trip print | Button on trip head | not-started | — | — | |
| Open order in Dispatcher | Drives global search + "In Orders" disambiguation | not-started | — | — | |
| Open order in Gscope (Order Resolution) | Pre-fills form, clicks View Details | not-started | — | — | |
| Two-tier OMS fetch (cached headers → drive UI fallback) | `chrome.storage.session.omsHeaders` | not-started | — | — | Session-scoped storage preserved |
| Gscope cookie extraction workaround | `executeScript` + `chrome.cookies` merge | not-started | — | — | Becomes `host.auth.readCookiesViaTab` |
| Gscope SSO auto-click | Background tab + button click | not-started | — | — | Becomes `host.auth.clickSso` |
| Stuck-gscope recovery (`🧹`) | `chrome.browsingData.remove` for 3 origins | not-started | — | — | Keep behind a button; `browsingData` permission retained |
| Dev reload (`⟳`) | Reloads extension | retired-or-keep | — | — | Decision: keep in dev mode, hide in production builds. Or use Edge's built-in reload. |
| Investigation journal (last 500 searches, no PII) | `chrome.storage.local.investigations` | not-started | — | — | Storage key becomes `sparkfraud.investigations` |
| Telemetry ring buffer | `chrome.storage.local.telemetry` | parity-improved | — | — | Moves to `shared/logging.js`, key becomes `shell.telemetry`, covers ALL modules |
| MAIN-world fetch/XHR capture | `window.__SPARK_CAP` | not-started | — | — | Renamed `__APAI_CAP_sparkfraud` |
| Delayed-flag highlighting on trip cards | Color/text variants | not-started | — | — | |
| Auth status badge | Header pill (ok/err) | not-started | — | — | Reuses shared `.badge` |

---

## Cross-cutting features (suite-level, all modules)

| Feature | Originally | Suite | Notes |
|---|---|---|---|
| Single toolbar click → suite dashboard | 3 separate icons | parity-improved | One icon to rule them all |
| Module navigation | n/a | new | Sidebar + hash routing |
| Module-card dashboard | n/a | new | Shows status, quick-launch |
| Telemetry across modules | SparkFraud-only | parity-improved | Shared `host.logging.emit` |
| Storage namespacing | flat keys, collision risk | parity-improved | Enforced by `host.storage` wrapper |
| Shared design tokens | per-extension palette | parity-improved | Single tokens.css; modules can set `--module-accent` |
| Defensive content-script re-injection | ClosingList-only | parity-improved | Suite-wide via `host.messaging.sendToTab` |
| Cancel-in-flight on new search | AurorBuddy-only | parity-improved | Suite-wide via `host.freshAbortSignal()` |

---

## Known regressions tracking

(Empty until migration begins. When a feature lands in `regressed` status, file under here with details.)

| Feature | Module | Original behavior | Regressed behavior | Severity | Issue/owner |
|---|---|---|---|---|---|
| — | — | — | — | — | — |

---

## Verification methodology

For each feature flipped to `parity`:
1. Reproduce the original extension's exact workflow with the same inputs
2. Reproduce the same workflow in the suite
3. Compare outputs:
   - For text outputs (e.g., ClosingList email draft) — must be byte-identical
   - For data tables (e.g., AurorBuddy suspects) — row count + key fields match
   - For file downloads (e.g., AurorBuddy evidence) — file sizes within ±5%, file count matches
   - For UI behavior — visual side-by-side (screenshot) for major screens
4. Note any divergence in this matrix
