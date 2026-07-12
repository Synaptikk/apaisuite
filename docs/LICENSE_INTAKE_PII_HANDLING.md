# License Intake — PII handling

Driver's license data is the most sensitive PII this suite handles.
This document captures the operating rules the LicenseIntake module
follows and the audit checks reviewers should run before any release.

> This is a module-specific supplement. APAISuite's global rules
> (`shared/logging.js::sanitize()` regex) apply on top. We extend that
> regex in `register()`; see "Forbidden keys" below.

---

## What we treat as PII

Any of these, individually:

- Full name (first, middle, last, full)
- Date of birth (any precision finer than decade)
- License number (or any digits past the last 4)
- Address (street, street2, city, state, postal)
- Sex, height, weight, eye color, hair color
- Issuing-state code (in combination with other fields)
- The raw barcode payload (which encodes ALL of the above)
- Cardholder surname or masked-PAN tied to a person
- Auror `pNumber`, `identityGroupId`, or `displayName` once tied to a
  scanned license person

## Hard rules

1. **No raw payload leaves the parser.** `parseLicensePayload(raw)` is
   the only function that touches the raw input. It never returns it.
   `LicensePerson.redactedPreview` is the only safe-to-log derivative.
2. **No console.log of field values.** `console.info` / `console.warn`
   call sites in this module log only counts, status enums, lengths,
   `sessionId` (opaque), and warning categories.
3. **No `chrome.storage.sync`.** Session data lives in
   `chrome.storage.local` only (BitLocker-protected, never cloud-synced).
4. **No third-party services.** No cloud OCR, no external SaaS lookups.
   APPRISS and Auror are inside the Walmart data perimeter.
5. **Default-collapsed UI for sensitive fields.** The parsed-person
   panel shows `redactedPreview` plus a `<details>` toggle the operator
   must expand to see DOB / DL# / address.
6. **No auto-submit to Auror.** `auror_person_draft_adapter.js`
   requires `confirmed: true`; `card_lookup_adapter.js` requires
   `confirmed: true` for live calls.
7. **Operator language only.** Status text uses "possible match",
   "review candidate", "transaction candidate" — never "suspect" or
   any accusatory framing.

## Where PII can briefly exist in memory

| Surface | What it holds | Lifetime | Cleared by |
|---|---|---|---|
| Scanner `<textarea>` | Raw payload | Until parse fires + Clear button | `Clear` button OR `clear_all_sessions` |
| `LicensePerson` in JS closure | Parsed fields | Until session is deleted | `delete_session` / `clear_all_sessions` |
| `IntakeSession` in `chrome.storage.local` | Parsed fields + matches + draft | Until operator deletes | `delete_session` / `clear_all_sessions` |
| Cross-module messaging payload | Same fields, in transit to AurorBuddy | Single SW round-trip | Discarded after handler returns |
| Auror tab opened by handoff | Pre-filled form fields | Until tab closes | Operator closes |

## Where PII MUST NOT exist

- `chrome.storage.sync` — would replicate to other devices
- Any `host.logging.emit()` call without redaction
- Any `console.log` call line — including in error handlers
- Any committed test fixture (use `test/fixtures/fakeLicensePayloads.js`'s synthetic data only)
- The raw payload field of any persisted session record
- Any non-redacted screenshot in `docs/`, PR descriptions, or chat tools

## Forbidden keys (shared logger extension)

`module.js::register()` calls
`host.logging.extendForbiddenKeys(LOG_FORBIDDEN_KEYS_RE)`. The regex
matches:

```
licensenumber | dlnumber | dateofbirth | dob | middlename |
address\d | addressstreet | addresscity | addresspostal |
expirationdate | rawpayload | raw | sex | height | weight |
eyecolor | haircolor
```

`shared/logging.js::sanitize()` already matches `firstname`,
`lastname`, `email`, `address`, `phonenumber`, etc. — anything
remaining is our responsibility.

## Redaction helpers (`lib/redaction.js`)

- `maskLicenseNumber(dl)` → `"*******1234"`
- `maskDob(dob)` → `"1985-**-**"`
- `maskDobToDecade(dob)` → `"1980s"` (use this on log paths)
- `maskAddress(addr)` → `"1XXX MXXX SX AXX X"` (rarely needed)
- `redactAddress(addr)` → `"[address present]"` (preferred for logs)
- `buildRedactedPreview(licensePerson)` → one-liner safe for display + log
- `redactForLog(obj)` → deep walk, replaces PII-key values with `[REDACTED]`

## Audit checklist (run before any release)

- [ ] `grep -nE "console\.(log|info|warn|error)" modules/licenseintake/` — every match is logging counts/statuses/redacted-preview only
- [ ] DevTools Network panel during full flow: requests go ONLY to `app.us.auror.co` (search) and `wmtus.apprissretailcloud.com` (lookup, via AurorBuddy)
- [ ] `dev/testLicenseParser.html` — "no fixture names / DLs / full DOBs appear in console output" assertion is GREEN
- [ ] `chrome.storage.sync.get(null)` after a full flow returns no `licenseintake.*` keys
- [ ] `chrome.storage.local.get(null)` after `clearAllSessions` returns no `licenseintake.sessions` data
- [ ] No screenshots in `docs/` or PR descriptions contain a real license
- [ ] `.gitignore` excludes the AurorImport project's capture filename patterns (`*.license.png`, `*.scan.png`)

## Incident response

If a leak is suspected:

1. Stop the affected output channel immediately. Don't keep logging.
2. Delete the offending artifact (local disk + any sync history).
3. Report to Walmart Information Security same business day. Do not
   wait to "see if anyone noticed."
4. Fix the code path. Add a regression assertion in
   `dev/testLicenseParser.html` (the harness already asserts no
   fixture strings appear in `console.*` output — extend with new
   forbidden strings if needed).

Mirrors the rules in the AurorImport project's
`docs/PII_HANDLING.md`. When that project becomes a sibling module in
APAISuite (planned), the two PII docs collapse into one.
