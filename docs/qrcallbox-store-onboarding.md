# QRCallBox store onboarding — module design

How a store gets set up to post QR scan alerts to Workvivo, driven from the
apaisuite **QRCallBox module** (`modules/workvivo/`). Companion to
[workvivo-auth.md](workvivo-auth.md) (the proven auth chain) and
[workvivo-service-account-plan.md](workvivo-service-account-plan.md) (the
server side). Decisions locked 2026-08-18.

## Model: the extension is a cookie courier

The server does **not** log into Workvivo. It can't cheaply — SSO carries an
MFA push. Instead the browser does what it already does natively (SSO + MFA),
and the extension hands the resulting session cookie to the server. No Workvivo
password and no TOTP seed are needed for v1.

```
store manager  --signs into Workvivo as {store}qrcallbox@walmart.com-->  browser (MFA push, once)
extension      --chrome.cookies reads workvivo_session (httpOnly)-->     cookie
extension      --POST {storeNumber, cookie}, authed by QRCallBox token--> server
server         --keep-alive ping every ~6h + post scans-->               Workvivo
```

## Two auth systems, joined by store number

| | What | How | Status |
|---|---|---|---|
| QRCallBox account | Firebase email/password; identifies the store to the backend | Firebase Auth REST (`identitytoolkit.googleapis.com`), no SDK | build in module |
| Workvivo session | the `{store}qrcallbox@walmart.com` cookie that authorizes posting | guided browser login + `chrome.cookies` capture | build in module |

### Decisions
- **Registration:** full signup **and** login inside the module, via the
  Firebase Auth REST API — not the client SDK (MV3 CSP), and not the
  `/api/auth/*` Cloud Functions (they are rewritten in firebase.json but **do
  not exist**; the website uses the Firebase client SDK directly). REST returns
  an `idToken` the QRCallBox functions already verify with `verifyIdToken`.
- **Cookie capture:** guided browser login + auto-capture. The module opens
  Workvivo, the manager signs in as the store account, the extension reads the
  cookie. Browser handles MFA; no password/seed in our code for v1.

## Two constraints found in the code

1. **Managed Edge guts `chrome.cookies`.** `sparkfraud` documents it:
   `chrome.cookies.getAll({})` returns only ~2 cookies for the whole profile
   under Walmart Edge policy. Workaround (already in `sparkfraud/service.js`):
   url-scoped `getAll({url})` for httpOnly cookies, merged with `document.cookie`
   via an injected script for the rest. **Reuse that pattern** — the needed
   cookies are `workvivo_session` (httpOnly), `laravel_token` (httpOnly),
   `XSRF-TOKEN` (readable). Do not use naive `getAll({})`.
2. **The QRCallBox auth Cloud Functions do not exist.** Only `getUser` and
   `updateUserToken` are defined. Anything assuming `authRegister`/`authLogin`
   is assuming a function that was never built — same pattern as the dead
   workvivo functions and the never-committed token-heartbeat.

## One wrinkle to decide operationally

A browser profile holds **one** Workvivo session. Signing in as
`{store}qrcallbox@walmart.com` logs the person out of their personal Workvivo.
Fine on a shared back-office machine; disruptive on a personal one. Not a code
blocker, but name it during rollout. Per-store MFA enrollment (where each store
account's push goes) is an operational/admin question, not a module one.

## Proposed module menu (`modules/workvivo/`)

Replaces the current API-key + heartbeat UI (that whole borrowed-token design
is retired). Sections:

1. **QRCallBox account** — signup / login (Firebase Auth REST). Shows signed-in
   email; stores the refresh token, refreshes the idToken as needed.
2. **Store** — set/confirm store number. Drives which `{store}qrcallbox@...`
   account to use and which channel to post to.
3. **Workvivo connection** — "Connect store account" button: opens Workvivo,
   waits for a signed-in session as the store account, captures the cookie,
   uploads it. Status pill: connected / expired / never. "Reconnect" re-runs it
   when the session lapses.
4. **Status** — last post, last keep-alive, channel, errors.

## Server side (QRCallBox repo — mostly still to build)

- Endpoint to receive `{storeNumber, cookie}` authed by the Firebase idToken;
  store in a locked-down Firestore doc (deny all client reads/writes).
- Keep-alive scheduled function: GET a workvivo.walmart.com route every ~6h per
  store to hold the session; alert on failure.
- Scan path: on a scan, load that store's session, run the proven post chain
  (config -> websocket session key -> REST send), post to the store's channel.
- The post chain itself is proven and portable from
  `modules/metricshot/lib/sendbird.js`.

## Build order (most-verifiable first)

1. **Server: receive + store + keep-alive.** Pure Node, testable now with a
   captured cookie. Proves the session survives server-side over days and sizes
   any hard SSO backstop.
2. **Server: post-on-scan** using the stored session. Reuses proven code.
3. **Module: cookie capture** (sparkfraud pattern) + upload.
4. **Module: Firebase Auth REST** signup/login + store number.
5. Retire the old heartbeat UI and the extension token-harvesting files.
