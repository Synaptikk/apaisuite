# APAISuite — AI Context Brief

> **Purpose of this file.** A cold AI session can read this one page and `CLAUDE.md`
> and be oriented enough to do useful work without reading the rest of `docs/`.
> Everything else is read-on-demand. See [`DOC_STATUS.md`](DOC_STATUS.md) for the map.

**Last reviewed:** 2026-07-12 · **Suite version:** 0.9.0

---

## What this project is

APAISuite is a single Chromium MV3 extension that hosts multiple AP
fraud-investigation tools behind one shell. Each tool is a **module** under
`modules/<slug>/`; the shell is plugin-style so adding a tool is a drop-in
operation (new folder + one line in `modules/_registry.js`).

Built for Walmart AP analysts; ships as a sideload package distributed
through `qrcallbox.com` (Chrome Web Store path is deferred — see
[`RELEASING.md`](RELEASING.md) for the actual flow, and
`MEMORY.md::Update channel`).

---

## What's live right now (2026-07-12)

| Module | Slug | Status | What it does |
|---|---|---|---|
| LiveDashboard | `livedashboard` | live (Phase 2) | 6-widget home/header dashboard: CVP, Absences, Compliance (Enviance capture-replay), Accident Evidence, Register Long/Short, Recognition. |
| AurorBuddy | `aurorbuddy` | live | Auror suspect ↔ APPRISS/Secure cross-reference + CCTV evidence download. Backend rewrite shipped 2026-06-07 (corrected Firestore schema: `transactionTotalCandidate` vs `finalEventValue`). |
| ORC Corridor Monitor | `orcmonitor` | live | Real-time ORC threat tracking: maps suspect Auror event history onto store corridors to surface approaching actors. |
| LicenseIntake | `licenseintake` | live | Scanner-driven DL capture (DS9808 / PDF417) + Auror person-draft + APPRISS card cross-reference. Native messaging bridge for scanner input. |
| SparkFraud | `sparkfraud` | live | Register-event → Spark/Express/GMD delivery-driver trip correlation; OMS order/item drill-down. Canonical enums registry added. |
| ClaimsDisposition | `claimsdisposition` | live | 30-day Looker Studio pull (`apscpi.wal-mart.com`), per-store/per-user outlier analysis. Uses BigQuery via Cloud Functions for historical roll-ups. |
| DigitalLocks | `digitallocks` | live (V1) | Daily AP review of digital-lock unlock events; risk-scored, in-browser IndexedDB only, no network. Power BI driver content script on disk (V1.5). |
| Workvivo | `workvivo` | live | QRCallBox ↔ Workvivo token-heartbeat: reads `window.v2.chatConfig.access_token` hourly and POSTs it to QRCallBox. |
| ClosingList | `closinglist` | live | Closing-shift email draft from CaseVisibility + IVR call-offs |
| StockingPlan | `stockingplan` | live | Overnight stocking plan: freight from CaseVisibility → labour hours → associate assignments. |
| MetricShot | `metricshot` | beta | Scheduled screenshots of internal metric dashboards (Tableau, etc.) posted to Workvivo channels via the user's live Sendbird SDK session. Seed metric: VizPick Score → "1458 Leadership" at 10:00/14:00/20:00 daily. |
| VizPick Market Rollup | `vizpick` | alpha | Every store's VizPick backroom health (Cases Seen/Location/Pick/Overstock %) for one chosen market, side by side, with Yesterday/Today tabs. **Two distinct sources:** Yesterday = `OnlineGrocery/VizPick` "Download Summary by Store" (all stores, one crosstab); Today = `OnlineGrocery/VizPickDetails` "Download Department Breakout (Current Day)", scoped to ONE store via a Tableau parameter and so costing one export per store (loaded on demand). Crosstab capture pattern shared with `market120`. Gauge-ring UI matches VizPick's own visual style. See `CURRENT_TASKS.md` §6 for the verified field definitions — notably that `Total Picked` is *not* the `Pick %` numerator. |
| Digital Market Rollup | `digitalrollup` | alpha | Live OPD fulfilment health for every store in a market — picking / staging / dispense / availability — from the GIF market dashboard. **The only module in the suite whose source is a real JSON API** (FastAPI, publishes `/openapi.json`); no content script, no export driving, no capture ring. Layout deliberately clones `vizpick`'s market rollup, minus the gauge rings. Auto-refreshes every 10 min (alarm, on by default) — see `CURRENT_TASKS.md` §10. |
| AssocPurchases | `assocpurchases` | **WIP, disabled** in `_registry.js` | Markdown ↔ associate-discount-card cross-reference (self-purchase + friend/family fraud). |
| ClaimsBuddy | `claimsbuddy` | **WIP, disabled** in `_registry.js` | Clearsight claims helper. Has `native_host/` (native messaging). Re-enable by uncommenting the import + array entry. |

Toolbar click opens `app.html` (the shell). Sidebar nav order is set by the
array in `modules/_registry.js`.

---

## Active architecture (the bits you must know to edit safely)

### 1. Module shape

```
modules/<slug>/
  module.js     ← default-exports { manifest, register }
                  STATICALLY imports service.js  (MV3 SW disallows dynamic import)
                  LAZY-imports view.js           (loaded only when user opens the module)
  service.js    ← exports `handlers` (object of async (msg, sender) => result, keyed by msg.type)
  view.js       ← exports `mount(host, container)` → returns cleanup fn
  view.html     ← markup template fetched by view.js at mount; IDs prefixed with slug
  styles.css    ← all selectors scoped under `.module-<slug>`
  lib/          ← module-local helpers (optional)
  content/      ← content scripts (optional; ALSO declared in top-level manifest.json)
  data/         ← user-editable JSON configs (optional)
```

`module.js::manifest.service.handlers` is a **plain object reference** — not a
`() => import("./service.js")` thunk. The shell + SW assume the static-import
chain has already evaluated by SW boot. The historical dynamic-import design
in `ARCHITECTURE.md` was abandoned; see the comment block at the top of
`background/service_worker.js`.

### 2. The `host` API (what every module gets)

`shared/host.js::createHost(moduleId, shellApi)` returns a frozen object:

```js
{
  id,                                   // your slug
  url(path),                            // chrome.runtime.getURL relative to modules/<id>/
  storage:   { local, sync, session },  // auto-namespaces keys as "<id>.<key>"
  messaging: { send, sendToTab, on, broadcast },
  tabs:      { findOrOpen, waitForLoad, focus, query, create, update, remove, execute },
  auth:      { clickSso, captureHeader, getCapturedHeader, readCookiesViaTab, hasSessionCookie },
  http:      { postJson, getJson },
  logging:   { emit, read, EVENTS },
  ui:        { $, delegate, escapeHtml, status, spinner, modal, toast },
  shell:     { ... },                   // route, accent, broadcastToShell
}
```

Rules:

- Modules **must not** touch raw `chrome.storage.*` in view-page code — use
  `host.storage.*` for the namespacing.
- **Exception in service workers.** The `host` object is only available in the
  view page. In `service.js` handlers, you must use raw `chrome.storage.*`
  with module-id-prefixed keys directly (e.g., `sparkfraud.omsHeaders`).
  See `MEMORY.md::SW handlers cannot use host.storage`.
- View `mount()` MUST return a `cleanup()` that unsubscribes every
  `host.messaging.on(...)` it registered. The shell unmounts but does not GC
  listeners — without cleanup, listeners stack on every route change.

### 3. SW wake constraints (the MV3 trap)

The service worker dies after ~30s idle. For Chrome to wake it on an event,
the listener must be registered **synchronously during initial script
execution**. That means top-level code in either `service_worker.js` or in
each module's `module.js`. Examples that follow this rule:

- `chrome.webRequest.*` — registered by `service_worker.js` from each
  module's declarative `manifest.webRequestFilters` array
- `chrome.alarms.onAlarm` — `workvivo/module.js` registers its own
  heartbeat handler at top-level; `service_worker.js` registers the update
  checker + Web Push handlers
- `self.addEventListener("push", ...)` — Web Push notifications from
  QRCallBox; same wake constraint

If you add any wake-on-event handler, register it at module/SW top level,
**never inside a message handler**.

### 4. Storage namespacing

- View page: `host.storage.local.get("foo")` reads
  `chrome.storage.local["<moduleId>.foo"]`. The wrapper does the prefixing.
- Service worker: raw `chrome.storage.*` — manually prefix
  (`chrome.storage.local.set({ "sparkfraud.omsHeaders": {...} })`).
- `chrome.storage.session` is **not available in content scripts** — use
  `local` if you need to share with a content script.

### 5. Styling

- Tokens in `styles/tokens.css` (`--apai-blue`, `--apai-yellow`,
  `--apai-success`, etc.). Modules use these.
- Module CSS must scope every selector under `.module-<slug>` (the shell
  applies this class when mounting).
- Per-module accent via `--module-accent` set on `.module-<slug>`.
- See [`DESIGN_SYSTEM.md`](DESIGN_SYSTEM.md) for the component inventory.
- **Always-mounted overlays** (drawer/modal backdrops) MUST toggle both
  `opacity` and `pointer-events` together — opacity alone leaves an invisible
  click-eating layer. See `MEMORY.md::Always-mounted overlays`.

### 6. Cross-tab content-script messaging

Use `host.messaging.sendToTab(tabId, type, payload, { fallbackScripts })` —
the wrapper handles "Receiving end does not exist" by re-injecting the
content script and retrying. Raw `chrome.tabs.sendMessage` breaks the moment
the page navigates.

---

## Current priorities (in-flight work)

1. **AurorBuddy backend migration (shanesmith → suite).** Schema rewrite separating `transactionTotalCandidate` from `finalEventValue` shipped 2026-06-07 — Firestore rules + indexes + dashboard back-compat deployed; suite-side writer + Mark Submitted UI code-complete and awaiting first sideload distribution. Authoritative entry point: [`BACKEND_OVERVIEW.md`](BACKEND_OVERVIEW.md). Six per-phase docs: [`BACKEND_TELEMETRY_AUDIT.md`](BACKEND_TELEMETRY_AUDIT.md), [`BACKEND_DATA_MODEL.md`](BACKEND_DATA_MODEL.md), [`AUROR_WORKFLOW_LIFECYCLE.md`](AUROR_WORKFLOW_LIFECYCLE.md), [`BACKEND_MIGRATION_PLAN.md`](BACKEND_MIGRATION_PLAN.md), [`USAGE_METRICS_MODEL.md`](USAGE_METRICS_MODEL.md), [`FINAL_VALUE_CAPTURE_PLAN.md`](FINAL_VALUE_CAPTURE_PLAN.md).
2. **Hoops Sell-Through into ClaimsDisposition.** Probe is in
   [`../dev/HOOPS_FINDINGS.md`](../dev/HOOPS_FINDINGS.md) (2026-06-02). Next
   step: cross-origin cookie check from extension SW → `api.hoops.wal-mart.com`,
   then add a `claimsdisposition.pullCvpPerformance` SW handler + a
   `Sell Through` column in the Store Comparison table.
3. **DigitalLocks V1.5 — automated Power BI ingest.** Spec lives in
   [`DIGITAL_LOCKS_MODULE.md`](DIGITAL_LOCKS_MODULE.md) (path A "Automated"
   section). Power BI driver content script + xlsx download capture. V1
   manual-import is shipped.
4. **ClaimsBuddy** — Clearsight claims helper. Sitting in `modules/claimsbuddy/`
   with content script + native messaging host, but disabled in
   `_registry.js`. Re-enable when ready to QA.

Open Qs that are NOT blockers: [`DIGITAL_LOCKS_QUESTIONS.md`](DIGITAL_LOCKS_QUESTIONS.md).

---

## Cross-repo dependency: workvivo ↔ QRCallBox

The `workvivo` module talks to a different repo's backend
(`C:\Users\ses008s.s01458\Desktop\QRCallBox`). The contract:

- Extension SW reads `window.v2.chatConfig.access_token` from any open
  `workvivo.walmart.com` tab via `chrome.scripting.executeScript({world: "MAIN"})`.
- POSTs `{accessToken, workvivoUserId, appId}` hourly to
  `/api/workvivo/token-heartbeat` (Cloud Function in QRCallBox).
- QRCallBox stores it in Firestore (`workvivo_config/{uid}`) and uses it for
  QR-scan Workvivo posts.

`modules/workvivo/lib/qrcallbox.js` (extension side) and
`QRCallBox/functions/src/http/workvivo/token-heartbeat.js` (server side) MUST
stay in sync. Branch for in-flight work in QRCallBox: `feat/workvivo-autonomy`.

Background reading: `QRCallBox/Workvivo/WORKVIVO.md`. Don't propose
server-side headless reauth — `QRCallBox/scripts/dev/workvivo_auth_canary.py`
proved Walmart's SAML setup makes that dead.

---

## Source-preservation rule (load-bearing)

The original donor extensions live at:

- `<user-home>\Desktop\ClosingList\extension\`
- `<user-home>\Documents\puppy_workspace\aurorbuddy\extension\`
- `<user-home>\Desktop\SparkFraud\extension\`

They are **never edited**. They serve as rollback-safe references during
the verification window. If a donor needs a fix, port the fix into the
suite — never edit the donor.

---

## Release flow (one-liner)

```bash
# from unified-extension-suite/
./scripts/release.sh patch         # or: minor / major / 0.4.2
# then from QRCallBox/
npm run build && firebase deploy --only hosting
# then notify subscribers:
./scripts/notify-released.sh
```

Within ~6 hours of the deploy, every running extension surfaces a
"v0.X.Y available" pill (Web Push fires immediately when subscribed; alarm
poll is the fallback). Full details: [`RELEASING.md`](RELEASING.md). Note:
RELEASING.md has a Chrome Web Store section that is **deferred / not in
use** — qrcallbox.com is the only channel today.

**Release-notes rule:** never auto-generate. Always ask the user what the
notes should say before running `release.sh`. See `MEMORY.md::Release notes
are user-authored`.

---

## What to read NEXT for a given task

| Task | Read |
|---|---|
| Touch the AurorBuddy Firestore writer / Mark Submitted UX / dashboard | [`BACKEND_OVERVIEW.md`](BACKEND_OVERVIEW.md) |
| Edit an existing module's view/style | [`DESIGN_SYSTEM.md`](DESIGN_SYSTEM.md) + the module's own `styles.css` |
| Add a new module | [`MODULE_CONTRACT.md`](MODULE_CONTRACT.md) |
| Cut a release | [`RELEASING.md`](RELEASING.md) (skip the CWS sections) |
| Touch the `workvivo` module | `../../CLAUDE.md::Cross-repo` + `QRCallBox/Workvivo/WORKVIVO.md` |
| Implement Hoops Sell-Through | [`../dev/HOOPS_FINDINGS.md`](../dev/HOOPS_FINDINGS.md) |
| Touch ClaimsDisposition's Looker pull | [`../../claims_disposition_reference.md`](../../claims_disposition_reference.md) + `MEMORY.md::Claims Disposition store IDs no leading zeros` |
| Extend DigitalLocks | [`DIGITAL_LOCKS_MODULE.md`](DIGITAL_LOCKS_MODULE.md) + [`DIGITAL_LOCKS_QUESTIONS.md`](DIGITAL_LOCKS_QUESTIONS.md) |
| Touch SparkFraud internals | the relevant `modules/sparkfraud/<area>/README.md` |
| Resume user-directory lookup | [`../dev/DIRECTORY_FINDINGS.md`](../dev/DIRECTORY_FINDINGS.md) (dead-ends + one viable lead) |
| Regenerate icons | [`../assets/icons/README.md`](../assets/icons/README.md) |

## What NOT to read by default

Skip these unless explicitly working on the topic — they are stale, historical,
or have been superseded. See [`DO_NOT_READ_BY_DEFAULT.md`](DO_NOT_READ_BY_DEFAULT.md)
for the full list and rationale.

- `FEATURE_PARITY.md` (frozen 2026-05-23; everything shows `not-started`)
- `SOURCE_MAPPING.md` (frozen 2026-05-31; covers only 3 of 6 modules)
- `PERMISSIONS_MATRIX.md` (frozen 2026-05-23; `manifest.json` is authoritative)
- `MIGRATION_PLAN.md` (Phases 1–5 done; only the "Importing a new extension"
  recipe is still useful — covered by MODULE_CONTRACT.md)
- `EXTENSION_SUITE_AUDIT.md` (pre-migration historical reference only)
- `ARCHITECTURE.md` (mostly correct but contains the abandoned dynamic-import
  design — see §2; use MODULE_CONTRACT.md instead)
