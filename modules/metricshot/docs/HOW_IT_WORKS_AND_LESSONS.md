# MetricShot → Workvivo: How It Works & Everything We Learned

_Consolidated 2026-07-29 · Joel 🐶 + Shane. This supersedes the scratch docs
that lived in `Desktop/WorkVivo Data/` during the investigation._

---

## 1. What MetricShot does (one paragraph)

On a schedule, MetricShot opens a Tableau/PowerBI viz in a background tab,
screenshots a region of it via CDP, and posts that image into a Workvivo chat
channel — fully automated, no human in the loop. The pre-seeded metric is
**VizPick Score**, captured **10:00 / 12:50 / 20:00 local, every day**, posted to
**"1458 Leadership"**.

---

## 2. The end-to-end pipeline

```
alarm (every 1 min)  →  tick()  →  expandDueRuns(metric, now)
   → capture (CDP screenshot of a region)
   → validate PNG (signature/size + refuse auth-wall pages)
   → resolve channel  (Sendbird REST: name → channel_url)
   → post IMAGE       (Workvivo UI composer via CDP)   ← the hard part
   → post CAPTION     (Sendbird REST text message)
   → record run key   (so restarts/dupe ticks never double-post a slot)
```

Key files:
- `data/defaults.js` — the seed metric (URL, schedules, destination, capture cfg)
- `service.js` — alarm, `tick()`, seeding, one-time migrations, run orchestration
- `lib/scheduler.js` — `expandDueRuns`, `nextRun`, timezone/DST-aware slot math
- `lib/capture.js` — CDP screenshot + region cropping + auth-wall refusal
- `lib/cdp.js` — **shared** CDP plumbing (attach/detach/sendCdp/timeout + `waitForNetworkIdle`)
- `lib/sendbird.js` — Sendbird REST auth + channel resolve + text post; delegates images
- `lib/workvivo_upload.js` — **the image-post path** (CDP-driven UI upload)

---

## 3. The big lesson: images CANNOT go via Sendbird REST

Workvivo wraps **Sendbird** for chat. We can authenticate to Sendbird's REST API
and it works great for **text**. But **file/image messages are blocked
server-side** for this app:

```
POST /v3/group_channels/{url}/messages   (multipart FILE)
→ 400  { "code": 400108, "message": "Not authorized. \"File-messages via SDK are disabled.\"" }
```

Confirmed this is a hard **Sendbird application setting** — not a client bug:
- Multipart upload → 400108
- Pre-hosted `url` file message (no bytes) → **also** 400108

The Workvivo web UI *can* post images only because its **backend** creates the
Sendbird message server-side with a **master API token** (which bypasses the SDK
restriction). We can't (and shouldn't) hold that token in an extension.

**Therefore: the image is posted by driving Workvivo's own UI file composer.**

---

## 4. Authentication (the part that DOES work — for text + resolve)

We get Sendbird credentials the exact way the Workvivo app does — **no scraping,
no network sniffer** (an earlier sniffer approach was deleted; it was flaky):

1. `GET /api/chat/config` — Laravel session cookie + `X-XSRF-TOKEN` header
   (from the `XSRF-TOKEN` cookie) + `X-Requested-With: XMLHttpRequest`
   → returns `{ app_id, access_token }`.
2. Open a Sendbird **WebSocket** with the `access_token`; the `LOGI` handshake
   returns a short-lived **session key**.
   `wss://ws-{appid-lower}.sendbird.com/?p=JS&pv=4.22.0&sv=4.22.0&ai={appId}&user_id={uid}&access_token={token}`
3. Call `https://api-{appid-lower}.sendbird.com/v3` with that key as `Session-key`.

> ⚠️ The `access_token` is **NOT** itself a valid session key (Sendbird returns
> `400303 "Session key is invalid"`). It MUST be exchanged via the WS `LOGI` step.

Header recipe proven to return 200:
```
Session-key:   <minted via LOGI>
App-Id:        {appId}
Content-Type:  application/json; charset=utf-8      (text/JSON calls only)
SendBird:      JS,web,4.22.0,{appId}
SB-User-Agent: JS/c4.22.0///oweb
```

Channel targeting:
- `@me` / `@self` / `(me)` → find-or-create the 1-member self channel
- any other name → match a joined channel by `name` (case-insensitive)

---

## 5. The image upload path (CDP-driven UI automation)

Sendbird REST won't take the file, so `lib/workvivo_upload.js` drives Workvivo's
own composer:

1. **Map** the Sendbird `channel_url` → Workvivo web route.
   Reliable transform (verified across many channels):
   `sendbird_group_channel_<ID>` → `/chat/channels/gc_<ID>`
2. **Stage** the PNG on disk. `DOM.setFileInputFiles` needs a **file path**, but
   we hold base64 in memory — so we `chrome.downloads.download(data:URL)`, wait
   for completion to get the path, and `removeFile` + `erase` it afterward.
   (Uses the already-declared `downloads` permission.)
3. **Open** our own tab at the channel route, **foreground** it so React fully
   renders the composer, then **attach CDP** (`debugger` permission).
4. **Set the file** on `#chat-file-attach` via `DOM.setFileInputFiles`.
   → This is the crux. See §6.
5. **Wait for Send** to enable, then click it (`Runtime.evaluate` → `button.click()`).
6. **Confirm via the network** that the upload actually completed (see §7),
   then detach, delete the temp file, close the tab, restore the prior active tab.

---

## 6. Why CDP `DOM.setFileInputFiles` and not `chrome.scripting`

We tried the "cheap" pure-JS route first. It does **not** work:

| Approach | Result |
|----------|--------|
| `input.files = dataTransfer.files` + dispatch `change` | ❌ posts nothing |
| Clear React `_valueTracker` + `change` | ❌ nothing |
| `paste` ClipboardEvent on the editor | ❌ nothing |
| `drop` DragEvent on the editor | ❌ nothing |
| **CDP `DOM.setFileInputFiles`** | ✅ **posts a real image** |

Workvivo's React composer ignores **untrusted** synthetic events. CDP's
`DOM.setFileInputFiles` sets files as if a human picked them (trusted), which is
the only thing that trips the real upload handler. This is a known browser-
automation reality, not a workaround we can avoid.

The stable DOM hooks (verified live):
- File input: `#chat-file-attach` (proper id — not a hashed class)
- Send button: matched by `aria-label`/class `~ /send/`, excluding `attach|file|photo`

---

## 7. The subtle bug that made it "send but no image"

First working version posted the **caption** but not the **image**. The timeline
showed `set-file → click-send → confirm → done` all within ~1 second — impossible
for a real upload. Two compounding bugs:

1. **Lying confirm.** The confirm counted `cloudfront|uploads` images in the DOM,
   but the channel's *existing* images already matched → it returned "posted!"
   instantly.
2. **Premature close.** Believing that lie, the `finally` block closed the tab
   ~1s after clicking Send, **aborting Workvivo's upload POST mid-flight.** The
   caption survived because it's a separate REST call; the image didn't.

**Fix:** stop guessing from the DOM. `lib/cdp.js::waitForNetworkIdle` enables
CDP's Network domain and waits for a real **2xx upload response** *and* the
network to go idle (2.5s quiet window, min 4s, 45s cap) before closing, plus a
1.5s settle. If no matching upload response is seen, it returns
`UI_UNCONFIRMED` **with the list of POSTs it did see** (for tuning) instead of
falsely claiming success.

> Zen-of-Python moment: *"In the face of ambiguity, refuse the temptation to
> guess."* Watching the actual network beats inferring from the DOM.

---

## 8. Error classes (for reading logs)

| Class | Meaning |
|-------|---------|
| `NO_SESSION` | Not signed in / `/api/chat/config` unavailable / WS mint failed |
| `NOT_FOUND` | Named channel not joined |
| `AUTH` | Sendbird 401/403 — stale session, won't self-heal on retry |
| `UI_NO_COMPOSER` | `#chat-file-attach` never appeared (wrong channel / signed out) |
| `UI_SEND_DISABLED` | Send button never enabled after attaching the file |
| `UI_UNCONFIRMED` | Clicked Send but no successful upload seen (check `debug.postResponses`) |
| `STAGE_FAIL` | Couldn't write the temp PNG to disk |
| `CDP_ATTACH` | Debugger attach failed (DevTools already open on the tab?) |

---

## 9. Scheduling — how it fires

- `register()` (from `module.js`) runs `ensureSeed()` then `installTickAlarm()`.
- The alarm `metricshot.tick` fires **every 1 minute** (`TICK_PERIOD_MIN`).
- Each tick, `expandDueRuns(metric, now)` returns any slots that just passed
  within the catch-up window (default 60 min) and haven't been posted yet.
- Deterministic **run keys** (`<id>:<yyyy-MM-dd>:<hh:mm>`) mean a restart or a
  duplicate tick can never double-post the same slot.
- Timezone-aware and DST-correct (tested: spring-forward skips 02:30, fall-back
  fires 01:30 once).

Current VizPick Score schedule: **10:00, 12:50, 20:00** local, all 7 days.
Verify quickly:
```
node --input-type=module -e "import {SEED_METRICS} from './modules/metricshot/data/defaults.js'; import {normalizeMetric} from './modules/metricshot/lib/metrics.js'; import {nextRun} from './modules/metricshot/lib/scheduler.js'; const m=normalizeMetric(SEED_METRICS[0]); console.log(nextRun(m).label);"
```

---

## 10. One-time migrations (in `service.js`)

Metric configs live in `chrome.storage.sync`, so editing `defaults.js` only
affects **fresh** installs. To change an already-seeded install we use
marker-gated one-time migrations that fire once, then never clobber user edits:

- `channelRestoredTo1458` — flips a metric still on the debug `@me` value back to
  `"1458 Leadership"`. (Superseded the earlier `channelMigratedToMe` flip used
  during image-post debugging.)
- `SCHEDULE_MIGRATIONS` — one-shot schedule fix-ups (e.g. 14:00 → 12:50), each
  gated by its own storage marker.

---

## 11. Permissions used (all already declared)

- `debugger` — CDP for both screenshot capture and the UI file upload
- `downloads` — stage the PNG to disk for `DOM.setFileInputFiles`; cleaned up after
- `tabs`, `storage`, `alarms` — tab lifecycle, config, scheduling

No new permissions were needed for the image-post fix.

---

## 12. Tests

`modules/metricshot/lib/tests/` (run each with `node <file>`):
- `metrics.test.mjs` — normalize/validate/slug/migration matching
- `scheduler.test.mjs` — due-run expansion, DST, determinism, `nextRun`
- `sendbird_rest.test.mjs` — auth flow, resolve, text post, file-action-removed
- `validate.test.mjs` — PNG validation + auth-wall detection
- `workvivo_upload.test.mjs` — `channel_url` → web-route mapping

The CDP-driven upload flow itself can't be unit-tested without a browser; it was
verified via live end-to-end runs (image confirmed in the channel).

---

## 13. Dead ends we ruled out (so nobody re-chases them)

- ❌ Sendbird JS SDK on `window` — never exposed on workvivo.walmart.com
- ❌ Scraping/decrypting the session key from IndexedDB — AES-encrypted
- ❌ Network **sniffer** content script for the session key — flaky, deleted;
  the `/api/chat/config` + WS `LOGI` mint is deterministic and clean
- ❌ Sendbird REST **file** message (multipart or pre-hosted URL) — 400108
- ❌ Workvivo `/api/media/upload` reverse-engineering — SPA-fallback red herring
- ❌ Synthetic file-input events (`input.files=`, paste, drop) — untrusted, ignored
