# APAISuite

Unified MV3 browser-extension suite that consolidates several internal
Walmart AP fraud-investigation tools behind one shell. One toolbar icon,
one design language, one set of platform helpers; each tool is a module.

**Status:** Shipping. Currently v0.8.2 with six live modules + one WIP-disabled.
Distributed as a sideload package via [qrcallbox.com/extension/](https://qrcallbox.com/extension/).

> **AI assistants:** start at [`docs/AI_CONTEXT_BRIEF.md`](docs/AI_CONTEXT_BRIEF.md)
> rather than reading this README. Then [`docs/DOC_STATUS.md`](docs/DOC_STATUS.md)
> for what to read next vs. what to skip.

---

## Modules

| Module | Status | Slug | What it does |
|---|---|---|---|
| ClosingList | live | `closinglist` | Closing-shift email draft from CaseVisibility schedule + IVR call-offs |
| AurorBuddy | live | `aurorbuddy` | Auror suspect × APPRISS/Secure cross-reference + CCTV evidence download |
| SparkFraud | live | `sparkfraud` | Register-event → Spark/Express/GMD delivery-driver trip correlation |
| ClaimsDisposition | live | `claimsdisposition` | 30-day Looker Studio pull per store; per-user outlier analysis; BigQuery historical roll-ups |
| DigitalLocks | live (V1) | `digitallocks` | Daily AP review of digital-lock unlock events; risk-scored, in-browser only |
| Workvivo (keep-alive) | beta | `workvivo` | Couriers your Workvivo/Sendbird access token to QRCallBox hourly so QR-scan notifications keep working without SAML/MFA replay |
| ClaimsBuddy | WIP, disabled | `claimsbuddy` | Clearsight claims helper. Disabled in `modules/_registry.js` pending QA. |

Order in the sidebar is set by the array in [`modules/_registry.js`](modules/_registry.js).

---

## Releasing

```bash
# from unified-extension-suite/
./scripts/release.sh patch         # or: minor / major / 0.4.2

# from QRCallBox/
npm run build && firebase deploy --only hosting

# optional: blast a Web Push notification to all subscribed extensions
./scripts/notify-released.sh
```

Within ~6 hours of the deploy, every running extension surfaces a
"v0.X.Y available" pill (Web Push fires immediately when subscribed; the
6-hour polling alarm is the fallback). Full details + the rationale for
why we don't ship through Chrome Web Store today are in
[`docs/RELEASING.md`](docs/RELEASING.md).

**Release-notes rule:** never auto-generate — always confirm the notes with
the user before running `release.sh`.

---

## Architecture in one paragraph

Single MV3 extension. `app.html` is the shell page (sidebar + viewport).
`background/service_worker.js` is the only service worker; it imports every
module statically and dispatches `chrome.runtime.onMessage` by
`(msg.module, msg.type)` to the relevant module's exported `handlers`
object. The shell + every module receive a frozen `host` object from
`shared/host.js` that namespaces storage, wraps `chrome.runtime` messaging,
re-injects content scripts on disconnect, and exposes auth/tab/SSO helpers.

For the full picture: [`docs/AI_CONTEXT_BRIEF.md`](docs/AI_CONTEXT_BRIEF.md)
(1.5k words) or, if you're going deeper, [`docs/MODULE_CONTRACT.md`](docs/MODULE_CONTRACT.md).

---

## Loading the extension

```
edge://extensions  →  Developer mode ON  →  Load unpacked  →  pick this folder
```

Reload after editing:
- **Shell code** (`app.*`, module `view.*`, `styles.css`, `shared/*` used by the page) — Cmd-R/Ctrl-R the open shell tab.
- **SW code** (`background/service_worker.js`, module `service.js`, `manifest.json`, content scripts) — reload at `edge://extensions`.

While the suite is active, **disable the standalone donor extensions** at
`edge://extensions` (content-script install-guards collide, webRequest
filters double-fire, APPRISS session contention can break the suite).

---

## Source preservation

The original donor extensions live at their original paths and are **never
modified**. They serve as rollback-safe references during the verification
window. If a donor needs a fix, port it into the suite — never edit the
donor folder.

- `<user-home>\Desktop\ClosingList\extension\`
- `<user-home>\Documents\puppy_workspace\aurorbuddy\extension\`
- `<user-home>\Desktop\SparkFraud\extension\`

---

## Cross-repo dependency: Workvivo ↔ QRCallBox

The `workvivo` module reads `window.v2.chatConfig.access_token` from any
open `workvivo.walmart.com` tab once an hour and POSTs it to a cloud
function in [QRCallBox](https://qrcallbox.com). QRCallBox uses that fresh
token to post QR-scan notifications into Workvivo channels without
re-running SAML/MFA on its own.

Contract is in `modules/workvivo/lib/qrcallbox.js` (extension side) and
`QRCallBox/functions/src/http/workvivo/token-heartbeat.js` (server side).
**These must stay in sync** when changing payload or endpoint.

Background reading lives in `QRCallBox/Workvivo/WORKVIVO.md`.

---

## Repo layout

```
APAISuite/
├── CLAUDE.md                        # project rules (load-bearing for AI assistants)
├── claims_disposition_reference.md  # upstream Looker reference for claimsdisposition
└── unified-extension-suite/         # the actual MV3 extension
    ├── manifest.json
    ├── app.html / app.js            # shell
    ├── background/service_worker.js # single SW
    ├── shared/                      # platform: host, storage, messaging, auth, http, ui, logging, updater, push
    ├── modules/
    │   ├── _registry.js             # source of truth for which modules ship
    │   └── <slug>/                  # one folder per module — see docs/MODULE_CONTRACT.md
    ├── styles/                      # tokens + base + layout + components
    ├── assets/                      # icons + logos
    ├── scripts/                     # release.sh, notify-released.sh, render-icons.mjs
    ├── dev/                         # one-off endpoint probes (read the *_FINDINGS.md, not the .mjs)
    └── docs/                        # see docs/DOC_STATUS.md
```
