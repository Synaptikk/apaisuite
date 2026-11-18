# APAISuite

Unified MV3 browser-extension suite that consolidates several internal
Walmart AP fraud-investigation tools behind one shell. One toolbar icon,
one design language, one set of platform helpers; each tool is a module.

**Status:** Shipping. Currently v1.0.20 with 30 registered modules (+ 2 hidden/unregistered).
Distributed as a sideload package via [qrcallbox.com/extension/](https://qrcallbox.com/extension/).

> **AI assistants:** start at [`docs/AI_CONTEXT_BRIEF.md`](docs/AI_CONTEXT_BRIEF.md)
> rather than reading this README. Then [`docs/DOC_STATUS.md`](docs/DOC_STATUS.md)
> for what to read next vs. what to skip.

---

## Modules

| Module | Status | Slug | What it does |
|---|---|---|---|
| Live Dashboard | beta | `livedashboard` | Daily AP operational dashboard on the home screen: callouts, compliance, accident evidence, CVP, Auror evidence exceptions (home-header, not in the sidebar) |
| Market 120 Clearance & ISA | alpha | `market120` | Executive overview combining Tableau Clearance/Deleted with Power BI ISA activity, per family, with alerts |
| Metric Shots | beta | `metricshot` | Scheduled store metric cards rendered locally from VizPick data and posted to Workvivo channels |
| VizPick Market Rollup | alpha | `vizpick` | Every store's VizPick backroom health for a market, pulled from Tableau |
| Digital Dashboard | alpha | `digitaldashboard` | GIF store metrics (picks/hr, express/hr, Pick Hours history, break watch) via the local GIF daemon |
| GIF Phone Setup | beta | `gifphone` | WebUSB adb: sets up a spare phone as the GIF Companion reader (keep awake, install, pair, start) |
| Digital Metrics | beta | `digitalmetrics` | Digital fulfilment analytics, schedule import, daily task assignments |
| ScheduleRight | alpha | `digitalschedule` | WFM coverage (any team/role/job) vs guidance, validated shift edits, fit-to-guidance, undo |
| Cx | alpha | `cx` | Store NPS and customer-service sub-scores from the Hoops scorecard against a year of Medallia comments by theme and sentiment; market scoreboard; PDF export |
| AurorBuddy | live | `aurorbuddy` | Auror suspect × APPRISS/Secure cross-reference + CCTV evidence download |
| Register L/S Triage | alpha | `registerls` | WorkView queue × Power BI grid × Cash Research × EJ: flips and bouncebacks out, video-worthy shortages up |
| Door Catches | alpha | `doorcatch` | Door-host scans of items not on the receipt; review and export |
| BoB and Lisa | alpha | `boblisa` | Missed-item finder: a second small purchase on the same card minutes later; documents misses by cashier |
| Safety Agent Dashboard | alpha | `safetyagent` | SafeIQ camera hazard alerts by camera, disposition tag, associate and hour |
| Safety Observations | alpha | `safetyobs` | Log observations in plain words, daily coach nudge, who's behind |
| Compliance Tasks | alpha | `compliance` | Enviance facility compliance tasks: calendar, paper copy, one-click submit |
| ORC Corridor Monitor | live | `orcmonitor` | Tracks ORC groups along the interstate network, likely next stores, market PDF brief |
| SparkFraud | live | `sparkfraud` | Register-event → Spark/Express/GMD delivery-driver trip correlation |
| SparkRisk | live | `sparkrisk` | Pre-checkout timing review queue for recorded Spark Shop & Deliver trips |
| Accident Details | alpha | `accidents` | Open claims, missing evidence and P&L charges (CAS × Clearsight) |
| Punch Lookup | alpha | `punchlookup` | One associate's GTA punches for a range (print/email/CSV); shared wage & hour cases |
| ClaimsDisposition | beta | `claimsdisposition` | Looker Studio disposal/donation trends per store; outlier analysis; BigQuery roll-ups |
| DigitalLocks | beta | `digitallocks` | Daily AP review of digital-lock unlock events; risk-scored, in-browser only |
| QRCallBox | beta | `qrcallbox` | The store side of qrcallbox.com: scans, insights, team, posters, admin approvals |
| Workvivo (keep-alive) | beta | `workvivo` | Couriers your Workvivo chat token to QRCallBox hourly so scan notifications keep working |
| ClosingList | live | `closinglist` | Closing-shift email draft from CaseVisibility schedule + IVR call-offs |
| StockingPlan | live | `stockingplan` | Overnight stocking plan from CaseVisibility freight vs Stock 2 / Overnight hours; drafts the four-block email |
| Supply Orders | alpha | `gnfr` | MyGNFR store carts: who ordered what, tracking, late/awaiting approval, regulars not reordered |
| Comp Shop Prep | alpha | `compshop` | Produce competitors sell for less: barcode, our price, their price, ad dates |
| Cost Inventory | alpha | `costinventory` | Monthly Fresh cost inventory worksheet from ITR / OneWalmart / CV / GDP |

Not shipping: `sparkscango` (Spark & Scan&Go audits, hidden until its data sources work) and `assocpurchases` (Associate Purchases, beta, unregistered). Both folders exist under `modules/`; enable them in `modules/_registry.js`.

Order in the sidebar is set by the array in [`modules/_registry.js`](modules/_registry.js).

---

## Releasing

```bash
# from the repo root
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

ClosingList, AurorBuddy and SparkFraud were imported from standalone donor
extensions. Those originals are kept outside this repo as rollback-safe
references and are **never modified**. If a donor needs a fix, port it into
the suite — never edit the donor folder. (Original locations are recorded
in [`docs/SOURCE_MAPPING.md`](docs/SOURCE_MAPPING.md).)

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
apaisuite/
├── manifest.json
├── app.html / app.js / theme_boot.js  # shell
├── background/service_worker.js       # single SW
├── shared/                            # platform: host, storage, messaging, auth, http, ui, logging, updater, push
├── modules/
│   ├── _registry.js                   # source of truth for which modules ship
│   └── <slug>/                        # one folder per module — see docs/MODULE_CONTRACT.md
├── styles/                            # tokens + base + layout + components
├── assets/                            # icons + logos
├── data/                              # bundled reference data
├── backend/ firebase.json             # Firebase backend + config
├── scripts/                           # release.sh, notify-released.sh, pack-cws.sh, render-icons.mjs
├── tools/                             # developer tooling
├── dev/                               # one-off endpoint probes (read the *_FINDINGS.md, not the .mjs)
├── docs/                              # see docs/DOC_STATUS.md
└── CHANGELOG.md
```
