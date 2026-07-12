# LicenseIntake — AurorBuddy reuse contract

LicenseIntake leans on AurorBuddy for three things rather than
re-implementing them. This doc spells out the contract so changes to
AurorBuddy don't silently break LicenseIntake (or vice versa).

---

## 1. Shared `auror.jwt` capture

**Why share:** Auror only issues one bearer token per session. Both
modules need it. Having both modules declare `webRequestFilters` for
the same header is legal but adds a second listener and second
`chrome.storage.session` write per Auror navigation — wasteful and
makes debugging "which listener captured this?" harder.

**How it works today:**

- AurorBuddy's `module.js` declares the only `auror.co` webRequestFilter
  with `storageKey: "auror.jwt"`. The shell SW reads this list at boot
  and registers the listener.
- LicenseIntake's `module.js` declares an empty `webRequestFilters: []`.
- LicenseIntake's `auror_search_adapter.js` reads via:
  ```js
  const _aurorAuth = createAuth("aurorbuddy");
  const _jwtReader = _aurorAuth.getCapturedHeader("auror.jwt", 20 * 60 * 1000);
  ```
  Note: `createAuth("aurorbuddy")` — we deliberately read from
  AurorBuddy's namespace. This works because `getCapturedHeader` looks
  up `chrome.storage.session.aurorbuddy.auror.jwt`.

**Failure modes:**

- If AurorBuddy is removed from `_registry.js`, the webRequest listener
  isn't registered → LicenseIntake gets `null` on every JWT read →
  every live search returns `"no auror jwt captured"`. Fix: re-add
  AurorBuddy OR move the filter declaration to LicenseIntake's `module.js`.
- If AurorBuddy changes the `storageKey` from `"auror.jwt"`, LicenseIntake
  reads the wrong key. Mitigation: this string appears in both
  `aurorbuddy/module.js` and `licenseintake/lib/auror_search_adapter.js`
  with the same TTL. **If you change it in one, change it in both.**

## 2. `aurorbuddy::appriss_lookup` cross-module call

**Why cross-module:** APPRISS Secure uses cookie-based auth (not
header-based). The only safe way to talk to APPRISS is from a SW
context where the user's signed-in cookies are live. AurorBuddy
already owns this — `lib/appriss_http.js` handles retries, rate-limits,
auth-wall detection. Duplicating it in LicenseIntake means two places
to maintain.

**Contract:**

```js
const resp = await host.messaging.send("appriss_lookup", {
  suspects: [{
    person_id: null,
    name: "Last First",
    first_name: "First",
    last_name: "Last",
    event_count: 0,
    total_value: 0,
    auror_url: null,
    photo_url: null,
    threatening: false,
    is_orc: false,
  }],
  homeStore: "1234",
  _source: "licenseintake",
}, { module: "aurorbuddy" });
```

`suspects` MUST be an array (even for a single person) — AurorBuddy's
handler is built for the multi-suspect scan_auror output. The shape
fields are a subset of what `scan_auror` produces; passing extras is
harmless.

**Response shape (best-effort):**

```js
{
  ok: true,
  data: {
    suspects: [
      {
        ...input suspect...,
        apprissData: {
          cards:        [...],
          transactions: [...],
          // possibly other keys
        },
      },
    ],
  },
}
```

LicenseIntake's `card_lookup_adapter.js::normalizeApprissResult()`
defends against shape drift — it accepts `transactions` or
`transactionList`, `cards` or `cardList`. If AurorBuddy gains a new
field on the inner result, our adapter ignores it silently. New
top-level shape changes would break us — add a contract test on the
AurorBuddy side that pins the response shape.

**Auth-wall handling:** When APPRISS rejects with an HTML sign-in
page, AurorBuddy returns an error containing `"auth wall"` or
`"session"`. Our adapter detects that string and returns
`status: "needs_manual"` with a hint message — the UI tells the
operator to open APPRISS Secure in a tab.

## 3. `aurorbuddy::create_event` cross-module call

**Why cross-module:** AurorBuddy's `driveForm` (in
`lib/auror_event.js`) is a careful React-aware DOM filler that targets
the Auror `/event/new` form. It uses `setReactValue` to fool React's
controlled inputs into accepting our values. Re-implementing this in
LicenseIntake would mean two places that break when Auror's form
changes.

**Contract:**

```js
const resp = await host.messaging.send("create_event", {
  store: "1234",                  // homeStore number
  transaction: {
    id: null,
    date: "2026-06-05",
    amount: null,
    lineItems: [],
    personDob:           "1985-03-15",
    personLicenseNumber: "GA999...",
    personAddress:       "9999 ...",
    personCity:          "Atlanta",
    personState:         "GA",
    personPostal:        "30303",
  },
  suspectName: "First Last",
  personId: null,
  storeDetails: null,
  _source: "licenseintake",
}, { module: "aurorbuddy" });
```

AurorBuddy treats absent fields as "leave blank on the form" — passing
nulls is safe. The `_source: "licenseintake"` field is a marker for
log triage; AurorBuddy ignores it functionally.

**Behavior:** Opens a new tab at `/event/new`, waits for the React
form to mount, runs `driveForm` with our payload. **Does not submit.**
The operator submits manually after reviewing.

**Failure modes:**

- If AurorBuddy's `transaction.*` field names change (e.g. `personDob` →
  `dateOfBirth`), our handoff will silently fill the wrong field or
  none at all. Mitigation: this is documented here AND in the handoff
  adapter file. Periodic smoke test in dry-run mode would catch it.
- If the Auror form's React selectors change, AurorBuddy's `driveForm`
  is what breaks. Not our problem to fix, but our handoff returns the
  error verbatim.

## 4. Things we explicitly do NOT reuse from AurorBuddy

- `searchPeople` (in `lib/auror.js`) — store-scoped scan, not name search. We hit `personIdentitySearch` directly with our own fetch wrapper. Reason: name search needs different inputs/outputs.
- `lib/auror_event.js::driveForm` source — we invoke the wrapped handler, not the function directly. Reason: it runs in page-MAIN-world via `chrome.scripting.executeScript`; cross-module function imports would just confuse it.
- `lib/appriss_names.js` (`surnameIsLastToken`, `firstNameCandidates`) — currently we do simpler last-name exact comparisons in `card_lookup_adapter.js::scoreTransactionCandidate`. Future enhancement: import these for richer scoring (they're pure functions, importable from sibling).

## 5. Versioning contract

| Change in AurorBuddy | What breaks in LicenseIntake | Mitigation |
|---|---|---|
| Rename `auror.jwt` storage key | Live Auror search returns "no jwt" | Update key string in `auror_search_adapter.js` |
| Change `appriss_lookup` response shape (`apprissData` → `apprissResult`) | `normalizeApprissResult` returns no candidates | Add new shape arm to `normalizeApprissResult` |
| Add a required field to `create_event` payload | Handoff fails AurorBuddy validation | Add field to `auror_person_draft_adapter.js::handoffToAurorBuddyCreate` payload |
| Remove `appriss_lookup` or `create_event` handler entirely | Card lookup / handoff break | Re-implement locally OR coordinate with AurorBuddy maintainer |
| Remove AurorBuddy from `_registry.js` | Both above plus loss of JWT capture | Move JWT capture filter into our own `module.js::webRequestFilters` |

When changing AurorBuddy in any of those ways, search the codebase for
`"aurorbuddy"` and `"auror.jwt"` to find every cross-module caller —
LicenseIntake is the first but won't be the last.
