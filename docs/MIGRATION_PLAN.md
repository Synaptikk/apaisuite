# Migration Plan

Phased, incremental migration from three standalone extensions into APAISuite. Originals are **never touched** — they remain operational throughout and serve as rollback-safe references.

---

## Guiding rules

- **Audit before implementing.** Done. See `EXTENSION_SUITE_AUDIT.md`.
- **Code is higher truth than documentation.** Always verify against current source before copying.
- **Vertical slices, not horizontal layers.** Ship one module end-to-end before starting the next.
- **Verify before consolidating.** Don't deduplicate a helper across two modules until both modules are running on the platform and tests pass.
- **No edits to original folders.** Ever. Only copy.

---

## Phase 1 — Shell scaffold (no module migrations)

Deliverables:
- Directory layout from `ARCHITECTURE.md` section 1 created
- `manifest.json` — minimal: `manifest_version: 3`, `name: "APAISuite"`, `version: "0.1.0"`, single `chrome.action` opening `app.html`, empty `permissions` and `host_permissions` (modules will accumulate them in later phases)
- `app.html` + `app.js` — render header, sidebar (reading from `_registry.js`), empty viewport
- `styles/tokens.css` — design tokens locked (see `DESIGN_SYSTEM.md`)
- `styles/base.css`, `layout.css`, `components.css` — baseline
- `shared/` — write at least: `registry.js`, `storage.js`, `messaging.js`, `tabs.js`, `ui.js`. Stubs OK for `auth.js`, `http.js`, `logging.js`.
- `modules/_registry.js` — empty array, exporting `[]`
- `background/service_worker.js` — dispatcher skeleton, no handlers yet
- Sideload-test: load extension in Edge, click toolbar, see empty shell with placeholder dashboard
- Verify: opening DevTools on the extension page shows no errors

Stop and confirm before Phase 2.

---

## Phase 2 — Migrate ClosingList (recommended first module)

Why first:
- Smallest code surface (~5 files, <30KB total)
- Cleanest separation already (`lib/parse.js` is pure, registries are docs-only)
- Lean permissions, no exotic ones (no `debugger`, no `browsingData`, no `webRequest`)
- Popup-only — migrating to full-page is a strict improvement
- Tests the platform shell against a realistic but contained workload
- Forces the storage-namespace migration code to work for `chrome.storage.sync` (cross-device prefs) — a load-bearing path

Steps:
1. Create `modules/closinglist/` with the layout from `ARCHITECTURE.md::2. The module contract`.
2. Copy `popup.html` → `view.html`, strip popup-specific styles (440×600 fixed dims), add flex/grid for fluid layout inside the viewport.
3. Copy `popup.js` → `view.js`, refactor to:
   - Import `host` from the module entry
   - Replace all `chrome.storage.sync.get/set` with `host.storage.sync.get/set` (one-line migration since the wrapper preserves the same API)
   - Replace `chrome.tabs.sendMessage` direct calls with `host.messaging.sendToTab` (gets re-injection fallback for free)
   - Replace `chrome.tabs.create/query/get` with `host.tabs.*`
   - Replace `chrome.runtime.sendMessage({type: "X"})` with `host.messaging.send("X", payload)` — wrapper injects `module: "closinglist"` automatically
4. Copy `popup.css` → `styles.css`, prefix every selector with `.module-closinglist` (use a regex pass), drop fixed-pixel dimensions.
5. Copy `content/casevisibility.js` and `content/ivr.js` verbatim — they are page-scoped, no shell coupling.
6. Copy `lib/parse.js` to `modules/closinglist/lib/parse.js` for now. Defer extracting the generic helpers (`parseTimestamp`, `titleCase`, `formatShiftRange`, `parseExcludePatterns`, `matchesExclusion`) into `shared/dates.js` + `shared/strings.js` until Phase 4 (consolidation) — those extractions need a second module's usage to validate the API.
7. Copy `background.js` logic → `modules/closinglist/service.js` as named `handlers` exports. Two handlers: `collect-ivr-absences`, `get-last-ivr-result`. Storage keys `ivrFlowState` and `ivrLastResult` become `closinglist.ivrFlowState`, `closinglist.ivrLastResult` via the namespaced wrapper. `ivr.js` reads through the wrapper too.
8. Copy `registries/` to `modules/closinglist/registries/` — docs only, no consumer code.
9. Register in `modules/_registry.js` — one line: `export default [(await import("./closinglist/module.js")).default];`
10. Regenerate `manifest.json` via `dev/build-manifest.js`. Verify host_permissions now include `radapps3.wal-mart.com/Protected/CaseVisibility/*` and `ivrattcloud-prod.wal-mart.com/*`.
11. Add a one-shot migration in `modules/closinglist/module.js::register()`: if old unnamespaced keys are present in `chrome.storage.sync`, copy them to `closinglist.*` and delete the originals. **Only safe because the user is moving off the standalone — we're not corrupting it; we never see its storage. The migration is for users who had a previous APAISuite version where keys weren't namespaced.** Skip this in v1 — flag for future.
12. **Verify functionality:**
    - Open APAISuite, navigate to ClosingList
    - With store 9999 and today's date, click Collect Schedule
    - Confirm: CaseVisibility tab opens, schedule collected, IVR tab opens + auto-advances, draft email renders, copy + Open in Outlook work
    - Run with no IVR tab open (cold start), confirm SSO + tab creation works
    - Run twice in a row, confirm storage prefs persist between sessions
    - Compare email draft to one generated by the original ClosingList extension — must be byte-identical for the same inputs

Stop and confirm before Phase 3.

---

## Phase 3 — Migrate AurorBuddy

Steps:
1. Create `modules/aurorbuddy/`.
2. Copy `app.html` → `view.html`, similar style-scoping pass as Phase 2.
3. Copy `app.js` → `view.js`. Refactor:
   - Replace `chrome.runtime.sendMessage` with `host.messaging.send`
   - Replace `chrome.runtime.onMessage.addListener` with `host.messaging.on("appriss_progress", ...)` (the shell sets up a single listener and dispatches by module + type)
   - Replace `chrome.windows.create` (used for receipt popup) with `host.shell.openPopup({url, width, height})` — abstract over the `chrome.windows` API
   - Replace `localStorage[show-all-stores]` with `host.storage.local.get/set` — must namespace to keep it separate from other modules
4. Copy `styles.css` → `styles.css`, prefix `.module-aurorbuddy`. **Drop Auror-specific palette overrides;** set `--module-accent: var(--apai-auror-yellow)` and let the shared components honor it. (Auror yellow is already in `DESIGN_SYSTEM.md` as a named accent.)
5. Copy `background.js` → `service.js`. Extract:
   - JWT capture (`webRequest.onBeforeSendHeaders` on `*.auror.co`) → registered via `host.auth.captureHeader({urls, name: "authorization", store: "auror.jwt", ttlMs: 1200000})`. The shell wires up the actual `webRequest` listener; multiple modules can capture headers without stomping on each other.
   - Nextiva HLS header capture → same pattern, different filter
   - SSO auto-click logic → use `host.auth.clickSso(tabId, [selectors])`
   - APPRISS cookie check → `host.auth.hasSessionCookie(domain, predicate)`
6. Copy `lib/auror.js`, `lib/appriss.js`, `lib/appriss_http.js`, `lib/appriss_names.js`, `lib/stores.js`, `lib/auror_event.js`, `lib/evidence_downloader.js` to `modules/aurorbuddy/lib/` verbatim. **Do not refactor yet.**
7. Storage namespacing: `aurorJwt` → `aurorbuddy.auror.jwt` (the auth-capture helper does this).
8. **Drop `debugger` permission** in module manifest declaration — audit confirmed unused. If anything breaks at runtime, it's a real bug surfaced.
9. Register in `_registry.js`.
10. Regenerate `manifest.json`. Confirm host_permissions now include the auror.co + apprissretailcloud.com + walmart.com hosts and that wildcards merge correctly with ClosingList's.
11. **Verify functionality:**
    - Run a full Search flow: home store → nearby stores → Auror suspects → APPRISS cross-reference → results table renders
    - Test "show all stores" toggle
    - Test Save Evidence — confirm file appears in Downloads\AurorBuddyDownloads\<suspect>\
    - Test Create Auror Event — confirm form is filled on a draft Auror event
    - Test receipt popup window
    - Run alongside ClosingList — confirm no storage collisions, no console errors

Stop and confirm before Phase 4.

---

## Phase 4 — Consolidate shared helpers

By now two modules are running on the platform. Look at what they actually share at runtime and extract:

1. **`shared/dates.js`** — `parseTimestamp`, `formatShiftRange`, `formatTime12h` from ClosingList's `lib/parse.js`. Verify against AurorBuddy's date handling (probably none, but check).
2. **`shared/strings.js`** — `titleCase`, `parseExcludePatterns`, `matchesExclusion`.
3. **`shared/http.js`** — generalize AurorBuddy's `lib/appriss_http.js` `postJson`. Generic signature: `postJson(url, body, {headers, label, signal, timeout, retries, isTransientResponse, isAuthWall})`. Provide defaults that match APPRISS behavior. AurorBuddy's APPRISS module switches to use it; verifies the generalization holds.
4. **`shared/tabs.js`** — `findOrOpen`, `waitForLoad`, `focus`, `execute`. Both modules switch to use these.
5. **`shared/auth.js`** — `clickSso`, `captureHeader`, `readCookiesViaTab`, `hasSessionCookie`.

After each extraction:
- Module's local copy is **deleted from the module**
- Run the verification steps from Phase 2 + 3 again
- Commit only when both modules still work

Do NOT extract:
- `parse.js::build` and `render` (domain-specific to closing-list email)
- `lib/auror.js`, `lib/appriss.js` (AurorBuddy domain logic)
- `lib/stores.js` (specific to Walmart store-finder DOM)
- `lib/evidence_downloader.js` (CCTV-specific)
- `lib/auror_event.js` (Auror form-fill specific)

---

## Phase 5 — Migrate SparkFraud

Steps:
1. Create `modules/sparkfraud/`.
2. Copy `app.html`, `app.css`, `app.js` → `view.html`, `styles.css`, `view.js`. Style-prefix `.module-sparkfraud`. Map confidence badge styles into the shared `.badge` system if compatible (probably — they're just color-coded pills).
3. Copy `capture.js` → `content/capture.js`. **Rename `window.__SPARK_CAP` → `window.__APAI_CAP_sparkfraud`** throughout. Update the consumer in `background.js` accordingly.
4. Copy `background.js` → `service.js`. Heavy refactor mostly mechanical:
   - All `chrome.tabs.*` calls → `host.tabs.*`
   - All `chrome.storage.session.*` → `host.storage.session.*` (auto-namespaces)
   - All `chrome.scripting.executeScript` → keep direct (no shared wrapper yet — this is a heavy/varied API)
   - `chrome.browsingData.remove` — keep direct; it's a one-off recovery flow
   - SSO auto-click → `host.auth.clickSso`
   - Cookie extraction → `host.auth.readCookiesViaTab` (this is the generalized SparkFraud workaround)
5. Copy `models/` → `modules/sparkfraud/models/` verbatim.
6. Copy `registries/` → `modules/sparkfraud/registries/` verbatim.
7. Copy `journal.js` → `modules/sparkfraud/journal.js`. Keep module-local for now; if AurorBuddy adopts a similar pattern in the future, extract to `shared/journal.js`.
8. Copy `telemetry/events.js` → `shared/logging.js` (this is the moment to elevate it — the design is sound and we want all modules using it). Storage key becomes `shell.telemetry`. SparkFraud switches to `host.logging.emit`. Verify the sanitize regex covers ClosingList + AurorBuddy payloads too — extend the forbidden-key pattern if needed.
9. Register in `_registry.js`.
10. Regenerate manifest. **Audit `browsingData`:** if SparkFraud is the only consumer, leave it declared; surface a justification comment in the build script's output. If a less heavy alternative exists (e.g., user-facing "reset gscope session" instructions instead of programmatic wipe), consider dropping.
11. **Verify functionality:**
    - Find candidates flow with store 9999 and today's date
    - Direct order lookup
    - Item filter, viable-only toggle
    - Per-trip print
    - Journal entry appears for each search
    - Telemetry buffer grows for each event
    - Stuck-gscope recovery button (`🧹`) still works
    - Auth tab flow works alongside AurorBuddy's APPRISS auth flow without interference
    - SparkFraud and AurorBuddy both running, both functional, in same tab

Stop and confirm.

---

## Phase 6 — Polish + retirement

1. Dashboard polish — module cards render correct status, accent, icon
2. Settings page — global settings (theme, default store) + per-module settings panels surfaced uniformly via `host.config`
3. Docs page — surface in-app links to `docs/*.md` (read-only render in a viewport panel)
4. Sidebar — collapsed/expanded persistence via `shell.sidebar.collapsed`
5. **Retirement decision:** for each original extension, decide:
   - **Retire** — uninstall sideload; rely on unified suite
   - **Coexist** — keep installed as backup until N successful weeks of unified-suite use
   - **Donor-only** — never reinstalled; source preserved on disk
6. Update `SOURCE_MAPPING.md` retirement status for each module
7. Run the entire suite for one full investigation week with the user before any retirement decision

---

## Importing a new extension into APAISuite (recipe)

This is the load-bearing test of the architecture. Adding a new extension must follow this recipe with no shell edits.

### Prereqs
- Original extension is functional standalone
- A new audit brief has been produced for it (use `EXTENSION_SUITE_AUDIT.md` per-extension brief format as a template)

### Steps

1. **Decide the slug.** url-safe, lowercase, dash-free preferred (`closinglist` not `closing-list`). Becomes the storage namespace + CSS class scope.

2. **Create module directory:**
   ```
   modules/<slug>/
     module.js
     view.html
     view.js
     styles.css
     service.js
     content/         # if needed
     lib/             # module-local helpers
     registries/      # JSON docs/refs
   ```

3. **Write `module.js`:**
   ```js
   import { handlers as serviceHandlers } from "./service.js";
   import { mount } from "./view.js";

   export default {
     manifest: {
       id: "<slug>",
       name: "<Human Name>",
       description: "<one line>",
       icon: "modules/<slug>/icon.svg",
       version: "<copy from original>",
       accent: "<#hex or undefined>",
       status: "beta",
       ui:      { kind: "fullpage", view: () => import("./view.js") },
       service: { handlers: () => import("./service.js") },
       permissions: {
         needs: [...],     // copy from original manifest
         hosts: [...]      // copy from original manifest
       },
       contentScripts: [], // copy from original manifest content_scripts
       webRequestFilters: []
     },
     register(host) { /* one-time module init */ }
   };
   ```

4. **Copy code with these mechanical transforms:**
   - `chrome.storage.<area>.get/set/remove` → `host.storage.<area>.get/set/remove`
   - `chrome.runtime.sendMessage({type, ...})` → `host.messaging.send(type, payload)`
   - `chrome.runtime.onMessage.addListener` (in UI) → `host.messaging.on(type, handler)`
   - `chrome.tabs.{query, create, get, update, remove}` → `host.tabs.*`
   - `chrome.scripting.executeScript({target: {tabId}, func, args})` → `host.tabs.execute(tabId, func, args)`
   - `localStorage` (page-scoped) → keep, but namespace the key: `localStorage["<slug>.<key>"]`
   - CSS selectors → prefix every top-level selector with `.module-<slug>` (regex pass)

5. **Add to `modules/_registry.js`:** one line.

6. **Run `dev/build-manifest.js`** (or hand-edit `manifest.json` to union in the new module's perms/hosts/content_scripts).

7. **Sideload-test.** Load the suite in Edge → navigate to the new module → run the full happy-path workflow → confirm parity with the standalone original.

8. **Add row to `SOURCE_MAPPING.md` and `FEATURE_PARITY.md`.**

9. **Audit permissions** — confirm every newly added permission is actually used by the new module (don't accumulate dead perms).

### What you do NOT do
- ❌ Edit `app.js`, `app.html`, `background/service_worker.js`, or any `shared/*` file
- ❌ Touch other modules
- ❌ Rename or refactor the original extension folder
- ❌ Add a one-off conditional in the shell for the new module

If you find yourself needing to do any of those, the architecture has a hole. File it as an issue against `ARCHITECTURE.md` and discuss before patching.
