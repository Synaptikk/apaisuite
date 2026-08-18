# Workvivo / Sendbird auth — how posting actually authenticates

Captured live on 2026-08-17 against `workvivo.walmart.com` with a real store
account, via a scripted browser. Supersedes the assumptions in the QRCallBox
service-account handoff and explains what `modules/metricshot/lib/sendbird.js`
is working around.

**No credentials, tokens, or user ids are recorded in this document.**

---

## The short version

A server can post to Workvivo chat with nothing but a username and password.
No browser is required at post time, and no employee needs to be signed in
anywhere. The chain is three hops:

```
username + password
   └─(1)─> Workvivo session cookie          (SAML SSO, no MFA observed)
             └─(2)─> Sendbird access_token  (GET /api/chat/config)
                       └─(3)─> session key  (websocket LOGI handshake)
                                 └─────────> REST posting works
```

Each hop was executed end-to-end and returned 200.

---

## (1) Login — SAML SSO, no second factor

`https://workvivo.walmart.com/chat` redirects to Walmart PingFederate:

```
https://mtls.pfedprod.wal-mart.com/idp/<idpId>/resumeSAML20/idp/SSO.ping
```

Two-step form: **User ID**, **Country/Region**, **Location** (`Homeoffice` /
`Store/Club` / …), then password on the following screen.

Observed on a clean browser profile with no prior trust:

- **No MFA challenge** — no push, no code, no security key.
- **No "remember this device" / "stay signed in" prompt** — so there is no
  device-trust artifact to seed, and none is needed.
- Sign-in to loaded chat page: **1–15 seconds**.

This is the finding that makes a headless server login viable. It should be
**re-verified for the service account specifically** — MFA policy can be set
per-account or per-group, and `qrcallbox@walmart.com` may be enrolled
differently from a store user.

## (2) `GET /api/chat/config` → the Sendbird access token

```
GET https://workvivo.walmart.com/api/chat/config
Cookie:       <Workvivo session cookies>
X-XSRF-TOKEN: <urldecoded value of the XSRF-TOKEN cookie>
Accept:       application/json

200 → { "app_id": "<uuid>", "access_token": "<40 chars>" }
```

- The `X-XSRF-TOKEN` header is **required**. Cookies alone return `401`
  (verified — the same request without the header fails).
- The value is the urldecoded `XSRF-TOKEN` cookie, standard Laravel convention.
- The returned `access_token` is byte-identical to the one the page exposes at
  `window.v2.chatConfig.access_token` — the same credential the old extension
  heartbeat was harvesting, available directly and without a browser.

## (3) Exchange the access token for a session key

The access token **cannot authenticate Sendbird REST on its own.** All of these
return `400`:

| Attempt | Result |
|---|---|
| `Access-Token: <token>` | `400 "Api-Token is missing"` |
| `Access-Token` + full SendBird SDK headers | `400 "Api-Token is missing"` |
| `Session-Key: <access_token>` | `400 "Session key is invalid"` |
| no auth header | `400 "Api-Token is missing"` |

Sendbird wants either an admin master token (which Walmart declined to issue)
or a genuine **session key**. The session key is minted by the SDK's websocket
handshake, which accepts the access token:

```
wss://ws-{appId-lowercase}.sendbird.com/
  ?p=JS&pv=4.22.0&sv=4.22.0
  &ai={appId}
  &user_id={userId}
  &access_token={access_token}
  &active=1
```

The server replies with a single frame prefixed `LOGI` followed by JSON. The
session key is the `key` field. Relevant fields:

| Field | Meaning |
|---|---|
| `key` | the session key — 40 chars, used as the `Session-Key` REST header |
| `ekey` | secondary key, not needed for REST posting |
| `expires_at` | **`-1` — the key does not carry an expiry timestamp** |
| `login_ts`, `ping_interval`, `pong_timeout` | connection keepalive params |

Open the socket, read one frame, take `key`, close the socket. No need to keep
the connection alive for REST posting.

### On `expires_at: -1`

The minted key advertises no expiry. That does **not** mean it is permanent —
the live page's key demonstrably rotates, which is the entire reason
`wv_session_sniffer.js` exists. Treat `-1` as "no scheduled refresh available"
and drive refresh off failure instead: on `401`/`403`, redo hops (2) and (3)
and retry once. `lib/sendbird.js` already has exactly this retry shape.

## (4) Posting

With `Session-Key` in hand, the existing REST recipe in
`modules/metricshot/lib/sendbird.js` works unchanged:

```
Session-Key:  <minted key>
App-Id:       <appId>
SendBird:     JS,web,4.22.0,<appId>
SB-User-Agent: JS/c4.22.0///oweb
```

Verified: `GET /v3/users/{userId}/my_group_channels` returned `200` with real
channel data using a key minted this way.

---

## Channel targeting notes

From a live account with 26 group channels:

- **8 had names; 18 were empty-string.** The unnamed ones are direct messages.
  Name-matching only ever resolves the named group channels — which is fine,
  since those are the destinations anyone configures, but a name lookup that
  misses should not be described to the user as "you are not in that channel".
- The self / note-to-self channel is tagged **`custom_type: "self_channel"`**.
  The Workvivo UI itself queries for it with `?custom_types=self_channel`.
  `sendbird.js` currently identifies it heuristically as "a channel with
  exactly one member" — matching on `custom_type` would be more accurate and
  matches what the product actually does.

## Still open

- **Image upload.** Multipart sends over this auth path return
  `400 "File-messages via SDK are disabled"`. That is an app-level Sendbird
  setting and minting a proper session key does **not** change it. Workvivo's
  own UI must upload through a different route; capturing a real image send
  from the UI network trace is the outstanding task. Text sends are unaffected.
- **Service-account MFA.** Verify `qrcallbox@walmart.com` specifically; the
  no-MFA result above is from a store user account.
- **Session cookie lifetime.** Not measured. Determines how often the server
  must redo hop (1) rather than just hops (2)–(3).

## What this means for the QRCallBox service account

The handoff's "token manager" is buildable as originally described — a real
token manager, not a persistent headless browser. It needs to:

1. Hold the service account's username + password in the existing secret store.
2. Log in (hop 1) and keep the session cookie + XSRF token.
3. Mint `access_token` (hop 2) and exchange it for a session key (hop 3).
4. Cache the session key; on `401`/`403` re-run 2–3, and if that fails, re-run
   1–3, then retry the post once.

Hops 2–4 are plain HTTP and one short-lived websocket — all cheap and scriptable
in Cloud Functions. Hop 1 is the only piece that touches a login form, and if it
proves awkward to script directly against PingFederate, it is the one place a
headless browser would earn its keep.
