# LicenseIntake — Integration status

Last updated 2026-06-06.

| # | Capability | Source | Status |
|---|---|---|---|
| 1 | Auror JWT capture (shared) | AurorBuddy `module.js::webRequestFilters` + `shared/auth.js` | ✅ **Live** — read via `createAuth("aurorbuddy").getCapturedHeader("auror.jwt", ...)` |
| 2 | Auror JWT cold-read fallback (in-memory → storage.session → preflight) | LicenseIntake `auror_search_adapter.js::resolveAurorToken` | ✅ **Live** — survives SW cold wake |
| 3 | Auror name search | AurorBuddy `lib/auror.js::searchPeople` (we call with `searchString` + no `siteTraits`) | ⚠️ **Live with known limitation** — see "Typo'd records" below |
| 4 | Match scoring (fuzzy last name + first name + DOB) | LicenseIntake `auror_search_adapter.js::scoreAurorPersonMatch` | ✅ **Live** — Levenshtein ≤2 for last name; precision filter requires both first AND last signals |
| 5 | Auror preflight (warm auth, open SSO tab) | AurorBuddy `service.js::preflight` (direct in-SW call) | ✅ **Live** — invoked as fallback during JWT cold-read |
| 6 | APPRISS Secure session probe + lookup | AurorBuddy `lib/appriss.js::apprissLookupAll` via `aurorbuddy::appriss_lookup` handler (direct in-SW call) | ✅ **Live** — auth wall surfaces as `needs_manual` |
| 7 | APPRISS card + transaction normalization | LicenseIntake `card_lookup_adapter.js::normalizeApprissResult` (reads `appriss_cards[].transactions[]`) | ✅ **Live** — card-only rows surface even when no transactions at homeStore |
| 8 | Auror person CREATE (form prefill, NOT submit) | AurorBuddy `lib/auror_event.js::fillAurorEvent` via `aurorbuddy::create_event` handler | ⚠️ **Confirmation-gated** — opens `/event/new` pre-filled; operator submits manually |
| 9 | Auror evidence download (CCTV + receipt) | AurorBuddy `lib/evidence_downloader.js::downloadEvidence` via `aurorbuddy::download_evidence` handler | ✅ **Live** — per-transaction "Download evidence" button in the card list |
| 10 | License barcode parse (AAMVA PDF417) | LicenseIntake `lib/license_parser.js` (byte-walk known-tag whitelist) | ✅ **Live** — 8/8 fixture tests passing |
| 11 | Scanner input — focus-only capture with Tab/Alt/Enter absorption | LicenseIntake `view.js` + `content/auror_inline.js` | ✅ **Live** — same pattern in both side-panel + Auror-page overlay |
| 12 | Inline "Scan License" button on Auror | LicenseIntake `content/auror_inline.js` (inline next to search input + floater fallback) | ✅ **Live** — click → overlay → scan → controller → navigate to top match |
| 13 | Workflow orchestration | LicenseIntake `lib/licenseIntakeController.js::runFullWorkflow` | ✅ **Live** — single entry point for parse → search → stage → APPRISS → save |
| 14 | Local session persistence (redacted) | LicenseIntake `intake_storage.js` via `shared/storage.js::createStorage("licenseintake")` | ✅ **Live** — `chrome.storage.local` only, never `sync`, no raw payload |
| 15 | PII redaction in logs | LicenseIntake `redaction.js::LOG_FORBIDDEN_KEYS_RE` + `host.logging.extendForbiddenKeys()` at register | ✅ **Live** — applies to all `host.logging.emit` calls |

## What's live, what's dry-run, what's confirmation-gated

| Action | Default | Live behavior |
|---|---|---|
| Parse barcode | Always live | Pure local; safe |
| Save IntakeSession | Always live | `chrome.storage.local` only |
| Auror name search (GET) | DRY_RUN by default | Toggle OFF → real `SearchApi/searchPeople` call |
| APPRISS lookup | DRY_RUN by default | Toggle OFF + `confirmed: true` → real `aurorbuddy::appriss_lookup` chain |
| Download CCTV evidence | Live per button click | No additional confirmation — saves to Downloads |
| Open Auror `/event/new` pre-filled | Always confirmation-gated | `window.confirm()` before opening tab; operator submits manually in opened tab |
| Auror person SUBMIT | **Never autonomous** | Always operator click in the opened tab |

## Typo'd records — known limitation

The `SearchApi/searchPeople?searchString=<query>` endpoint Auror exposes
tokenizes the query and matches records whose indexed name fields
contain **any** token literally. Records with typos in those indexed
fields (e.g. license "Duckworth" vs Auror "Duckwortth") don't match
the exact-name query.

**Today's mitigation** (in `auror_search_adapter.js`):

- Send two queries: `"First Last"` + `"First"` alone
- Combine, dedup by P-number
- Score with Levenshtein ≤2 on last name (catches 1-character typos)
- Require BOTH a first-name signal AND a last-name signal (precision filter)
- Sort by score, show top 5

For Bryson Duckworth → Bryson R Duckwortth case this surfaces him at
~67%. For records with typos in the first name OR with multi-character
typos in the last name, the API still won't return him.

**Next step (one open item):** capture the actual XHR Auror's UI fires
when the operator types in the global search bar. That endpoint
clearly does fuzzy matching server-side (the user confirmed it returns
"Bryson R Duckwortth" for the query "Bryson Duckworth"). One DevTools
Network capture replaces `SEARCH_PEOPLE_URL` in
`auror_search_adapter.js` and removes the limitation entirely.

## What requires operator action

1. **Set the APPRISS store** in the status bar before running card
   lookup. The Auror search is global and ignores it; APPRISS uses
   it to scope transactions.
2. **Open Auror in a tab and sign in** before live calls, so the JWT
   gets captured. Cold-read fallback uses AurorBuddy's preflight,
   which can open the SSO tab automatically — but operator may need
   to complete the SSO prompt the first time.
3. **Open APPRISS Secure in a tab and sign in** before live card lookup
   for the same reason.
4. **Click Submit** in the Auror `/event/new` tab after the form is
   pre-filled. The extension NEVER auto-submits.

## What's intentionally NOT live yet

- Auror person CREATE submit (and never will be without an explicit
  operator-confirmation flow per `docs/LICENSE_INTAKE_PII_HANDLING.md`)
- Auror evidence file upload (the AurorImport project has saved
  PNG images; attaching them to an Auror case requires reverse-engineering
  the evidence-upload endpoint — V2 work, documented in
  `LICENSE_INTAKE_AUROR_PAGE_INTEGRATION.md`)
- Cloud OCR or any third-party PII service (forbidden by master
  `docs/PII_HANDLING.md`)

## Exact next step

Capture the Auror UI's actual search endpoint (one DevTools network
capture, ~30 seconds of operator time). Once we have the URL pattern
+ response shape, swap `SEARCH_PEOPLE_URL` and adjust
`normalizeFromSearchApi` accordingly — typo'd records will surface and
the precision filter / fuzzy scoring become belt-and-suspenders rather
than load-bearing.

Beyond that, the V2 backlog lives in `LICENSE_INTAKE_NEXT_STEPS.md`.
