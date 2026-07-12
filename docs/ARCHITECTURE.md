# APAISuite — Target Architecture

The unified extension suite is a single MV3 extension that hosts multiple **modules**, each migrated from a former standalone extension. The shell is a plug-in host; modules are independent and self-describing.

**Top constraint:** adding a new extension to the suite must be a drop-in operation — new folder under `modules/`, one entry in the module registry, no edits to shell code.

---

## 1. Directory layout

```
unified-extension-suite/
  manifest.json                    # union of module manifests + shell baseline
  app.html                         # shell page — sidebar + module viewport
  app.js                           # shell bootstrap; loads registry, mounts modules

  styles/
    tokens.css                     # color/spacing/typography custom properties
    base.css                       # resets, document-level styles
    layout.css                     # sidebar/viewport/grid
    components.css                 # buttons, cards, tables, pills, modals, ...

  shared/                          # the platform — module-agnostic
    registry.js                    # loads modules from modules/_registry.js
    storage.js                     # namespaced chrome.storage wrapper
    messaging.js                   # SW dispatcher + sendToTab with re-inject
    tabs.js                        # findOrOpen, waitForLoad, focus
    auth.js                        # clickSso(tabId, selectors), readCookiesViaTab
    http.js                        # generalized postJson w/ retry/timeout/auth-wall
    ui.js                          # DOM helpers (escapeHtml, $, delegate)
    config.js                      # per-module config get/set on top of storage
    logging.js                     # adopted from SparkFraud telemetry/events.js
    dates.js                       # parseTimestamp, formatShiftRange (from ClosingList)
    strings.js                     # titleCase, normalize helpers

  modules/
    _registry.js                   # array of module imports + metadata exports
    closinglist/
      module.js                    # exports manifest + register()
      view.html                    # markup fragment inserted into shell viewport
      view.js                      # UI controller
      service.js                   # background-side handlers (registered via SW dispatch)
      content/                     # if module needs content scripts
        casevisibility.js
        ivr.js
      registries/                  # carry-over JSON refs (docs)
        ...
      styles.css                   # module-scoped CSS (selectors all under .module-closinglist)
    aurorbuddy/
      module.js
      view.html
      view.js
      service.js
      lib/                         # auror.js, appriss.js, appriss_http.js, stores.js
      content/                     # not yet — uses webRequest/scripting
    sparkfraud/
      module.js
      view.html
      view.js
      service.js
      content/
        capture.js                 # MAIN-world, namespaced as window.__APAI_CAP_sparkfraud
      models/
      registries/

  background/
    service_worker.js              # imports shared/messaging + iterates modules, calling .registerService(dispatcher)

  content/
    shared_content.js              # optional — generic helper bundle if multiple modules need it

  assets/
    icons/
    logos/

  docs/
    EXTENSION_SUITE_AUDIT.md
    ARCHITECTURE.md
    MIGRATION_PLAN.md
    DESIGN_SYSTEM.md
    SOURCE_MAPPING.md
    PERMISSIONS_MATRIX.md
    FEATURE_PARITY.md
```

---

## 2. The module contract

Every module exports a manifest + a register() function. This is the only API the shell knows about.

```js
// modules/<name>/module.js
export const manifest = {
  id:          "closinglist",            // url-safe slug; used as storage prefix, CSS class scope
  name:        "ClosingList",            // human-readable, shown in sidebar
  description: "Closing-shift email draft from CaseVisibility schedule + IVR call-offs.",
  icon:        "assets/icons/closinglist.svg",
  version:     "0.2.0",                  // tracked separately from suite version
  accent:      "#0071CE",                // optional — module-specific accent override
  status:      "active",                 // "active" | "beta" | "deprecated"
  ui: {
    kind:      "fullpage",               // "fullpage" | "popup-compat" (rendered inside viewport)
    view:      () => import("./view.js") // dynamic — only loads when mounted
  },
  service: {
    handlers:  () => import("./service.js")  // dynamic — loaded by SW on first message
  },
  permissions: {
    needs:        ["storage", "tabs", "scripting", "clipboardWrite"],
    hosts:        ["https://radapps3.wal-mart.com/Protected/CaseVisibility/*",
                   "https://ivrattcloud-prod.wal-mart.com/*"]
  },
  contentScripts: [                       // declarative content scripts; merged into manifest
    { matches: ["https://radapps3.wal-mart.com/Protected/CaseVisibility/*"],
      js:      ["modules/closinglist/content/casevisibility.js"],
      run_at:  "document_idle" },
    { matches: ["https://ivrattcloud-prod.wal-mart.com/*"],
      js:      ["modules/closinglist/content/ivr.js"],
      run_at:  "document_idle" }
  ],
  webRequestFilters: []                   // optional — for modules like AurorBuddy that sniff headers
};

export function register(host) {
  // host is the shell API surface: { storage, messaging, tabs, auth, http, ui, logging, ... }
  // Modules use this instead of touching globals or chrome.* directly.
}
```

**Why this shape:**
- All metadata is in one file per module → easy to scan + lint
- Permissions are co-located with the code that needs them → audit is grep-friendly
- Content scripts and webRequest filters are declared via the manifest but registered through the module → the shell merges them into the single MV3 `manifest.json` at build time (or at load time for dev)
- `service: { handlers: () => import(...) }` is dynamic — service worker doesn't pay the cost of loading every module's service code on every wake; modules are loaded lazily as their first message arrives
- `accent` lets each module skin its viewport without breaking the shell theme

---

## 3. The shell

### 3.1 `app.html`

```
┌────────────────────────────────────────────────────────────────────────┐
│  HEADER: APAISuite · global search · user pill                         │
├────────────┬───────────────────────────────────────────────────────────┤
│            │                                                           │
│  SIDEBAR   │  VIEWPORT                                                 │
│            │  (one module mounted at a time; persists state when       │
│  ▸ Home    │   switched away via storage.session.<module>.<state>)     │
│  ▸ Closing │                                                           │
│    List    │                                                           │
│  ▸ Auror   │                                                           │
│    Buddy   │                                                           │
│  ▸ Spark   │                                                           │
│    Fraud   │                                                           │
│            │                                                           │
│  ───────   │                                                           │
│  Settings  │                                                           │
│  Docs      │                                                           │
└────────────┴───────────────────────────────────────────────────────────┘
```

- Sidebar is auto-generated from the module registry. The shell renders one row per module, sorted by registry order (stable) with `status: deprecated` modules moved to a collapsed group.
- "Home" is a fixed top entry — a dashboard showing module cards with status + quick-launch.
- Viewport is a single `<main>` slot. The current module's `view.html` is loaded into it, scoped CSS class `.module-<id>` applied to the root.
- Navigation is hash-based (`#/closinglist`, `#/aurorbuddy/...`) so deep-links survive bookmarks and the back button works.

### 3.2 Dashboard (`#/home`)

A grid of module cards (re-using `.card`). Each card:

```
┌──────────────────────────────────┐
│ [icon]  ClosingList         •●●○ │  ← status pill
│         Closing-shift email      │
│         draft from CV + IVR      │
│                                  │
│         [ Open ]    [ ? ]        │
└──────────────────────────────────┘
```

### 3.3 Module mounting lifecycle

1. User clicks a sidebar item → shell routes to `#/<id>`
2. Shell awaits `manifest.ui.view()` (dynamic import)
3. Shell unmounts current module by calling its returned `cleanup()` (if any)
4. Shell injects module's `view.html` markup into `<main>`, adds `.module-<id>` class
5. Shell calls module's exported `mount(host)`; module returns `{ cleanup }`
6. Module owns the viewport DOM until next route change

### 3.4 The `host` API surface

A single immutable object passed to every module's `register()` and `mount()`. This is the entire platform.

```js
host = {
  id:        "closinglist",         // injected — module's own id
  storage:   storageScoped(id),     // .get(k), .set(k,v), .remove(k), .session.{...}, .sync.{...}
  messaging: { send, sendToTab, broadcast, on },
  tabs:      { findOrOpen, waitForLoad, focus, query, create, update, remove },
  auth:      { clickSso, readCookiesViaTab, captureHeader, getCachedHeader },
  http:      { postJson, getJson },
  ui:        { $, delegate, escapeHtml, status, spinner, modal, toast },
  logging:   { emit, read, EVENTS },
  config:    { get, set, watch },
  shell:     { route, accent, broadcastToShell }
};
```

Modules **must not** touch raw `chrome.*` APIs except through `host`. (Lint rule, not enforced at runtime in v1 — relax only with reason.)

---

## 4. Service worker dispatch

A single `chrome.runtime.onMessage` listener routes by `msg.module`:

```js
// background/service_worker.js
const handlers = new Map();   // moduleId -> { type -> handler }

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const { module, type } = msg ?? {};
  const moduleHandlers = handlers.get(module);
  const handler = moduleHandlers?.[type];
  if (!handler) {
    sendResponse({ ok: false, error: `Unknown ${module}.${type}` });
    return false;
  }
  Promise.resolve(handler(msg, sender)).then(sendResponse, err => {
    sendResponse({ ok: false, error: String(err?.message ?? err) });
  });
  return true;
});

// Modules register their handlers on first reference (lazy import):
async function ensureLoaded(moduleId) {
  if (handlers.has(moduleId)) return;
  const m = await import(`../modules/${moduleId}/service.js`);
  handlers.set(moduleId, m.handlers);
}
```

The shell's `messaging.send(type, payload)` automatically injects `module: <id>` based on the calling module's host.

---

## 5. Content scripts

Three patterns coexist:

1. **Declarative** (ClosingList) — listed in module manifest; shell concatenates into `manifest.json` content_scripts at build time.
2. **MAIN-world declarative** (SparkFraud) — same, with `world: "MAIN"`. Module-namespaced (e.g., `window.__APAI_CAP_sparkfraud`) — never the bare `__SPARK_CAP`.
3. **Imperative** (AurorBuddy) — via `chrome.scripting.executeScript`; called from a service handler with `host.tabs.execute(tabId, fn, args)`.

---

## 6. Storage namespacing

`host.storage` enforces `<moduleId>.<key>` prefixing on every read/write:

```js
// inside closinglist module
host.storage.sync.set("storeNbr", "9999");   // writes chrome.storage.sync["closinglist.storeNbr"]
host.storage.session.get("ivrFlowState");    // reads chrome.storage.session["closinglist.ivrFlowState"]
```

Migration from existing extensions copies values into the new namespace on first run (`shared/storage.js::migrate({legacy: "ivrFlowState", newKey: "ivrFlowState"})`).

A reserved `shell.*` namespace holds suite-level state (current route, sidebar collapsed/expanded, last active module).

---

## 7. Manifest assembly

The single `manifest.json` is the **union** of all module manifests + shell baseline. Built/assembled by a tiny `dev/build-manifest.js` script that:

1. Reads `modules/_registry.js`
2. For each module, pulls `permissions.needs`, `permissions.hosts`, `contentScripts`, `webRequestFilters`
3. Deduplicates
4. Writes `manifest.json` with the merged set

This means: **adding a new module's permissions does not require hand-editing `manifest.json`.** The build script does it. The script is committed; the output is committed; CI fails if they drift.

For v1 (no build pipeline yet), the script can be run by hand: `node dev/build-manifest.js`. The output is checked into git so sideload works without running the script.

---

## 8. CSS scoping

- **Tokens (`styles/tokens.css`)** — single source of truth: `--apai-blue`, `--apai-yellow`, `--apai-success`, etc. Per `DESIGN_SYSTEM.md`.
- **Base (`styles/base.css`)** — resets, body font, default link/heading styles.
- **Layout (`styles/layout.css`)** — sidebar, viewport, header.
- **Components (`styles/components.css`)** — `.btn`, `.card`, `.pill`, `.badge`, `.status-strip`, `.data-table`, `.modal`, `.spinner`.
- **Modules** — every selector in a module's `styles.css` must be a descendant of `.module-<id>`. Enforced by lint, not at runtime. Modules may use shared utility classes (`.btn-primary`, `.card`) directly without prefixing — those are the platform.

Module accent color (e.g., AurorBuddy uses Auror yellow, ClosingList uses Walmart blue) is applied via `--module-accent` set on `.module-<id>` at mount time.

---

## 9. Cross-cutting concerns

| Concern | Approach |
|---|---|
| Cancellation / aborts | `host` exposes `freshAbortSignal()` per module call — replaces the global `freshScanSignal` in AurorBuddy. |
| PII / data safety | Shared `logging.emit` runs SparkFraud's `sanitize()` regex on every payload; modules can extend the forbidden-key pattern. |
| Telemetry | All modules emit through `host.logging.emit`. Ring buffer is per-suite (one `chrome.storage.local.telemetry` keyed by `{module, event, ts, payload}`). |
| Journal / audit trail | Optional per-module `host.journal.save(summary)`. Same buffer pattern, separate key. |
| SSO patterns | Three different patterns (Auror, APPRISS, gscope) all use the same `host.auth.clickSso(tabId, [selectors])` primitive with their own selector lists. |
| HTTP retry | `host.http.postJson` is a generalization of AurorBuddy's `appriss_http.js`. Modules pass their own backoff / timeout / auth-wall-detector hooks where the defaults don't fit. |

---

## 10. What this architecture explicitly does NOT do

- **No build step required for sideload in v1.** Pure ES modules + a checked-in `manifest.json`.
- **No framework.** No React, Vue, Svelte. Plain DOM + delegated listeners. Same patterns the three donors already use.
- **No state library.** Each module owns its own state; shell holds only route + active-module.
- **No worker pools.** Service worker is the only background context; modules dispatch their long-running async on top of it.
- **No cross-module messaging in v1.** Modules can't directly talk to each other. If two modules need to share state, they share via a `shell.broadcastToShell` event or a `shell.*` storage key, not by direct dependency. Keeps modules genuinely independent.

---

## 11. Extension points for the future

When adding a new extension to the suite (see `MIGRATION_PLAN.md::Importing a new extension`), the only files touched are:

1. `modules/_registry.js` — append one import line
2. `modules/<newname>/` — added wholesale, no edits elsewhere
3. `manifest.json` — regenerated by `dev/build-manifest.js`

No edits to `app.js`, `app.html`, `background/service_worker.js`, `shared/*`, or any other module. This is the load-bearing invariant.
