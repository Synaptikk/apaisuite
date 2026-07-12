# Accident Charge Summary — probe v2 (2026-06-02 PM)

Probe script: `dev/probe-accident-evidence-v2.mjs`. Full capture:
`dev/accident-evidence-v2-probe.json`. Screenshots:
`dev/accident-v2-1-initial.png`, `dev/accident-v2-2-after-clicks.png`.

## Status: PARTIAL — form found, but session expired before capture

The v2 probe found what v1 missed: there IS a Go input on the main page
(it's an `<input type="...">` rendered visibly at viewport (1005, 328) —
v1's heuristic scanned for store-keyword inputs only and ignored generic
text inputs).

Then the page redirected to SAML
(`https://pfedprod.wal-mart.com/idp/.../resumeSAML20/idp/startSSO.ping`)
mid-probe, so no form submit / data XHR was captured before auth lapsed.

## What we confirmed

- Page has 49 visible clickables on initial render (no iframes).
- A "Go" input button at (1005, 328) — likely the store-submit trigger.
- No "MANAGE" buttons on this load (v1 probe likely matched buttons that
  rendered earlier in the page lifecycle — UI state varies).
- No `cas_storage/cas_static_html` request fired this time (so v1's 404
  on that URL may have been a one-off stub during a different page state).
- Only network requests captured were the page HTML + Adobe analytics +
  CSRF token. No data XHRs reached.

## Likely shape (still unverified)

Given the URL is `.html` on AEM, the form most likely:
- Targets a server-side POST to the same path (or a `?get=` query) that
  returns the rendered table HTML embedded in the page.
- Or fires an XHR to a JSON endpoint under
  `one.walmart.com/content/api/...` (the same pattern as the
  `restapiresponse.getideanotificationdetails.json` call we DID see).

Either path means a fresh `one.walmart.com` session is required to
probe. The user's earlier session lasted long enough for the page HTML
to load but expired before we could click Go.

## Probe v3 plan

To finish this:

1. Have the user manually click into `one.walmart.com` once to ensure a
   fresh SSO session (or use `host.auth.clickSso` to auto-auth in
   background).
2. Within the SSO-fresh window (typically 1+ hours), navigate to the
   accident-charge-summary URL.
3. Programmatically locate the store-input + Go button (both confirmed
   present at known coordinates), fill `1458`, click Go.
4. Capture the resulting traffic — pay special attention to:
   - POST back to the same `.html` URL (AEM server-side render)
   - Any XHR to `one.walmart.com/content/api/...`
   - Any redirect to a different host (claimsiq, riskonnect, etc.)

## Implementation impact

Accident Evidence remains a **Phase 2 / pending** widget on the live
dashboard. The widget placeholder text now says "Probe v2 pending
(iframe detection)" — that's outdated; should say "Auth-state probe
needed; form located but capture interrupted by SAML".

Updating that placeholder is the only code change needed until probe v3
identifies the data endpoint.
