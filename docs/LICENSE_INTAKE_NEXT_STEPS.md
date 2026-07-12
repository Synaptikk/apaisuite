# LicenseIntake — Next steps

The overnight build completed the V1 scope. This doc lists the
follow-up items in priority order so future work doesn't have to
re-derive what's missing.

---

## Immediate (within the next session)

### 1. Verify live Auror search wire-up

The adapter targets `personIdentitySearch?searchString=<last + first>`,
mirroring AurorBuddy's P-number resolution call. **Verified shape:**
P-number input. **Unverified shape:** arbitrary name string input.

**Action:** With AurorBuddy authenticated, run one live search with
`dryRun: false` and a fake name (no candidates expected). Confirm:

- HTTP 200 (or empty results, not 4xx)
- Response is JSON we can parse via `normalizeAurorPersonResult`
- No PII appears in the SW console

If the endpoint rejects non-P-number queries with 400, find the
correct Auror search endpoint (DevTools Network on a live Auror search)
and update `auror_search_adapter.js::fetchPersonIdentitySearch`. The
adapter is the only place to change.

### 2. Verify AurorBuddy cross-module messaging actually routes

`messaging.send("appriss_lookup", payload, { module: "aurorbuddy" })`
relies on the suite SW dispatcher routing by `(module, type)`. The
dispatcher implementation is in `background/service_worker.js` —
**confirm it accepts the `module` field in the outgoing message** and
forwards to the correct handler. If not, we may need
`chrome.runtime.sendMessage({ module, type, payload })` directly.

### 3. Smoke test the AurorBuddy `create_event` handoff payload shape

AurorBuddy's `create_event` was built for a real transaction. We're
synthesizing a transaction-shaped payload from a license-only intake.
**One dry-run handoff** should reveal whether `driveForm` chokes on
the synthetic transaction (especially `lineItems: []`). If it does,
either AurorBuddy needs a "license-only pre-fill" mode, or we build
our own minimal `driveForm` for the person-search field only.

---

## Short-term (next 1–2 weeks)

### 4. Auror evidence file attach

Currently the license image (captured by the legacy AurorImport
extension's camera module) is saved to Downloads. To attach it to an
Auror case automatically:

- Capture the Auror evidence-upload XHR on a manual upload to find the
  endpoint shape (POST multipart to `/api/spa/Event/<id>/attachments`
  is the working hypothesis).
- Add `attach_license_image(sessionId, blob)` handler to
  `service.js`, confirmation-gated.
- UI gains an "Attach image to selected Auror case" button.

This is the cleanest bridge between the AurorImport extension and
LicenseIntake.

### 5. Merge AurorImport into APAISuite as a sibling module

The AurorImport extension at `C:\Users\ses008s.s01458\Desktop\AurorImport`
is currently standalone. It has:
- Working scanner integration (HID + focus-only capture)
- Working camera capture with manual crop
- Working PII redaction rules

Plan: import as `modules/licensecapture/` (image-capture-focused) and
have it call `messaging.send("create_session", { person })` to
`licenseintake` directly. Two modules, one workflow, one extension.

Files to migrate (greenfield rewrite, not literal copy):
- `extension/modules/LicenseCapture/scanner.js` → `modules/licensecapture/lib/scanner.js` (focus-only doc-keydown capture)
- `extension/modules/LicenseCapture/camera.js` → `modules/licensecapture/lib/camera.js`
- `extension/modules/LicenseCapture/imageProcessing.js` → `modules/licensecapture/lib/imageProcessing.js` (pure-JS detection)
- `extension/modules/LicenseCapture/ocr.js` → DROPPED (front OCR proved unreliable; scanner replaces it)
- The AAMVA parser is already migrated into `licenseintake/lib/license_parser.js` — `licensecapture` would defer to it.

### 6. Page-injection inline button on Auror

Documented in `LICENSE_INTAKE_AUROR_PAGE_INTEGRATION.md`. Adds an
"Import DL" pill to the Auror header that opens the LicenseIntake
panel pre-armed and remembers the source Auror tab for push-back.

---

## Medium-term

### 7. Auror match scoring improvements

`scoreAurorPersonMatch` currently does:
- Last name exact (0.4) / partial (0.25)
- First name exact (0.3) / initial (0.1)
- DOB exact (0.3)

Improvements with diminishing return:
- License-number match if Auror surfaces it on a candidate (0.4+)
- Address partial match (0.1)
- "Recent event" recency bonus (0.05 if within 90 days)
- Phonetic name match (Metaphone / Soundex) for typos

Import `aurorbuddy/lib/appriss_names.js::firstNameCandidates` for
nickname/alias handling.

### 8. Multi-state AAMVA extension support

The parser currently knows the standard D-prefix tags plus Georgia's
ZG extensions (which we hit live during scanner setup). Other states
have similar Z extensions. Pattern is harmless to add — just append
to `KNOWN_TAGS`.

States to add when sample scans appear: Texas (ZT), Florida (ZF),
California (ZC).

### 9. Settings UI

`settings` storage holds `dryRun`, `autoSearchOnParse`,
`defaultHomeStore`. Only `dryRun` is wired into the UI. Add:

- `autoSearchOnParse` checkbox — auto-fires Auror search after a parse
- `defaultHomeStore` text field — used as the `homeStore` argument to
  `card_lookup` when one isn't passed explicitly

### 10. Bulk reconciliation view

Operators may want to scan a stack of licenses, then review them all
at once instead of one-by-one. The session-list panel is already
present; add filters (`status=needs_review`, etc.) and a "select multiple
→ batch search Auror" action.

---

## Longer-term / out of scope V1

- Live person CREATE submit (currently always manual in the opened tab)
- Card-swipe input (if MSR readers ever come into the workflow)
- License OCR fallback when no scanner is available (already prototyped in AurorImport but unreliable; deferred)
- Cross-store activity heatmap when multiple sessions exist for one Auror person
- Export to CSV (per-shift summary) — would need a fresh PII review

---

## Architectural debts to track

- The `auror.jwt` capture sharing between AurorBuddy and LicenseIntake works but is fragile (see `LICENSE_INTAKE_AURORBUDDY_REUSE.md` for what breaks if AurorBuddy is renamed/removed). Consider a registry-level "shared captures" abstraction in `shared/auth.js` so any module can declare a capture and any other module can read it without naming the owner.
- The `card_lookup_adapter.js` synthetic suspect-list shim depends on AurorBuddy's `appriss_lookup` accepting partial suspect shapes. If AurorBuddy ever validates the input strictly, our shim breaks. Adding a contract test on the AurorBuddy side would catch this early.
- `auror_person_draft_adapter.js::handoffToAurorBuddyCreate` synthesizes a transaction payload — but `create_event` was designed for real transactions. A dedicated `create_event_from_license` handler in AurorBuddy would be cleaner.

These are the "if we had two more days" items. Not blocking.
