# Module Contract

How modules are structured, registered, styled, and stored in APAISuite.
This file replaces the dispersed module guidance previously spread across
`ARCHITECTURE.md`, `MIGRATION_PLAN.md`, and `CLAUDE.md` for the parts that
describe the **shipping** contract (the historical phase-by-phase migration
narrative is no longer relevant).

**Last reviewed:** 2026-06-02 (matches code at v0.8.2).

---

## 1. Directory layout

```
modules/<slug>/
  module.js     ← REQUIRED. default-exports { manifest, register }.
  service.js    ← REQUIRED. exports `handlers` object. Runs in service worker.
  view.js       ← REQUIRED. exports `mount(host, container)` → cleanup fn. Runs in shell page.
  view.html     ← REQUIRED. fetched by view.js at mount time. IDs prefixed with slug.
  styles.css    ← REQUIRED. all selectors scoped under `.module-<slug>`.

  lib/          ← OPTIONAL. internal helpers, ideally pure / Node-testable.
  content/      ← OPTIONAL. content scripts; ALSO declared in top-level manifest.json.
  data/         ← OPTIONAL. user-editable JSON configs (loaded at runtime).
  components/   ← OPTIONAL. UI sub-components (digitallocks, claimsdisposition use this).
  vendor/       ← OPTIONAL. vendored libraries (claimsdisposition has pdfmake here).
  native_host/  ← OPTIONAL. native messaging manifest (claimsbuddy has this).
  fixtures/     ← OPTIONAL. replay fixtures (sparkfraud).
  models/       ← OPTIONAL. typed domain models (sparkfraud).
  registries/   ← OPTIONAL. JSON refs for selectors/enums (sparkfraud, closinglist).
  telemetry/    ← OPTIONAL. module-local event log (sparkfraud).
```

Required files are non-negotiable. The optional folders are just naming
conventions adopted by existing modules — feel free to add or skip per need.

---

## 2. Slug

URL-safe, lowercase, no dashes preferred (`closinglist`, not `closing-list`).
The slug is used:

- As the storage namespace prefix (`<slug>.<key>`)
- As the CSS scope class (`.module-<slug>`)
- As the path component (`modules/<slug>/...`)
- As `msg.module` on every message
- In hash routing (`#/<slug>`)

Pick once. Renaming is a multi-file find/replace plus a one-shot data
migration to rewrite storage keys.

---

## 3. `module.js` shape

```js
// Statically import service.js — MV3 service workers cannot use dynamic import().
// The handlers object is reachable via manifest.service.handlers at SW boot.
import { handlers } from "./service.js";

// Optional: if you need a wake-on-event listener (alarms, etc.), register it
// at top-level so Chrome wakes the SW when the event fires after idle — AND
// install the alarm there too, gated to the service worker. See the
// "Periodic alarms" rules below and workvivo/module.js for the shape.
import { IS_SERVICE_WORKER, ensureAlarm } from "../../shared/alarms.js";

if (IS_SERVICE_WORKER) {
  chrome.alarms.onAlarm.addListener(onAlarm);
  installAlarms().catch((e) => console.warn("[<slug>] installAlarms failed:", e));
}

export default {
  manifest: {
    id:          "<slug>",
    name:        "<Human Name>",
    description: "<one-line>",
    version:     "0.1.0",
    accent:      "#0071CE",                   // optional; sets --module-accent
    status:      "active",                    // "active" | "beta" | "deprecated"

    ui: {
      kind: "fullpage",

      // Optional sidebar + home-card glyph. INNER markup of a 20×20 stroke
      // icon — no <svg> wrapper. The shell adds the wrapper so every module
      // shares one viewBox, stroke-width 1.5 and currentColor. Omit it and
      // you get the generic four-square grid. See "Module icons" below.
      icon: `
        <rect x="4" y="8.8" width="12" height="8" rx="2"/>
        <path d="M7.1 8.8V6.4a2.9 2.9 0 0 1 5.8 0v2.4"/>
      `,

      view: () => import("./view.js"),        // LAZY — only loads when mounted
    },

    service: {
      // PLAIN OBJECT — NOT a thunk. The static import above already evaluated.
      // (The thunked design in ARCHITECTURE.md was abandoned because dynamic
      // import() is forbidden in MV3 service workers — see the comment block
      // at the top of background/service_worker.js.)
      handlers,
    },

    // Informational only. The actual permission grant comes from the
    // top-level manifest.json, which YOU must update when adding new hosts
    // or APIs.
    permissions: {
      needs: ["storage", "tabs", "scripting"],
      hosts: ["https://example.wal-mart.com/*"],
    },

    // Declarative content scripts. Listed here for documentation; the
    // top-level manifest.json content_scripts block is what Chrome reads.
    contentScripts: [
      { matches: ["https://example.wal-mart.com/*"],
        js:      ["modules/<slug>/content/foo.js"],
        run_at:  "document_idle" }
    ],

    // webRequest header-capture filters. The shell's SW reads these at boot
    // and synchronously registers one chrome.webRequest listener per entry.
    // The captured value is written to chrome.storage.session at key
    // `<slug>.<storageKey>` and available via host.auth.getCapturedHeader.
    webRequestFilters: [
      { urls:       ["https://*.example.com/api/*"],
        headerName: "authorization",
        storageKey: "auth.jwt",
        ttlMs:      1_200_000,
        predicate:  { startsWith: "Bearer " } },
    ],
  },

  async register(host) {
    // One-time module init. Runs at SHELL LOAD ONLY — app.js calls this when
    // it mounts a module. It NEVER runs in the service worker. Use it for
    // shell-side setup (pre-warming a view's cache, an on-open bootstrap).
    // Do NOT install alarms here — see below.
  },
};
```

### Periodic alarms — two rules, both non-obvious

Learned the hard way on 2026-08-20, when six modules were found with alarms
that had never fired once. Both rules are enforced by `shared/alarms.js`;
`shared/tests/alarms.test.mjs` pins the behaviour.

**1. Install from `module.js` top level, not from `register()`.**
`register()` is called by `app.js` when the shell mounts a module. The service
worker never calls it. An alarm installed there exists only while someone has
the suite tab open, and a browser that has never opened that module has no
alarm at all. Top-level code in `module.js` runs on every SW boot, which is
the actual "browser start" hook.

**2. Use `ensureAlarm()`, never bare `chrome.alarms.create()`.**
`create()` with the name of an existing alarm does **not** leave it alone: it
cancels that alarm and schedules a fresh one, restarting the period from zero.
Combined with rule 1 that was fatal — every shell page load reset the
countdown, so anyone who opened the suite more often than the alarm period
never saw it fire. `digitallocks` was the worst case at 24 hours.
`ensureAlarm()` reads first and only writes when the alarm is missing or its
period no longer matches the code, so changing a period constant still takes
effect on the next boot.

**And gate both on `IS_SERVICE_WORKER`.** `module.js` is imported by the shell
page as well as the SW, and extension pages receive `chrome.alarms` events
too. An ungated listener runs its handler once in the SW and once in every
open suite tab — separate module instances with separate in-flight guards,
each driving its own background tabs and writes.

### Long jobs must hold the worker awake

Any service-worker job that runs for more than ~30 seconds needs
`shared/sw_keepalive.js`:

```js
import { keepAwake } from "../../shared/sw_keepalive.js";

const release = keepAwake("mymodule.pullThing");
try { ...long job... } finally { release(); }
// or: return withKeepAwake("mymodule.pullThing", () => doTheJob());
```

**Why it is not optional.** An extension service worker is torn down after ~30
seconds of *inactivity*, where activity means calling an extension API — not
awaiting a promise, and not a `fetch()` in flight. While the suite page is open
the pending `sendResponse` channel holds the worker up, so everything looks
fine. Close that tab or navigate it away and the port closes, the keep-alive
goes with it, and a job that is mostly `await fetch(...)` is collected part way
through with no error recorded anywhere. It reads as "background loading stops
when I navigate away".

Jobs that poll `chrome.tabs` / `chrome.scripting` in a loop (vizpick's Today
crawl) survive by accident, because each call resets the timer. Do not rely on
that — it is a property of how a capture happens to be written, and it changes
the moment someone replaces DOM-driving with a direct HTTP call.

Refcounted, so overlapping jobs share one timer and the last release stops it.
Always release in a `finally`.

### Optional hook: `suite_opened`

A module may expose a `suite_opened` handler alongside its normal ones:

```js
export const handlers = {
  async "suite_opened"(_msg) { return await openCheck(); },
  // ...
};
```

The shell dispatches it once per shell page load, to **every module that has
one**, discovered from the registry — `app.js` never names a module. Adding the
handler is the whole opt-in.

Use it when opening the suite means a user is about to look at your data and
waiting for the next alarm tick would be the wrong trade. Rules:

- **Rate-limit it yourself.** The shell can be reloaded repeatedly, and every
  reload of an unpacked extension re-opens it. `vizpick` uses a 5-minute floor
  against the same timestamp its alarm uses.
- **Make the no-op case cheap.** `vizpick` reads the source's own "last
  updated" text and stops there unless it moved; it only became reasonable to
  run this on open once that check stopped costing a full export.
- **Never assume it is awaited.** The shell fires it after the first route and
  ignores the result, so a module driving a background tab cannot delay the
  first paint.

### Registration

`modules/_registry.js`:

```js
import yourmodule from "./yourmodule/module.js";

export default [
  // ...existing modules,
  yourmodule,
];
```

That's it. No edits to `app.js`, `background/service_worker.js`, or anything
in `shared/`. If you find yourself wanting to edit those files for a new
module, the architecture has a hole — flag it before patching.

### Resolving a user id to a person

Use `shared/associateDirectory.js`. **Never** add a module-local directory
cache — three of them existed at once (digitallocks 24 h, claimsdisposition
30 d, assocpurchases 30 d), each re-pulling the same people on its own clock
and none able to see the others' results.

```js
import * as Directory from "../../shared/associateDirectory.js";

const known = await Directory.get(win);          // permanent; null = never seen
if (!known && !await Directory.isRecentMiss(win)) {
  const person = await yourSourceLookup(win);     // only for unknown WINs
  if (person) await Directory.merge(win, { name: person.name,
                                           lengthOfService: person.los,
                                           sources: { name: "yoursource" } });
  else        await Directory.markMiss(win);
}
```

Three rules the store enforces, all worth knowing before you extend it:

- **Hits are permanent, misses are not.** A resolved person is a fact. A "no
  match" is usually a failure (auth wall, page not rendered, ambiguous
  search), so it gets a 1-hour window instead of being cached forever.
- **Never store elapsed tenure.** Workday's "Length of Service" is only true
  on the day it was read. Hand `merge()` the raw string (or `tenureDays`) and
  it stores a *hire date*; read tenure back with `tenureDaysFor(record)`,
  which recomputes on every call. This is what makes "pull once, keep
  forever" correct instead of a slow staleness bug.
- **`merge()` never blanks a known field.** Workvivo resolves names but not
  tenure; Workday resolves both. Whichever runs second must not erase what
  the first learned.

Transfers, promotions and name changes have no TTL that would catch them —
call `Directory.forget(win)` (digitallocks exposes this as
`lookupAssociate({ userId, refresh: true })`) to force one re-pull.
`shared/tests/associateDirectory.test.mjs` pins all of the above.

---

## 4. `service.js` shape

```js
// All handler functions are async (msg, sender) => result.
// Result is auto-wrapped to { ok: true, data: result } unless you return
// something with an explicit `ok` key.

async function findThing(msg, sender) {
  const { id } = msg;
  // ...do work...
  return { item };          // becomes { ok: true, data: { item } }
}

async function failableThing(msg) {
  if (msg.bad) return { ok: false, error: "bad input" };
  return "done";
}

export const handlers = {
  "find_thing":    findThing,
  "failable":      failableThing,
};
```

### Storage in service.js

**Use raw `chrome.storage.*` with manual prefixing.** The `host` object only
exists in the view page; service.js does not get one.

```js
// ✅ correct
await chrome.storage.local.set({ "yourmodule.lastResult": data });
const { "yourmodule.lastResult": cached } = await chrome.storage.local.get("yourmodule.lastResult");

// ❌ wrong — host is undefined in SW
await host.storage.local.set("lastResult", data);
```

### Sending broadcasts from service.js

Use `chrome.runtime.sendMessage({ module: "<slug>", type: "progress", payload: {...} })`
— the shell's `host.messaging.on` subscribers on the view side will receive it.

---

## 5. `view.js` shape

```js
export async function mount(host, container) {
  // 1. Fetch and inject markup
  const html = await fetch(host.url("view.html")).then(r => r.text());
  container.innerHTML = html;

  // 2. Wire up DOM
  const $btn = container.querySelector("#yourmodule-go");
  const onClick = async () => {
    const res = await host.messaging.send("find_thing", { id: "42" });
    if (res.ok) host.ui.toast(`got ${res.data.item}`);
    else        host.ui.toast(res.error, { kind: "error" });
  };
  $btn.addEventListener("click", onClick);

  // 3. Subscribe to broadcasts FROM the SW
  const unsubProgress = host.messaging.on("progress", (msg) => {
    container.querySelector("#yourmodule-progress").textContent = msg.payload.pct + "%";
  });

  // 4. Return a cleanup. CRITICAL.
  return () => {
    $btn.removeEventListener("click", onClick);
    unsubProgress();
  };
}
```

`mount` returns a `cleanup()` that the shell calls on route change.
**Every `host.messaging.on` subscription MUST be unsubscribed in cleanup.**
The shell does not GC listeners — without cleanup, listeners stack on every
navigation.

---

## 6. The `host` object

Created by `shared/host.js::createHost(moduleId, shellApi)`. Passed to
`mount(host, container)` and `register(host)`. Frozen.

```js
host.id                // your slug
host.url(path)         // chrome.runtime.getURL(`modules/<id>/${path}`)
host.storage.local     // .get(k), .set(k,v), .remove(k) — auto-namespaces "<id>.<k>"
host.storage.sync      // same, but chrome.storage.sync (per-user, syncs across devices)
host.storage.session   // same, but chrome.storage.session (dies with browser)
host.messaging.send(type, payload)          // → SW, returns { ok, data | error }
host.messaging.sendToTab(tabId, type, payload, { fallbackScripts })
host.messaging.on(type, handler)            // returns unsubscribe()
host.messaging.broadcast(type, payload)     // to all subscribers
host.tabs.findOrOpen(url, { activate })     // returns tab; reuses an existing one
host.tabs.waitForLoad(tabId, { timeoutMs })
host.tabs.focus(tabId)
host.tabs.execute(tabId, fn, args)          // wraps chrome.scripting.executeScript
host.auth.clickSso(tabId, selectors)
host.auth.captureHeader({ ... })            // see webRequestFilters above; usually
                                             //   declared via manifest is preferred
host.auth.getCapturedHeader(storageKey)
host.auth.readCookiesViaTab(tabId)          // gscope/Edge workaround
host.auth.hasSessionCookie(domain, predicate)
host.http.postJson(url, body, opts)
host.http.getJson(url, opts)
host.logging.emit(eventName, payload)       // ring buffer in chrome.storage.local
host.logging.read()
host.ui.$(selector, root)                   // querySelector
host.ui.delegate(root, selector, ev, fn)    // CSP-safe event delegation
host.ui.escapeHtml(str)
host.ui.toast(msg, { kind })
host.ui.modal(...)
host.ui.spinner()
host.shell.route(hash)                      // navigate (e.g. "#/yourmodule")
```

---

## 7. Storage rules

| What | Where | Namespaced by |
|---|---|---|
| View-page code | `host.storage.{local,sync,session}` | wrapper injects `<id>.` automatically |
| SW code | raw `chrome.storage.*` | YOU prefix manually: `"<id>.key"` |
| Content scripts | raw `chrome.storage.local` (NOT session) | YOU prefix manually |
| Reserved suite-level | `shell.*` keys | reserved; don't write |

Storage scope rules:

- `chrome.storage.session` dies with the browser process; great for OAuth-y
  caches that should not survive a restart.
- `chrome.storage.session` is **NOT available in content scripts** — reads
  throw. Use `local` if a content script needs to share state.
- `chrome.storage.sync` syncs across devices for the same Chrome profile;
  great for user prefs. Subject to small size quotas — don't put bulk data
  there.
- For large bulk data (>5MB) use IndexedDB (see `claimsdisposition/lib/db.js`
  or `digitallocks` for examples) — needs `unlimitedStorage` permission
  (already in the manifest).

---

## 8. CSS rules

- All tokens come from `styles/tokens.css` (`--apai-*`). Modules should not
  define their own color literals.
- Every selector in `modules/<slug>/styles.css` must descend from
  `.module-<slug>` (the shell applies this class when mounting).
- Per-module accent: set `--module-accent`, `--module-accent-dark`,
  `--module-accent-darker` on `.module-<slug>`.
- Module-local IDs should be prefixed with the slug or a 2-letter mnemonic
  (`#cl-recipient`, `#ab-suspects-tbody`, `#sf-results-tbody`, `#dl-tab-active`).
- Reuse the shared `.btn`, `.card`, `.pill`, `.badge`, `.data-table`,
  `.field`, `.fieldset`, `.modal`, `.toast`, `.spinner`, `.progress-bar`,
  `.state-{empty,loading,error}` components from `styles/components.css`.
  See [`DESIGN_SYSTEM.md`](DESIGN_SYSTEM.md).
- **Always-mounted overlay pitfall:** drawer/modal backdrops that toggle
  only `opacity` between open/closed leave an invisible click-eating layer.
  Pair every opacity toggle with `pointer-events: none/auto`. (Documented in
  `MEMORY.md` after a real bite.)

### Module icons

`manifest.ui.icon` is the module's glyph in the sidebar nav and on its home
card. Rules, all of them enforced by the shell owning the wrapper:

- Supply **inner markup only** — paths/rects/circles, no `<svg>` element.
  `app.js::iconSvgString()` wraps it in
  `viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"`.
- Draw on a **20×20 grid**. It renders at 22px on the home card and 18px in
  the sidebar, so anything finer than ~1.5px of separation closes up.
- **Never hard-code a colour.** `stroke` is inherited, which is what makes the
  icon follow the active/hover/theme colour. `fill="currentColor"` is fine for
  a solid dot; a literal hex is not.
- Omitting `icon` is legitimate — the module gets the generic four-square
  grid. The shell has no per-module icon table, so a folder dropped in with a
  registry line still renders correctly with or without a glyph.

`dev/icon-proposals.html` is the contact sheet for the current set (open it in
a browser); it also carries the alternates that weren't chosen.

---

## 9. Content scripts

Two declaration sites — keep them in sync:

1. **`modules/<slug>/module.js::manifest.contentScripts`** — informational
2. **Top-level `manifest.json::content_scripts`** — what Chrome actually reads

There is currently no build step that propagates (1) into (2) — `dev/build-manifest.js`
exists but is not in the release pipeline. **Edit both** when adding a content
script.

MAIN-world content scripts (e.g., `sparkfraud/content/capture.js`) must use a
module-namespaced global to avoid colliding with other modules that hook the
same page (`window.__APAISUITE_SPARKFRAUD_CAP`, not the bare `__SPARK_CAP`).

---

## 10. Background-auth policy (suite-wide)

All modules open auth tabs **background-only** and auto-click the company SSO
button. Tabs are foregrounded only if auto-SSO times out. Reuse the shared
`SSO_SELECTORS` list. Standalone donor extensions must be disabled at
`edge://extensions` while the suite is active — see
`MEMORY.md::Standalone donors must be disabled when suite is active`.

Per-domain SSO entry-points worth knowing about:

- gscope SSO: open `https://pfedprod.wal-mart.com/idp/startSSO.ping?PartnerSpId=https://gscope.walmartlabs.com/sp`
  in background, click "Go" — faster than the `/login` flow.
- Secure/APPRISS: import the origin from `shared/appriss.js`. It is
  `apps.apprissretail.com/walmart-usa` and the tenant prefix is mandatory —
  the bare path 403s. Never hardcode it; it has been renamed once already.

### Every background tab must have an owner and an end

A background tab you opened is yours to close. A tab the user already had open
is not — never close it, and never navigate it out from under them. Which of
the two you have is a **fact you must not drop**, because both look identical
by the time cleanup runs.

Do not re-derive it with a local flag. Two helpers carry it for you:

| Situation | Use |
|---|---|
| One-shot job: open page, do work, done | `withTempTab(url, fn)` — or `findOrOpenTracked()` + `closeIfOpened(state)` in a `finally` |
| Tab must survive between calls (session/CSRF/SAML anchored) | `registerSessionTab(moduleId, tabId)` + `touchSessionTab(tabId)` on each use |

Both live in `shared/tabs.js` / `shared/tabSessions.js` and are covered by
`shared/tests/tabs.test.mjs` and `shared/tests/tabSessions.test.mjs`.

The second row is not an escape hatch for "closing is inconvenient" — it is for
tabs where closing costs a real reauth (claimsdisposition's Looker embed,
livedashboard's Hoops portal, sparkfraud's post-SSO gscope tab,
`associateLookup`'s Workvivo/Workday tabs). Registered tabs are swept by the
suite-level `_suite_tabreap` alarm once they have been idle past their window
(default 15 min), so "keep it alive" never again means "keep it forever".

Note the trap that made this a suite-wide bug: a module-scope `let _tabId`
cache is discarded when the MV3 worker idles out after ~30s — **the tab is
not**. The pointer goes away and the window stays, so the next wake opens
another one. Any tab pointer that must outlive a single call belongs in
`chrome.storage.session`, which is what `tabSessions.js` uses.

---

## 11. Adding new permissions / hosts

When a module needs a new permission or new host:

1. Add it to the module's `manifest.permissions.needs` / `.hosts` block
   (documentation).
2. **Add it to the top-level `manifest.json`** — this is what Chrome enforces.
3. Reload the extension at `edge://extensions` (manifest changes don't apply
   without a reload).

`scripts/build-manifest.js` exists but is not currently wired in — treat the
top-level `manifest.json` as a manually-maintained file and remember to edit it.

---

## 12. Reload semantics

- **Shell code** (`app.js`, `app.html`, module `view.js`/`view.html`/`styles.css`,
  `shared/*`) — Cmd-R / Ctrl-R the shell tab. No extension reload needed.
- **SW code** (`background/service_worker.js`, module `service.js`,
  `shared/*` modules used by the SW) — go to `edge://extensions`, click
  the reload icon on the APAISuite card.
- **`manifest.json` or content-script source** — same: full extension reload.

---

## 13. Recipe: adding a new module

1. Pick a slug.
2. `mkdir modules/<slug>/`
3. Drop in `module.js`, `service.js`, `view.js`, `view.html`, `styles.css`
   per the shapes above.
4. Add `import x from "./<slug>/module.js"` + `x,` array entry to
   `modules/_registry.js`.
5. Update top-level `manifest.json` if you need new permissions, hosts, or
   content scripts.
6. Reload the extension. Sidebar should auto-show your module.
7. Add a row to the module table in [`AI_CONTEXT_BRIEF.md`](AI_CONTEXT_BRIEF.md).

Do NOT:
- Edit `app.js`, `app.html`, `background/service_worker.js`, or any `shared/*` file.
- Touch other modules.
- Modify the original donor extension folder.
- Add a one-off conditional in the shell for the new module.
