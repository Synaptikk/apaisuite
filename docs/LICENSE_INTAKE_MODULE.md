# License Intake module

APAISuite module for AP investigators: scan a driver's license with a
USB barcode scanner, extract structured data from the AAMVA PDF417
barcode, search Auror for an existing person record, cross-reference
APPRISS Secure for card/transaction activity, and stage a review for
operator action.

**Default mode: DRY_RUN.** No live Auror / APPRISS calls fire until the
operator unchecks the dry-run toggle AND clicks through the per-action
confirmation gate.

---

## V1 capabilities

| Capability | Status | Notes |
|---|---|---|
| Parse PDF417 AAMVA payload from a USB barcode scanner (HID keyboard wedge mode) | ✅ Live | Byte-by-byte tag walk avoids the "DESOTA → DES" address-text trap |
| Scanner input panel with focus-only capture | ✅ Live | Click textarea → scanner output captures there; click elsewhere → scanner output goes elsewhere |
| Redacted preview of scanned person | ✅ Live | Default UI shows masked DOB / last-4 DL# / "address present"; operator must expand for full fields |
| Persistent intake sessions in `chrome.storage.local` | ✅ Live | Namespaced under `licenseintake.sessions` |
| Auror person search (dry-run) | ✅ Live | Returns synthetic candidates for UI testing |
| Auror person search (live) | ⚠️ Gated | Hits `personIdentitySearch`; requires AurorBuddy-captured JWT, dry-run unchecked, no per-call confirmation needed (read-only) |
| Match scoring (last name + first name + DOB) | ✅ Live | Classes: STRONG / POSSIBLE / MULTIPLE_POSSIBLE / NO_MATCH / ERROR |
| Create-person draft staging when no match found | ✅ Live | Draft built locally; nothing submitted |
| Hand off draft to AurorBuddy `create_event` | ⚠️ Gated | Requires `confirmed: true` + dry-run unchecked. Opens `/event/new` in a new tab pre-filled. **Submit is always the operator's manual action in the opened tab.** |
| Copy draft to clipboard | ✅ Live | Always confirmation-gated (`confirmed: true`) |
| APPRISS card/transaction lookup | ⚠️ Gated | Cross-module messaging to `aurorbuddy::appriss_lookup`; requires live APPRISS Secure session in another tab |
| Mark session completed / dismissed | ✅ Live | Operator decision; no external effect |

## What V1 does NOT do (explicitly deferred)

- Direct page injection into Auror tabs (inline "Import DL" button on the Auror header) — see `LICENSE_INTAKE_AUROR_PAGE_INTEGRATION.md`.
- Auror evidence file upload (attach the saved license image to the case) — also deferred, doc above.
- Live Auror person CREATE submission — never autonomously; always operator click in the opened `/event/new` tab.
- Cloud OCR or any third-party PII processor — forbidden by `LICENSE_INTAKE_PII_HANDLING.md`.

## Files

```
modules/licenseintake/
  module.js                                  manifest (id, accent, permissions, register())
  service.js                                 SW handlers: parse, search_auror, card_lookup, handoff, ...
  view.html / view.js / styles.css           full-page UI
  lib/
    license_parser.js                        AAMVA byte-walk + LicensePerson model
    intake_models.js                         IntakeSession + ReviewStatus + MATCH_CLASS + CARD_LOOKUP_CLASS
    intake_storage.js                        chrome.storage.local wrapper (namespaced via shared/storage.js)
    redaction.js                             mask/expand helpers + LOG_FORBIDDEN_KEYS_RE
    auror_search_adapter.js                  personIdentitySearch + scoring + dry-run
    auror_person_draft_adapter.js            clipboard + AurorBuddy create_event handoff (gated)
    card_lookup_adapter.js                   AurorBuddy appriss_lookup handoff (gated)
  test/fixtures/fakeLicensePayloads.js       SYNTHETIC AAMVA only — never real PII
  dev/testLicenseParser.html                 manual test harness (browser-loadable)
```

## Reused APAISuite / AurorBuddy primitives

- `shared/storage.js::createStorage("licenseintake")` — namespaced local storage
- `shared/messaging.js::createMessaging("licenseintake")` — `.send(type, payload, { module })` cross-module routing
- `shared/auth.js::createAuth("aurorbuddy").getCapturedHeader("auror.jwt", ...)` — share AurorBuddy's JWT capture (no second `webRequestFilters` declaration needed)
- `shared/logging.js` — `host.logging.extendForbiddenKeys(LOG_FORBIDDEN_KEYS_RE)` in `register()` to auto-redact our PII keys
- AurorBuddy `appriss_lookup` handler — invoked via `messaging.send("appriss_lookup", { suspects, homeStore }, { module: "aurorbuddy" })`
- AurorBuddy `create_event` handler — invoked via `messaging.send("create_event", { ... }, { module: "aurorbuddy" })`

## How to test (no real PII required)

1. Load the suite as an unpacked extension in `edge://extensions`.
2. Open the side panel / app page → **License Intake** in the sidebar.
3. Toggle **Dry-run** ON (default). Type or paste a synthetic AAMVA payload
   into the scanner box, OR use one from `test/fixtures/fakeLicensePayloads.js`.
4. Walk the flow: Parse → Search Auror (dry-run synthesizes candidates) →
   review match list → either select a candidate or work the draft section.
5. Run APPRISS lookup (dry-run synthesizes 2 candidates) → review.
6. Mark completed / dismissed / delete.

For deeper parser assertions, navigate to
`chrome-extension://<extensionId>/modules/licenseintake/dev/testLicenseParser.html`
— self-running browser harness with green/red pass/fail.

## How to go live (one piece at a time)

1. Verify AurorBuddy is mounted + has a fresh Auror JWT (open `app.us.auror.co` in a tab; sign in via SSO; AurorBuddy's `webRequestFilters` captures the bearer).
2. Switch off **Dry-run** in the status bar.
3. Run **Search Auror** — should hit `personIdentitySearch` live. If "no auror jwt captured" appears, the JWT TTL expired or AurorBuddy hasn't seen a request yet. Hit any Auror page to refresh.
4. For **Run APPRISS lookup**: also need APPRISS Secure open in a tab and signed in. The cross-module call to AurorBuddy surfaces auth-wall errors as `status: "needs_manual"`.
5. For **Hand off to AurorBuddy → /event/new**: confirms via `window.confirm` then sends the payload. AurorBuddy opens the tab and pre-fills; **operator submits manually**.

## Going live failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| `no auror jwt captured` | AurorBuddy not loaded or `auror.jwt` storage key TTL expired | Open any `app.us.auror.co` URL; the webRequest listener re-captures |
| `appriss auth wall` | APPRISS session expired | Open APPRISS Secure in a tab, sign in, retry |
| Handoff "ok" but no tab opens | AurorBuddy `create_event` handler rejected | Check the suite SW console for AurorBuddy errors |
| Draft preview shows "?" for first/last name | Parser found incomplete AAMVA — name field codes missing | Try the scan again; some scanner profiles strip the `DAC` line |

See `LICENSE_INTAKE_AURORBUDDY_REUSE.md` for the cross-module contract details and `LICENSE_INTAKE_NEXT_STEPS.md` for what's planned beyond V1.
