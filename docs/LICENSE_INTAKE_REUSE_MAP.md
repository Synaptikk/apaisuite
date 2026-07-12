# LicenseIntake — Reuse map

What this module reuses from AurorBuddy + the APAISuite shell, and where
each piece lives. The point of this doc is to make the integration
explicit so future maintainers don't re-derive it.

> **Hard rule:** every entry in the "Reuse direction" column says either
> "wraps existing" or "imports directly". This module does NOT
> reimplement Auror auth, APPRISS auth, Auror form-fill, or APPRISS
> retry/throttle. We call AurorBuddy's handlers via direct in-SW
> function imports (cross-module messaging from the SW doesn't work —
> documented in code).

| Capability | Existing file | Existing function | Our reuse | Notes |
|---|---|---|---|---|
| **Auror JWT capture** | `modules/aurorbuddy/module.js` | `manifest.webRequestFilters` (declarative) | Shared read | We read the same `aurorbuddy.auror.jwt` key via `createAuth("aurorbuddy").getCapturedHeader(...)`. Our `module.js` has `webRequestFilters: []` to avoid double-listener. |
| **Auror JWT cold-read fallback** | `shared/auth.js`, `shared/captured_headers.js` | `getCapturedHeader` reads from in-memory map populated by shell SW IIFE | Wrap with chain | `auror_search_adapter.js::resolveAurorToken()` falls through: in-memory → `chrome.storage.session` → `aurorbuddy.preflight()` so the JWT survives SW cold-wake. |
| **Auror person search** | `modules/aurorbuddy/lib/auror.js` | `searchPeople({ token, stores, homeStore, days })` — store-scoped | **Not a fit** — we need global name search. We call `searchPeople` directly with `searchString` populated + no `siteTraits`. Same endpoint, different params. Documented limitation: typo'd records won't surface (`Duckworth` ≠ `Duckwortth` per Auror's tokenizer). | `auror_search_adapter.js::fetchSearchPeopleByName` |
| **Auror P-number resolve** | `modules/aurorbuddy/service.js::resolveAurorPerson` | `personIdentitySearch?searchString=<P-number>` | Not currently used; available for future "open by P-number" feature. | |
| **Auror preflight (warm auth)** | `modules/aurorbuddy/service.js::handlers.preflight` | Probes Auror+APPRISS, opens SSO tabs if needed | Direct in-SW call | `auror_search_adapter.js::resolveAurorToken` calls `_aurorbuddy.preflight()` as cold-path fallback. |
| **APPRISS Secure lookup** | `modules/aurorbuddy/lib/appriss.js` + `appriss_http.js` | `apprissLookupAll(suspects, homeStore, opts)` | Direct in-SW call via `aurorbuddy::appriss_lookup` handler | `card_lookup_adapter.js::lookupCardsByPerson` builds a one-suspect shim and calls `_aurorbuddy.appriss_lookup`. We do NOT duplicate auth, retry, or rate-limit logic. |
| **APPRISS auth/session probe** | `modules/aurorbuddy/service.js::ensureApprissAuth` | Opens APPRISS SAML tab, polls cookie | Invoked transitively via `preflight` and `appriss_lookup` | We never talk to APPRISS directly. All session management is AurorBuddy's. |
| **APPRISS surname matcher** | `modules/aurorbuddy/lib/appriss_names.js` | `surnameIsLastToken`, `firstNameCandidates`, `nameMatchesAny`, `dedupCards`, `dedupTransactions` | Indirect — applied inside `apprissLookupAll`. Could import directly if we needed richer scoring in `card_lookup_adapter.js`. | Currently we use our own simpler `scoreTransactionCandidate`. |
| **Auror event-form drive** | `modules/aurorbuddy/lib/auror_event.js` | `fillAurorEvent(data, { onLog })` injected via `chrome.scripting.executeScript({ world: "MAIN" })`; React-aware `setReactValue` + `typeSlowly` helpers | Direct in-SW call via `aurorbuddy::create_event` handler | `auror_person_draft_adapter.js::handoffToAurorBuddyCreate` builds the synthetic transaction payload and calls `_aurorbuddy.create_event`. **Never auto-submits** — fills the form, operator clicks Submit. |
| **Auror evidence download (CCTV+receipt)** | `modules/aurorbuddy/lib/evidence_downloader.js` | `downloadEvidence({ transactionId, suspectName })` | Direct in-SW call via `aurorbuddy::download_evidence` handler | Wired in the card-section UI: per-transaction "Download evidence" button → `aurorbuddy::download_evidence`. Saves to `Downloads/AurorBuddyDownloads/<suspect>/`. |
| **Cross-module messaging** | `shared/messaging.js`, `background/service_worker.js` | Dispatcher routes by `{module, type}` | View-level uses raw `chrome.runtime.sendMessage`; SW-level uses direct static import of sibling handlers (because `chrome.runtime.sendMessage` from SW doesn't reach the same SW). | See comment block in `card_lookup_adapter.js::callAurorBuddy`. |
| **Namespaced storage** | `shared/storage.js` | `createStorage("licenseintake")` → `{ local, sync, session }` | Direct use | `intake_storage.js` uses `_store.local.{get,set,remove,onChange}`. No `sync`. No PII keys logged. |
| **Structured logging + PII redaction** | `shared/logging.js` | `createLogging(moduleId).emit(event, payload)` + `sanitize()` regex | Direct use + extend | `module.js::register()` calls `host.logging.extendForbiddenKeys(LOG_FORBIDDEN_KEYS_RE)` so DL#, DOB, address, etc. auto-redact in structured logs. |

## Glue we DID write (and why)

These files exist only because they're glue between the scanner and the
above pieces — none of them duplicate functionality that AurorBuddy
already has.

| Glue file | Purpose | Why not reused |
|---|---|---|
| `lib/license_parser.js` | AAMVA PDF417 → `LicensePerson` | No AurorBuddy equivalent. Source of truth is the AurorImport project's parser (same byte-walk algorithm). |
| `lib/redaction.js` | `maskLicenseNumber`, `maskDob`, `buildRedactedPreview`, `redactForLog`, `LOG_FORBIDDEN_KEYS_RE` | The shell logger's sanitize() doesn't know about DL#/DOB/address. We extend it. |
| `lib/intake_models.js` | `IntakeSession`, `REVIEW_STATUS`, `MATCH_CLASS`, `CARD_LOOKUP_CLASS` | LicenseIntake-specific review state. |
| `lib/intake_storage.js` | Persist `IntakeSession[]` to namespaced `chrome.storage.local` | Use of shared storage helper; specific to our session shape. |
| `lib/auror_search_adapter.js` | Wrap `searchPeople` for name-based queries + score against scanned license + classify | AurorBuddy's `searchPeople` only does store-scoped scans. We need name search. |
| `lib/auror_person_draft_adapter.js` | Build a draft from `LicensePerson` → handoff to `aurorbuddy::create_event` (gated) | AurorBuddy has no "draft from license" concept. The handoff itself is theirs. |
| `lib/card_lookup_adapter.js` | Build suspect shim from `LicensePerson` → call `aurorbuddy::appriss_lookup` → normalize `appriss_cards[].transactions[]` for our UI | The lookup is AurorBuddy's; we just wrap the input/output. |
| `lib/licenseIntakeController.js` | Single `runFullWorkflow(rawText, opts)` that orchestrates parse → session → Auror search → APPRISS lookup → save | The new orchestration layer — was previously scattered across `service.js` handlers + view click handlers. |
| `content/auror_inline.js` | Inline "Scan License" button on Auror header + overlay scanner | Page-side glue; no AurorBuddy equivalent. |
| `service.js` | SW handlers (`parse`, `search_auror`, `card_lookup`, `handoff_create_person`, `scan_and_search`, ...) | The handler surface for the view + content script. Delegates to the adapters above. |
| `view.js` / `view.html` / `styles.css` | Side-panel UI | Module-specific. |

## What's intentionally NOT in this module

- A custom Auror auth path (we share `aurorbuddy.auror.jwt`)
- A custom APPRISS auth path (we go through `aurorbuddy::appriss_lookup` which manages it)
- A custom Auror person-CREATE submit (manual operator gesture in the opened tab)
- A custom evidence upload to Auror (AurorBuddy doesn't have it either — V2 work)
- Any PII processing outside the device

## Known limitation: typo'd Auror records

The `SearchApi/searchPeople?searchString=<query>` endpoint tokenizes the
query and matches records containing **any** token literally. Records
with typos in indexed fields (e.g. license "Duckworth" vs Auror
"Duckwortth") don't surface for the exact-name query — the Auror UI's
global search bar uses a different fuzzy-capable endpoint we haven't
identified.

Mitigation today: send a second `"First"` alone query, then fuzzy-match
last names with Levenshtein distance ≤2 in `scoreAurorPersonMatch`,
then require BOTH first AND last signals to pass the precision filter.
Documented in `LICENSE_INTAKE_INTEGRATION_STATUS.md` under "Next steps".
