# Active Files

Files currently relevant to development. Organized by area. Anything not
listed here is either node_modules, donor-source-snapshot (not edited), or
historical.

**Last reviewed:** 2026-06-02.

---

## Shell + platform

| File | Role |
|---|---|
| `manifest.json` | Top-level MV3 manifest. Edit when adding hosts/perms/content-scripts. |
| `app.html` | Shell page — sidebar + viewport. |
| `app.js` | Shell bootstrap: registry load, sidebar render, route dispatch, mount/unmount. |
| `background/service_worker.js` | Single SW. Imports registry, registers webRequest/alarm/push listeners synchronously, dispatches `chrome.runtime.onMessage` by `(module, type)`. |
| `modules/_registry.js` | Source of truth for which modules ship. One line per module. |

## Shared platform (`shared/`)

| File | Role |
|---|---|
| `host.js` | Builds the `host` object every module receives. |
| `storage.js` | Namespaced `chrome.storage.{local,sync,session}` wrapper. |
| `messaging.js` | `send`, `sendToTab` (with re-injection), `on`, `broadcast`. |
| `tabs.js` | `findOrOpen`, `waitForLoad`, `focus`, `execute`. |
| `auth.js` | `clickSso`, `getCapturedHeader`, `readCookiesViaTab`, `hasSessionCookie`. |
| `captured_headers.js` | In-memory hot map of headers captured by webRequest listeners. |
| `http.js` | `postJson`, `getJson` with retry/timeout. (Mostly stub; modules still hand-roll fetch.) |
| `logging.js` | Telemetry ring buffer. |
| `ui.js` | DOM helpers (`$`, `delegate`, `escapeHtml`, `toast`, `modal`, etc.). |
| `registry.js` | Loads `modules/_registry.js`, exposes `listModules()` / `getModule(id)`. |
| `updater.js` | Polls `qrcallbox.com/extension/version.json`; writes to `shell.updater.*` storage. |
| `updater_ui.js` | Shell-page pill that renders the updater state. |
| `push.js` | VAPID Web Push subscription registration with QRCallBox. |

## Styles

| File | Role |
|---|---|
| `styles/tokens.css` | Single source of truth for `--apai-*` color/spacing/typography. |
| `styles/base.css` | Resets + body styles. |
| `styles/layout.css` | Shell layout (header, sidebar, viewport). |
| `styles/components.css` | `.btn`, `.card`, `.pill`, `.badge`, `.data-table`, `.modal`, etc. |

## Modules (`modules/<slug>/`)

Every module folder has at minimum: `module.js`, `service.js`, `view.js`,
`view.html`, `styles.css`. Module-specific structure:

| Module | Notable extras |
|---|---|
| `closinglist/` | `content/casevisibility.js`, `content/ivr.js`, `lib/parse.js`, `registries/` (4 JSON docs) |
| `aurorbuddy/` | `lib/` (auror, appriss, appriss_http, appriss_names, stores, auror_event, evidence_downloader, models, event_classifier, timings) |
| `sparkfraud/` | `content/capture.js` (MAIN-world), `lib/`, `models/` (typed domain), `registries/` (6 JSON), `fixtures/`, `telemetry/events.js`, `journal.js` |
| `claimsdisposition/` | `components/`, `data/`, `lib/` (incl. `db.js` IndexedDB layer, `userDirectory.js` cache), `vendor/pdfmake/` |
| `digitallocks/` | `content/powerbi_driver.js` (planned for V1.5), `data/role_zone_rules.json` + `high_risk_keywords.json` + `risk_weights.json`, `lib/` (parseLockEvents, riskScoring, statusStore, xlsx, db) |
| `workvivo/` | `lib/extract.js` (page-scope token extractor), `lib/qrcallbox.js` (server contract). Hourly alarm registered at top-level of `module.js`. |
| `claimsbuddy/` | `content/clearsight_content.js`, `native_host/` (native messaging host install). **Disabled** in `_registry.js`. |

## Build / release / dev scripts

| File | Role |
|---|---|
| `scripts/release.sh` | Bumps version, zips source, stages to QRCallBox. |
| `scripts/notify-released.sh` | Triggers Web Push notify to all subscribed extensions. |
| `scripts/render-icons.mjs` | Regenerates PNGs from `assets/logos/suite.svg`. |
| `scripts/zip-dir.mjs` | ZIP helper used by release.sh. |
| `scripts/templates/` | Templates rendered into QRCallBox during release. |
| `dev/probe-*.mjs` | One-off endpoint probes (Hoops, Workvivo, directory). Read findings in `dev/*_FINDINGS.md`, not the scripts. |
| `dev/edge-debug.mjs`, `dev/launch-edge-debug.{sh,ps1}` | Launch Edge with --remote-debugging-port for puppeteer probes. |

## Docs (this folder)

See [`DOC_STATUS.md`](DOC_STATUS.md) for the full status map.

| File | Read when... |
|---|---|
| `AI_CONTEXT_BRIEF.md` | First thing — orientation page |
| `MODULE_CONTRACT.md` | Adding or editing a module |
| `CURRENT_TASKS.md` | Picking up active work |
| `DOC_STATUS.md` | Wondering whether a doc is current |
| `DO_NOT_READ_BY_DEFAULT.md` | Tempted to read a stale doc |
| `DESIGN_SYSTEM.md` | Editing UI / styles |
| `RELEASING.md` | Cutting a release (skip CWS sections) |
| `DIGITAL_LOCKS_MODULE.md` + `DIGITAL_LOCKS_QUESTIONS.md` | Touching digitallocks |
| `ARCHITECTURE.md` | Designing a platform-level change (with stale-banner caveat) |

Module-local READMEs (read when working on that module):

- `assets/icons/README.md` — icon regeneration
- `modules/sparkfraud/fixtures/README.md` — replay fixtures
- `modules/sparkfraud/models/README.md` — typed domain models
- `modules/sparkfraud/registries/README.md` — JSON registries pattern
- `modules/sparkfraud/telemetry/README.md` — event ring buffer

Root of repo:

- `../CLAUDE.md` — project rules, loaded into every AI session
- `../claims_disposition_reference.md` — upstream Looker Studio reference for claimsdisposition

## Cross-repo

| Path | Role |
|---|---|
| `C:\Users\ses008s.s01458\Desktop\QRCallBox\` | Backend for `workvivo` module + release hosting + Web Push. |
| `QRCallBox/functions/src/http/workvivo/token-heartbeat.js` | Endpoint that the workvivo SW POSTs to hourly. Keep in sync with `modules/workvivo/lib/qrcallbox.js`. |
| `QRCallBox/Workvivo/WORKVIVO.md` | Auth discovery doc explaining why server-side reauth is dead. |
| `QRCallBox/public/extension/version.json` | What the in-extension updater polls. |
| `QRCallBox/public/extension/releases.json` | Long-form release notes history. |
