> ⚠️ **STALE — frozen 2026-05-23.** This matrix lists 10 permissions and
> 11 host patterns; the actual `manifest.json` has grown to 14 permissions
> and 23 hosts as new modules landed (claimsdisposition, digitallocks,
> workvivo, updater, Web Push). `manifest.json` is the source of truth.
> **Do not act on the contents.** For current status, see [`DOC_STATUS.md`](DOC_STATUS.md).
> Slated for archive under `docs/_archive/` after one review pass.

---

# Permissions Matrix

Every permission and host_permission across the three source extensions, with usage evidence + the proposed unified set.

---

## API permissions

| Permission | AurorBuddy | ClosingList | SparkFraud | Used by? | Unified suite | Notes |
|---|---|---|---|---|---|---|
| `storage` | ✅ | ✅ | ✅ | All | ✅ Keep | Universal need. All `chrome.storage.*` access funneled through `shared/storage.js` with module namespacing. |
| `tabs` | ✅ | ✅ | ✅ | All | ✅ Keep | Tab create/query/update/get. Funneled through `shared/tabs.js`. |
| `scripting` | ✅ | ✅ | ✅ | All | ✅ Keep | `chrome.scripting.executeScript` for SSO auto-click, DOM scrape, MAIN-world injection. Funneled through `shared/auth.js` where applicable; raw use allowed for module-specific page automation. |
| `cookies` | ✅ | ❌ | ✅ | AurorBuddy (APPRISS cookie check), SparkFraud (HttpOnly merge) | ✅ Keep | `chrome.cookies.getAll`. Funneled through `shared/auth.js::readCookiesViaTab` for the gscope workaround. |
| `webRequest` | ✅ | ❌ | ❌ | AurorBuddy only (JWT + HLS header capture) | ✅ Keep | Generic `host.auth.captureHeader({filter, name, store, ttlMs})` registers per-module listeners on a shared single `webRequest` callback. |
| `clipboardWrite` | ❌ | ✅ | ❌ | ClosingList only (email draft copy) | ✅ Keep | `navigator.clipboard.writeText` requires it under MV3. |
| `downloads` | ✅ | ❌ | ❌ | AurorBuddy only (evidence save) | ✅ Keep | `chrome.downloads.download`. Used by `evidence_downloader.js`. |
| `debugger` | ✅ | ❌ | ❌ | AurorBuddy (CCTV download — CDP capture of m3u8 playlist) | ✅ Keep | **Correction to initial audit:** Required by `lib/evidence_downloader.js` for the Save Evidence flow. Uses `chrome.debugger.attach` + `Network.getResponseBody` to capture the HLS m3u8 playlist body, then `Page.addScriptToEvaluateOnNewDocument` to spoof visibilityState so the player buffers in a background tab. Chrome's native HLS pipeline doesn't expose the playlist to `webRequest`/`fetch`, so CDP is the only viable capture path. Install prompt will surface the debugger warning. |
| `browsingData` | ❌ | ❌ | ✅ | SparkFraud only (one-click gscope cookie/cache/SW reset) | ⚠️ **Scope down or drop** | Used in `clearGscopeState` recovery flow only. Options: (a) keep — useful when gscope's SW gets stuck; (b) replace with user-facing instructions ("Open edge://settings, click trash on gscope.walmartlabs.com"); (c) drop and rely on Edge's built-in tooling. Recommend keeping in v1, documenting in install prompt, revisit after Phase 6. |
| `windows` | ❌ | ❌ | ❌ | AurorBuddy (receipt popup) — but `chrome.windows` doesn't require an explicit permission in MV3 | n/a | `chrome.windows.create({type:'popup'})` works without manifest declaration. |

**Unified `permissions`:**
```json
"permissions": [
  "storage",
  "tabs",
  "scripting",
  "windows",
  "clipboardWrite",
  "webRequest",
  "cookies",
  "downloads",
  "debugger",
  "browsingData"
]
```

10 permissions total. `debugger` retained per the corrected AurorBuddy audit. `browsingData` flagged for revisit after Phase 6 (SparkFraud-only, recovery flow).

---

## Host permissions

| Host | AurorBuddy | ClosingList | SparkFraud | Why |
|---|---|---|---|---|
| `https://app.us.auror.co/*` | ✅ | — | — | Auror app, JWT capture, autocomplete API |
| `https://*.auror.co/*` | ✅ | — | — | Wildcards Auror subdomains |
| `https://wmtus.apprissretailcloud.com/*` | ✅ | — | — | APPRISS/Secure cookies + API |
| `https://*.walmart.com/*` | ✅ | — | — | Walmart store finder, walmart.com consumer pages |
| `https://*.wal-mart.com/*` | ✅ | — | — | Internal Walmart hyphenated hosts (radapps3, ivrattcloud, ...) |
| `https://radapps3.wal-mart.com/Protected/CaseVisibility/*` | — | ✅ | — | CaseVisibility content script + Main.ashx API. Already covered by `*.wal-mart.com` if AurorBuddy is in the suite — but specific path narrows declarative content-script registration. |
| `https://ivrattcloud-prod.wal-mart.com/*` | — | ✅ | — | IVR ATT Cloud content script. Same — covered by `*.wal-mart.com`. |
| `https://gscope.walmartlabs.com/*` | — | — | ✅ | gscope MFE pages + APIs |
| `https://gscope.walmart.com/*` | — | — | ✅ | Alternate gscope domain |
| `https://swift.walmart.com/*` | — | — | ✅ | Spark Dispatcher backend |
| `https://i5.walmartimages.com/*` | — | — | ✅ | Product image CDN (covered by `*.walmart.com` as wildcards differ — `walmartimages.com` is its own apex, NOT a subdomain of walmart.com). Wildcards do NOT span apexes. |
| `https://i.walmartimages.com/*` | — | — | ✅ | Product image CDN |
| `https://www.walmart.com/*` | — | — | ✅ | walmart.com/ip/ og:image scrape |

**Unified `host_permissions`:**
```json
"host_permissions": [
  "https://app.us.auror.co/*",
  "https://*.auror.co/*",
  "https://wmtus.apprissretailcloud.com/*",
  "https://*.walmart.com/*",
  "https://*.wal-mart.com/*",
  "https://gscope.walmartlabs.com/*",
  "https://gscope.walmart.com/*",
  "https://swift.walmart.com/*",
  "https://i5.walmartimages.com/*",
  "https://i.walmartimages.com/*"
]
```

10 host patterns. `www.walmart.com/*` is folded into `*.walmart.com/*`. ClosingList's two specific hosts (radapps3 + ivrattcloud) are covered by the existing `*.wal-mart.com/*` wildcard, so only the declarative `content_scripts` entries need to mention them — `host_permissions` doesn't need separate entries.

**Note on `walmartimages.com`:** This is a *separate apex* from `walmart.com`. The `*.walmart.com` wildcard does NOT match `*.walmartimages.com`. SparkFraud's manifest correctly lists both `i5.walmartimages.com` and `i.walmartimages.com` explicitly.

---

## Content scripts (declarative, merged from modules)

| Match pattern | World | Source module | Purpose |
|---|---|---|---|
| `https://radapps3.wal-mart.com/Protected/CaseVisibility/*` | ISOLATED | closinglist | `content/casevisibility.js` — HTTP relay to Main.ashx |
| `https://ivrattcloud-prod.wal-mart.com/*` | ISOLATED | closinglist | `content/ivr.js` — DOM scrape + auto-progress |
| `https://gscope.walmartlabs.com/mfe/ordermanagement/orderresolution*` | **MAIN** | sparkfraud | `content/capture.js` — fetch/XHR monkey-patch (namespaced as `__APAI_CAP_sparkfraud`) |
| `https://gscope.walmartlabs.com/mfe/spark/dashboard*` | **MAIN** | sparkfraud | Same |

AurorBuddy has no declarative content scripts — all page interactions are via `chrome.scripting.executeScript`.

---

## `web_accessible_resources`

Only AurorBuddy declares this:
```json
"web_accessible_resources": [
  { "resources": ["app.html"], "matches": ["https://app.us.auror.co/*", "https://wmtus.apprissretailcloud.com/*"] }
]
```
**Removed in unified suite.** Audit confirmed nothing embeds `app.html` from those origins — the extension only opens it via `chrome.tabs.create(chrome.runtime.getURL("app.html"))`, which doesn't require WAR.

If a future module needs to embed a page in a content tab (rare), declare WAR scoped to that module's resources.

---

## Sensitive permissions audit (extra scrutiny)

### `webRequest` + host wildcards
AurorBuddy's `webRequest` listener hits every request on `*.auror.co` and `*.wal-mart.com/hls/*`. The listener only reads headers — never modifies, never blocks (it's `onBeforeSendHeaders` without `blocking` in `extraInfoSpec`). Low risk, but the unified shell should:
- Single shared `webRequest` registration per filter set (not one per module-import-call)
- Document captured tokens are session-scoped (in `chrome.storage.session`, dies with Edge)
- The shared `host.auth.captureHeader` API enforces: only reads, never blocks, never logs the header value to console

### `cookies`
Read-only usage in both modules. No `chrome.cookies.set` or `chrome.cookies.remove` anywhere. Low risk.

### `scripting`
The most powerful permission. Every `executeScript` call can run arbitrary code in a tab's context. Audit confirms each call has a specific purpose (SSO click, DOM read, form drive). In the unified suite:
- Modules continue to call `chrome.scripting.executeScript` directly for now (heavy + varied API; not worth abstracting in v1)
- A lint rule (`shared/lint/scripting-targets.js`) can later enforce that `target.tabId` comes from a `host.tabs.findOrOpen` call (so we know the user authorized the host)

### `browsingData`
SparkFraud's only use is `chrome.browsingData.remove({origins: [...]}, {cache, cacheStorage, cookies, indexedDB, localStorage, serviceWorkers})`. This is destructive: it nukes the user's gscope/swift/walmartlabs session state.
- Behind a button labeled `🧹` with tooltip "Clear gscope cookies + service workers + cache (use if gscope is stuck spinning). You'll need to re-do SSO afterward."
- Acceptable for v1. Consider in Phase 6: replace with detailed in-app instructions and Edge's own settings link.

### `debugger`
Required by `lib/evidence_downloader.js` for the CCTV Save Evidence flow:
- `chrome.debugger.attach({tabId}, "1.3")` on a CCTV viewer tab
- `Network.enable` + listen for `Network.loadingFinished` to find the m3u8 URL
- `Network.getResponseBody` to read the playlist text
- `Page.addScriptToEvaluateOnNewDocument` to spoof `document.visibilityState` so the HLS player buffers in a background tab
- `chrome.debugger.detach` on cleanup

This is the only path: Chrome's native `<video>` HLS pipeline fetches the m3u8 through a media stack that never fires `webRequest.onBeforeRequest`/`onResponseStarted`, and a raw SW `fetch` of the playlist URL hits a 403 because the player's session-specific URL parameters expire on first use.

Single consumer module today; if a second module ever needs CDP, generalize via `host.cdp.attach({tabId, version})` helper.

### `downloads`
AurorBuddy writes to the user's Downloads folder under a subfolder. No `chrome.downloads.shelf` API used; no auto-open after download. Acceptable.

---

## Future additions

When a new module is imported, follow this audit pattern:

1. List every `chrome.*` API the new module uses
2. Map each to the minimum permission(s) that satisfy it
3. Confirm at least one code path actually uses each declared permission (no dead perms)
4. Add narrow `host_permissions` rather than wildcarding when possible
5. Update this matrix
