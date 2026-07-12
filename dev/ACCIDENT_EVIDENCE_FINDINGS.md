# Accident Charge Summary — initial probe (2026-06-02)

Probe script: `dev/probe-accident-evidence.mjs`. Capture:
`dev/accident-evidence-probe.json`. Screenshots:
`dev/accident-evidence-1-initial.png`, `dev/accident-evidence-2-after-go.png`.

## Status: INCONCLUSIVE — probe v2 needed

The probe loaded the page but did NOT find the store-input form documented
in the user's brief. The "Go" button it clicked was the *wrong* button
(it landed on a sidebar widget, not the data-entry form). The store-entry
form for accident-charge-summary is most likely:

1. **Inside an iframe** that AEM injects after the main HTML loads
   (common pattern for one.walmart.com landing pages that embed legacy
   wrapper apps).
2. **Behind a "MANAGE" widget** that was visible but ignored — three
   `MANAGE` buttons were detected in the input scan.
3. **Lazy-loaded** by AEM client JS some seconds after page load —
   probe captured the page state too early.

## Network captured (initial load only — no form submit yet)

Only 6 non-noise requests fired on page load:

| URL | Type | Status |
|---|---|---|
| `accident-charge-summary.html` | Document | 200 (30KB HTML) |
| `libs/granite/csrf/token.json` | XHR | 200 (CSRF token — standard AEM) |
| `home/users/z/zLtHHc66VFkbOpcQXn7J.infinity.json` | XHR | ? |
| `content/api/adp/workvivoprofile.json?email=...` | XHR | 404 |
| `content/api/adp/restapiresponse.getideanotificationdetails.json` | POST | 200 (notification dot) |
| `storage.googleapis.com/.../Enter%20Facility%20or%20Market` | GET | 404 |

**That last one is interesting.** A GET to
`storage.googleapis.com/cas_storage/cas_static_html/Enter Facility or Market `
returned 404. This is likely an attempt to load a static HTML fragment
from CAS storage — possibly the form widget for the store-entry. The
404 might mean:
- The fragment URL changed and the page is hitting the old one.
- The fragment is at a different path requiring a prefix.
- It needs auth and 404 is the "no permission" stub.

Probe v2 should:
- Capture much longer (60–120s).
- Detect iframes and recursively probe their contents.
- Click each "MANAGE" button to find which expands the store-entry form.
- Watch for additional XHRs to `storage.googleapis.com/cas_storage/`.

## Hypotheses

1. **The form is in a CAS-hosted iframe.** Walmart's CAS (Custom App
   Service?) storage URL pattern `cas_storage/cas_static_html/...`
   suggests pre-rendered HTML fragments. The page may embed an iframe
   pointing to a specific store-input + table view, and that iframe
   loads its data via separate XHR.

2. **The page uses AEM's "Wrapper" pattern.** Look for an `<iframe>`
   with a src containing `claimsiq`, `riskonnect`, or a generic Walmart
   internal app — accident evidence data is likely sourced from
   ClaimsIQ or a similar safety-management system.

3. **The form is a Granite UI component** that requires interaction with
   a `MANAGE` button to instantiate. AEM admin UIs do this.

## Next steps (probe v2)

```js
// dev/probe-accident-evidence-v2.mjs
//
// Additional capture strategies:
//   1. Scan top-level HTML for <iframe> tags and dump their src URLs.
//   2. Wait 60s after navigation before scanning the DOM.
//   3. Click EACH MANAGE button in turn, wait for new traffic.
//   4. Capture Document AND Sub_frame requests (currently only XHR/Fetch
//      was deeply inspected).
//   5. Look for any URL containing "claim", "evidence", "bodily",
//      "garage", or "safety-management".
```

## Recommendation

**Defer accident-evidence (Source C) to Phase 2.** Implement after
running probe v2. The dashboard widget for Source C will show a
"discovery pending" placeholder in Phase 1 — same UI shell, no live data
until the endpoint is identified.

The discovery package files (`docs/live_dashboard_backend/`) already
correctly classify Source C as `probe required` / Medium confidence;
nothing needs to change there. Just note in
[`OPEN_QUESTIONS.md`](../docs/live_dashboard_backend/OPEN_QUESTIONS.md)
that C-Q1 needs a probe v2 with iframe detection and a longer wait
window.

## Sensitive data hygiene

- No cookies or tokens in this capture.
- The page returned an `email=ses008s.s01458.us@wal-mart.com` URL param
  in the workvivo profile call — that's the current user's email, not
  a sensitive value, but worth flagging for the redactor.
