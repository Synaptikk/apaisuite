# QRCallBox service-account posting — change plan

Companion to [workvivo-auth.md](workvivo-auth.md), which records the verified
auth chain. This file is the build plan for the QRCallBox side.

Target repo: `https://github.com/Sinaptick/QRCallBox` (separate from apaisuite).
Written 2026-08-18.

---

## Goal

Post QR scan alerts to Workvivo from the server as `qrcallbox@walmart.com`,
with no dependency on any employee being signed in. Replaces the extension's
borrowed-token heartbeat.

Note this is a **build**, not a migration: the backend currently has no Workvivo
code at all, `token-heartbeat.js` was never committed (`git log --all -S` finds
nothing), and the extension has been posting to a URL with no function behind
it. There is nothing live to cut over from.

## Two open unknowns

**1. Hop 1 (the SSO login) is unverified.** The capture had a human typing into
the PingFederate form. Server-side means POSTing the form and following the SAML
redirect chain to collect cookies.

`puppeteer-core` and `@sparticuz/chromium` are **already in
`functions/package.json` and imported nowhere**. Headless Chrome is therefore
already provisioned. Doing hop 1 in that browser and handing the cookies to
plain `fetch` for hops 2-4 is far less brittle than reversing the SSO form, and
adds no dependency.

**2. The Sendbird user id is not available server-side.** `/api/chat/config`
returns only `app_id` and `access_token`. Both the websocket handshake and the
channel-list call need the numeric user id, which the browser reads from
`window.v2.id`. If hop 1 runs in puppeteer, read `window.v2.id` off the page in
the same pass. Otherwise store the service account's id as config once — it is
stable per account.

Also unmeasured: **Workvivo session cookie lifetime**, which decides how often
hop 1 must re-run. Find it out; do not guess at it in the retry logic.

## Changes

### 1. Secrets

Add `WORKVIVO_USER` and `WORKVIVO_PASSWORD` via
`firebase functions:secrets:set`. Add the *names* as placeholders to
`functions/.env.example` beside the existing entries. Functions v2 requires
explicit binding on the handler or they are unreadable at runtime:

```js
onRequest({ secrets: [WORKVIVO_USER, WORKVIVO_PASSWORD], ... })
```

### 2. New module `functions/src/http/workvivo/`

Follow the `src/http/tickets/index.js` pattern — ESM, `onRequest` from
`firebase-functions/v2/https`, CORS from the shared `ALLOWED_ORIGINS` list.

- `session.js` — token manager. login -> cookies -> access_token -> session key.
  Exposes one `getSessionKey()` that returns a valid key or refreshes.
- `post.js` — channel resolve + send. Port from
  `modules/metricshot/lib/sendbird.js` in apaisuite; the resolution and retry
  logic transfer nearly unchanged once the `chrome.scripting` wrapper is
  dropped.
- `index.js` — the HTTP handler.

### 3. Cache the session in Firestore, not memory

Function instances are ephemeral; an in-memory cache means a fresh SSO login on
most invocations. Use a doc such as `system/workvivoSession` holding cookies,
access token, session key, user id, app id and mint time.

**Lock it down in `firestore.rules`** — deny all client reads and writes. It
holds live session credentials.

### 4. Wire-up

- `functions/index.js`: add the export beside the tickets one, and **delete
  lines 15-17 and 20** — commented-out imports of `workvivo-automation.js` and
  `workvivo-monitor.js`, neither of which exists in the repo.
- `firebase.json`: add a rewrite for the new endpoint, and **remove the four
  existing workvivo rewrites** (`/api/workvivo/connect`, `/configure`,
  `/disconnect`, `/check-completion`) — they map to functions that are not
  deployed, so those paths fail today.

### 5. Confirm the WebSocket global

Runtime is Node 22. Node exposes a global `WebSocket` at that version and it is
present on Node 24 locally, but verify on the deployed runtime before relying on
it. If absent, add `ws` to dependencies — one line either way.

### 6. Call it from the scan path

Whatever handles a QR scan needs to invoke the poster. That path has not been
traced yet.

## Order of work

Hop 1 first, standalone, run locally against a real login until it reliably
returns cookies. Everything downstream is already proven end to end.

## Do not touch yet

Deleting `modules/workvivo/lib/qrcallbox.js`, `lib/extract.js` and the alarm
wiring in `modules/workvivo/service.js` (apaisuite) is the right end state, but
do it **after** the server path posts successfully. Until then it is the only
thing that would signal a regression.
