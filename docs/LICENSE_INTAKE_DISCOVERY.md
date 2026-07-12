# LicenseIntake — Phase 1 Discovery

Audited 2026-06-05 during overnight autonomous build. Goal: enough APAISuite
+ AurorBuddy pattern to slot LicenseIntake in cleanly without re-auditing.

---

## APAISuite project layout

- Root: `C:\Users\ses008s.s01458\Desktop\APAISuite\unified-extension-suite\`
- MV3, `minimum_chrome_version: 120`
- Module slug convention: lowercase, no dashes (`aurorbuddy`, `digitallocks`, etc.)
- Registry: `modules/_registry.js` — single import + single array entry per module
- Shared services in `shared/`:
  - `storage.js` — `createStorage(moduleId)` → `{ local, sync, session }` with auto-namespaced keys (`<moduleId>.<key>`)
  - `messaging.js` — `createMessaging(moduleId)` → `send(type, payload)`, `sendToTab(...)`, `on(type, handler)`, `broadcast(...)`
  - `auth.js` — `createAuth(moduleId)` → `getCapturedHeader(storageKey, ttlMs)`, `hasSessionCookie(domain)`
  - `logging.js` — `createLogging(moduleId)` → `emit(event, payload)` with built-in `sanitize()` that redacts keys matching `authtoken|authheader|cookie|password|secret|phonenumber|firstname|lastname|email|address|orderid|orderno|driveruuid|driveruserid|jwt|bearer`. Extend via `extendForbiddenKeys(re)`.
  - `ui.js` — design system helpers (toast, modal, etc.)
- Styles: `styles/tokens.css` (CSS variables, never use color literals in modules) + `styles/components.css` (`.btn`, `.card`, `.field`, `.pill`, etc.)
- Manifest: top-level `manifest.json` is Chrome-authoritative for content-script declarations; `module.js::manifest.contentScripts` is documentation-only

## Required module files (all 5 must exist before the registry import)

```
modules/<slug>/
  module.js        ← default-exports { manifest, register }
  service.js       ← exports `handlers`; runs in service worker
  view.js          ← exports mount(host, container) → cleanup fn; runs in shell page
  view.html        ← markup fetched by view.js; IDs prefixed with slug
  styles.css       ← all selectors scoped under .module-<slug>
```

Optional convention: `lib/`, `content/`, `data/`, `test/fixtures/`, `dev/`.

## AurorBuddy reusables (donor module already inside APAISuite)

Path: `modules/aurorbuddy/`. Most useful pieces for LicenseIntake:

| Pattern | File | What we'll borrow |
|---|---|---|
| Auror JWT capture | `module.js::manifest.webRequestFilters` + `service.js` `createAuth("aurorbuddy").getCapturedHeader("auror.jwt", JWT_TTL_MS)` | Same shape — we declare our own `licenseintake.auror.jwt` storageKey OR call AurorBuddy's via cross-module messaging (cleaner; one capture, two readers) |
| Auror identity search | inline in `service.js` `resolveAurorPerson(personId)` hitting `personIdentitySearch?searchString=<X>` | Adapt — same endpoint accepts arbitrary search strings, not just P-numbers. We can pass last name. |
| Auror form drive | `lib/auror_event.js` `driveForm()` injected via `chrome.scripting.executeScript({world: "MAIN"})` with React-aware `setReactValue` + `typeSlowly` helpers | Borrow concept for any auto-fill on `/event/new`; do not auto-submit |
| APPRISS cross-reference | `lib/appriss.js::apprissLookupAll(suspects, homeStore)` + `lib/appriss_http.js::postJson()` retry/auth-wall wrapper | Cross-module-message `aurorbuddy::appriss_lookup` (no direct call) — APPRISS uses cookie auth, AurorBuddy already manages session probe |
| Name-matching | `lib/appriss_names.js` (`surnameIsLastToken`, `firstNameCandidates`, `nameMatchesAny`) | Pure functions, import directly from sibling for match scoring |
| Timings | `lib/timings.js` `Timings` class | Generic, import directly |

## Cross-module messaging — AurorBuddy handlers we can invoke

From `aurorbuddy/service.js::handlers`:

- `preflight` → ensures Auror + APPRISS auth, returns timings + readiness
- `scan_auror` → store-scoped suspect scan (not what we need; we want name-based)
- `appriss_lookup` → APPRISS Secure cross-reference, takes suspects + homeStore
- `create_event` → opens `/event/new` and auto-fills from a transaction (the main reuse candidate for license-intake → Auror handoff)
- `find_stores` → store-finder DOM scrape, generic enough
- `download_evidence` → CCTV + receipt to disk (post-event)

Call from licenseintake/service.js via `host.messaging.send("aurorbuddy", <type>, payload)` after the shell SW dispatcher routes by `(module, type)`. **Note:** for V1 we can also issue direct messages to the suite SW with `module: "aurorbuddy"` field.

## What AurorBuddy does NOT have (we must build fresh)

- License-document parsing / AAMVA decoder — port from `Desktop\AurorImport\extension\modules\LicenseCapture\modules\LicenseCapture\aamvaParser.js`
- Auror person CREATE / new-record API — AurorBuddy only fills the React UI form; there's no JSON POST. We can fill the form but NEVER auto-submit.
- Auror evidence file upload — AurorBuddy downloads evidence, doesn't upload. License-image attach is a future stretch goal.
- PII redaction — AurorBuddy logs names/P-numbers freely. LicenseIntake MUST `host.logging.extendForbiddenKeys()` for DL#, DOB, address fields and use a local `redact()` helper for everything that touches the console.

## Live actions classification (overnight build = DRY_RUN default)

| Action | Safe overnight? | Why |
|---|---|---|
| Parse barcode payload locally | ✅ Yes | Pure JS, no network |
| Score name match against a fake candidate list | ✅ Yes | Pure math |
| Store intake session redacted to `chrome.storage.local` | ✅ Yes | Local only, no network |
| Live Auror `personIdentitySearch` GET | ⚠️ Read-only, behind dry-run gate | Read-only API but emits Auror-side activity logs; default off, surface a toggle |
| Live `appriss_lookup` via AurorBuddy handoff | ⚠️ Same as above | Generates auditable activity; gated |
| Auror `/event/new` page open + form prefill | ⚠️ Confirmation-gated | Opens a tab the user can see and abandon; safe but requires explicit click |
| Auror person CREATE submit | ❌ Never autonomously | Live PII write |
| Card/transaction details fetch | ⚠️ Via AurorBuddy only, dry-run default | Sensitive cardholder data |

## Slot-in plan

```
modules/licenseintake/
  module.js                                # manifest (id: "licenseintake", accent, capture filter)
  service.js                               # handlers: parse, search_auror, appriss_handoff, save_session
  view.html, view.js, styles.css           # UI shell
  lib/
    license_parser.js                      # AAMVA byte-walk (ported)
    intake_models.js                       # LicensePerson, IntakeSession, ReviewStatus enum
    redaction.js                           # mask/expand helpers, log-safe formatters
    intake_storage.js                      # createStorage('licenseintake').local wrapper
    auror_search_adapter.js                # personIdentitySearch + match scoring + dry-run
    auror_person_draft_adapter.js          # clipboard + AurorBuddy create_event handoff
    card_lookup_adapter.js                 # AurorBuddy appriss_lookup handoff
  test/fixtures/fakeLicensePayloads.js     # FAKE only — pattern-correct AAMVA, fake values
  dev/testLicenseParser.html               # manual test harness (assertions in browser)
```

Manifest add: `licenseintake` to `_registry.js` after all 5 required files exist.

Permission ask: `storage`, `tabs`, `scripting` (for future page fill), `cookies` (for AurorBuddy handoff). Hosts: Auror only initially; APPRISS comes through AurorBuddy's existing host grant.
