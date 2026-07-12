# Security Notes

Auth, session, and sensitive-data handling rules for the Live Dashboard
module. These rules apply to every source pull, every cache, every log
emission, and every probe script.

**Last reviewed:** 2026-06-02.

---

## Core principles

1. **Browser owns auth. The extension never does.** All sources are
   reached using the user's existing browser session (cookies established
   by normal SSO flows). The extension never collects, stores, or replays
   passwords, MFA codes, or SSO redirect tokens.

2. **Cookie values are opaque.** The extension reads cookie *presence*
   (via `chrome.cookies.getAll`) to decide whether the user has a session,
   but never logs, exports, or sends cookie values anywhere. The
   `host.auth.hasSessionCookie(domain, ...)` helper is the only intended
   surface — it returns boolean.

3. **Header capture is name-not-value.** When the suite captures headers
   via `webRequestFilters`, the *value* is held in
   `chrome.storage.session` (process-local, dies with browser) and is read
   only by the module that owns the filter. The value is never written to
   `chrome.storage.local` (which persists to disk) and never written to
   the log ring (`shared/logging.js`).

4. **Logs are sanitized.** Anything entering
   `shared/logging.js::emit()` or `console.{log,warn,error}` must pass
   through a redactor for the suspected-token patterns.

5. **No exfiltration.** The Live Dashboard module does not POST any
   captured data to any external service. The only network destinations
   are Walmart-internal data sources (read) and the QRCallBox update
   endpoint (separate, owned by the suite's updater, no per-module data).

---

## What never to log

The redactor must scrub these patterns before write:

| Pattern | Where it shows up |
|---|---|
| `Bearer ey...` | Power BI access tokens, JWTs |
| `eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+` | Any JWT |
| Cookie header values (after `Cookie:`) | request header dumps |
| `Set-Cookie:` header values | response header dumps |
| `Authorization:` header values | request header dumps |
| `X-API-Key`, `X-Tenant-Token`, `X-CSRF-Token` values | request headers |
| URL params named `token`, `access_token`, `code`, `state` | query-string dumps |
| ViewState postback blobs (`__VIEWSTATE`, `__EVENTVALIDATION`) | IVR debug output — already opaque but redact for log size, not security |
| Operator personal names (when `R5/R6` fire) | finding render — see "personal data" below |

Implement once in `lib/sources/redact.js`. Every source-level pull and
every diagnostic write goes through it.

---

## What is safe to log

- Endpoint URL (path + query, with sensitive params stripped)
- HTTP status code
- Response timing
- Header *names* (without values)
- Row counts, payload byte sizes
- Schema validation outcomes
- Source freshness (`lastSuccess`, `lastError`)

---

## Personal data handling (R5/R6 operator rules)

The register-discrepancy analysis can name people. The rules below apply
the moment operator data enters the dashboard.

1. **Operator IDs only by default.** UI shows `operatorId` (an opaque
   employee number). Names are stored in the record but hidden behind a
   tooltip or "show name" toggle. Default state is hidden.

2. **No bulk export of operator data without confirmation.** Per-finding
   export is fine. CSV/PDF export of a list of findings filtered by
   operator must prompt the user with a confirm dialog naming the
   operator(s) involved.

3. **Dismissed findings persist locally only.** The
   `dismissedFindings` array in `chrome.storage.sync` syncs across the
   user's own devices but never leaves Walmart-managed Chrome profiles.
   No findings sync to QRCallBox or any external service.

4. **Operator metrics never aggregate to a report shared outside AP.**
   This is a usage policy, not a technical control — but the dashboard
   should not have a "share this view" button.

---

## Origin-specific notes

### IVR ATT Cloud (Source A)

- Same-origin scrape via existing content script. No cookies touched
  directly by livedashboard.
- The IVR page contains associate names and call-off reasons. Treat
  outputs as personal data — same handling as operator rules above.

### Enviance (Source B)

- New origin, new cookie scope. The user must SSO into Enviance once via
  normal browser. After that, `credentials: "include"` from SW should
  carry the session. **Do not auto-authenticate the user.**
- Compliance task names are not personal data. `assignedGroups` may
  include group names (not person names) — safe to log/render normally.

### one.walmart.com (Source C)

- Same SAML SSO surface as gscope/Hoops. No new credential dance.
- Claimant names ARE personal data. Treat per operator rules.
- Reference numbers, tracking numbers are internal IDs — safe to render
  but don't paste into external systems.

### Hoops / api.hoops.wal-mart.com (Source D)

- See `dev/HOOPS_FINDINGS.md`. Cookies scoped to `.wal-mart.com`.
- CVP fields are aggregate metrics by store. No personal data.

### Power BI (Source E)

- Power BI's session uses BOTH cookies AND a tenant-scoped access
  token in the `Authorization: Bearer ...` header.
- **The bearer token is sensitive.** It must never enter
  `chrome.storage.local`, never go to a log, never be sent off-device.
  The MAIN-world content script captures it as part of the request
  envelope, but the SW only ever uses it to *replay* the same query —
  never to construct new queries against arbitrary endpoints.
- When the SW replays the captured request, the bearer is passed
  through the `Authorization` header of the new fetch. Capture-and-
  replay is the entire pattern; no decoding or storage of the bearer is
  ever needed.
- For the V1 XLSX import path, no token is involved — the user exports
  the file from Power BI's UI, drops it into the dashboard, and the
  parser reads bytes. This path is meaningfully lower risk than the
  V1.5 automated capture.

---

## Probe-script hygiene

When running probe scripts (`dev/probe-*.mjs` or similar):

1. **Save captures to .gitignored paths.** `dev/*.json` is already
   `.gitignore`d as a convention (verify before adding new captures).
2. **Strip cookies and Authorization headers from captures BEFORE
   committing or sharing.** Hand-edit the JSON before saving the finding
   doc.
3. **Findings docs (`dev/*_FINDINGS.md`) MUST NOT include header
   values.** Pattern from `dev/HOOPS_FINDINGS.md` is correct: name the
   auth mode ("session cookies on `.wal-mart.com`"), do not paste the
   cookie.
4. **Screenshots: blur or crop the URL bar and any browser-managed
   credential UI before saving.** The IVR cluster sometimes echoes
   session IDs in URLs after redirects.

---

## What to do if a secret leaks into a log/cache

1. Wipe immediately: `chrome.storage.local.clear()` is a blunt but
   effective recovery; the dashboard's caches are all re-derivable from
   live pulls.
2. Wipe the in-memory captured-headers map (`shared/captured_headers.js`
   has `clearCapturedHeader(fullKey)`).
3. Wipe session storage: `chrome.storage.session.clear()`.
4. The user should re-authenticate in the affected origin to invalidate
   any leaked session token from the source side.
5. Patch the redactor to catch the leaked pattern.

---

## Authorization-of-action principle

The Live Dashboard is **read-only** against every source. No source pull
ever creates, updates, or deletes data on the source side. If a future
feature needs to write (e.g., "mark this finding dismissed in source
system X"), that must be implemented as a separate, explicitly user-
authorized action, not as a side-effect of dashboard refresh.

This is partly a security stance and partly a "the dashboard should be
safe to leave on" property. Auto-refresh of a write-capable surface is a
foot-gun.
