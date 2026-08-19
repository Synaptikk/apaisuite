# Chrome Web Store submission notes

Paste-ready answers for the dashboard, plus the review risks worth knowing before
you submit. Every claim below was checked against the code — file:line given so a
reviewer's question can be answered from the source rather than from memory.

Applies to the package built by `scripts/pack-cws.sh`, which differs from the repo:
`assocpurchases` is stripped, the self-updater is stubbed, tests are removed.

## Single purpose

> APAISuite is a workbench for Walmart Asset Protection investigators. Every module
> serves one workflow: gathering and reviewing evidence for a loss-prevention case —
> case lists, ORC pattern monitoring, Spark order fraud triage, digital lock events,
> claims disposition, and store metric reporting. It reads dashboards the user is
> already signed in to and assembles the results in one place.

The single-purpose policy is the most likely place a multi-module suite gets
challenged. The argument that holds is *one workflow*, not *one feature*.

## API permission justifications

| Permission | Justification |
|---|---|
| `storage`, `unlimitedStorage` | Per-module config and cached captures in `chrome.storage.local`. Unlimited because a day of captured dashboard rows exceeds the 5 MB default. 50 files. |
| `tabs` | Every capture works by locating or opening the dashboard tab the user is signed in to, then reading it — e.g. `modules/closinglist/service.js:39`. Also `tabs.update({autoDiscardable:false})` so a background capture is not discarded mid-run. |
| `scripting` | Reads rendered values out of pages the user is authenticated to, e.g. `modules/livedashboard/lib/sources/recognition.js:184`. The extension has no server; the page is the only data source. |
| `windows` | Focuses the window holding a capture tab when a dashboard refuses to render while its window is minimised (`modules/livedashboard/service.js:509`). |
| `clipboardWrite` | Copy-to-clipboard on report views. Several copies run *after* an await (`modules/metricshot/view.js:179`), where transient user activation may have lapsed and the Async Clipboard API would otherwise be denied. |
| `webRequest` | Captures the `Authorization` header the user's own Auror session already sends, so the extension never asks for or stores credentials (`background/service_worker.js:75`). Observation only — no blocking, no modification. |
| `cookies` | Detects whether the user still has a live session before starting a capture, so a stalled run reports "sign in again" instead of a timeout (`shared/auth.js:443`). |
| `downloads` | Exports the user's own results — case PDFs and CSVs (`modules/claimsdisposition/service.js:461`). |
| `alarms` | Scheduled captures. 16 files. |
| `notifications` | Notifies the user when a monitored condition fires (`modules/sparkfraud/service.js:1434`). |
| `offscreen` | Rasterises a locally-rendered SVG chart to PNG (`modules/metricshot/lib/rasterize.js`). A service worker cannot decode SVG, so this needs a document. |
| `browsingData` | Clears cache for **named origins only** during SSO recovery, when a stale cached redirect wedges the sign-in chain (`modules/sparkfraud/service.js:417`). Scoped by `{origins}` — never a global clear. |
| `debugger` | See below. |

### `debugger` — the one that will be questioned

Answer it head-on rather than hoping it passes.

> Used by a single module (`modules/sparkfraud`) for two operations, both confined to
> Walmart-internal single-sign-on endpoints:
>
> 1. **Keeping a background sign-in from stalling.** The extension drives an SSO
>    redirect chain in a background tab. Chrome throttles timers and defers
>    microtasks in hidden tabs, and the intermediate pages stall on their own
>    JavaScript. `Page.addScriptToEvaluateOnNewDocument` applies a
>    `document.visibilityState` override to every document in the chain
>    (`service.js:209`). A declared content script cannot do this, because the
>    chain passes through an identity-provider host that is not known in advance
>    and so cannot appear in a match pattern.
>
> 2. **Submitting the sign-in form.** Corporate device-management policy makes
>    `chrome.scripting.executeScript` hang indefinitely — not fail — on
>    `gscope.walmartlabs.com/api/wmstoresso`, in both isolated and main worlds.
>    This was verified live. `Runtime.evaluate` is the only remaining way to click
>    the form's submit button (`service.js:159`).
>
> The debugger is attached only to tabs already showing this sign-in flow, every
> attach is paired with a detach (`service.js:229`), and it is never used to read
> page content or network bodies. No other module uses it.

Strengths worth keeping in mind: it is one module, narrowly scoped, always detached,
and the extension reads no response bodies via CDP. The weakness is honest — a
reviewer only has your word for the MDM behaviour.

## Host permission justifications

31 hosts, all first-party Walmart systems or named vendor tools the AP team uses
(Auror, Appriss Retail, Power BI, Tableau, Enviance, Sendbird/Workvivo). Say plainly
that each is a dashboard an investigator is already licensed for, and that broad
wildcards were deliberately removed:

- `*.walmart.com/*` and `*.wal-mart.com/*` were replaced with the nine specific hosts
  the code reaches, so the extension has no access to the public storefront.
- The three remaining wildcards are unavoidable: `*.pbidedicated.windows.net` and
  `*.analysis.windows.net` are per-tenant Power BI backends whose subdomain is
  assigned at runtime, and `*.auror.co` carries the webRequest header filter.

## Privacy / data-use disclosures

Privacy policy URL: **https://qrcallbox.com/apaisuiteprivacy** (source of truth:
`docs/privacy/index.html` in this repo — edit there and redeploy, don't edit the
hosted copy).

This section was rewritten after auditing every outbound request. The earlier
version understated it badly, so treat the table below as the authority.

### What actually leaves the browser

| Data | Destination | Where |
|---|---|---|
| **The user's own name, work email, Auror user id, store, market and job title**, on every row written | Firestore project `aurorbuddy` (developer-controlled) | `modules/aurorbuddy/lib/firestore.js:250` — `commonRowFields()` is spread into every `tool_events` / `tool_workflows` / `tool_scans` / `tool_metric_events` write |
| **Associate names, shift start/end, job label, called-off flag**, plus store number and business date | Firestore project `managerchecklist` (developer-controlled) | `modules/closinglist/lib/firebaseUpload.js` |
| The user's live **Sendbird `access_token`** for Workvivo chat, plus store number and channel name | `qrcallbox.com/api/workvivo/token-heartbeat` | `modules/workvivo/service.js:38`, payload at `:87` |
| The rendered metric card image | The Workvivo/Sendbird channel the user picks, at the moment they pick it | `modules/metricshot/lib/sendbird.js` |

Everything else — captured dashboard rows, case notes, reports, settings — stays in
`chrome.storage.local`.

### How to answer the data-use form

Three boxes, not one:

- **Personally identifiable information — yes.** Name and work email on every
  AurorBuddy row; associate names and shift times from ClosingList. There is no
  reading of the code under which this is "anonymous", and claiming otherwise is
  the kind of thing that gets an item pulled after publication rather than caught
  at review.
- **Authentication information — yes.** The Sendbird `access_token` is a credential.
  The honest framing is that it is the user's own token, couriered to the user's own
  QRCallBox backend so scan alerts can post on their behalf, and that this is the
  entire reason the module exists — `modules/workvivo/module.js:29` already says so
  in the description shown before the module is enabled.
- **Personal communications, location, health, financial — no.**

Certify Limited Use truthfully: used only to provide the features the user invokes,
not sold, not used for advertising, not used to build profiles.

### Web Push is stubbed out of the store build

The real `shared/push.js` POSTs an installation id, push subscription and user-agent
to `qrcallbox.com`, and its only payload type is `extension-update` — a notification
linking to `https://qrcallbox.com/extension/` so the user can download a ZIP by hand
(`background/service_worker.js:237`). In a store build that is an off-store
distribution prompt attached to data collection with no remaining purpose, so
`pack-cws.sh` swaps in a no-op (`scripts/stubs/push.js`). Without a subscription no
push can be delivered, which makes the listener dead code. The unpacked build keeps
the real thing.

Consequently the store build sends **no** installation id and **no** user-agent.


## Before you submit

- [ ] **Load the built ZIP unpacked once.** The store build differs from the repo in
      three ways — `assocpurchases` stripped, updater stubbed, push stubbed — and
      nothing tests that it boots. This is the one remaining unverified step.
- [ ] Choose visibility. **Unlisted** fits an internal tool; a public listing invites
      the single-purpose challenge for no benefit. Private/group visibility is
      stricter but needs the developer account inside a Google Workspace domain.
- [x] Privacy policy live at https://qrcallbox.com/apaisuiteprivacy
- [x] Screenshots at 1280×800 — `docs/store-assets/*.png`, regenerate with
      `dev/screenshots/run.sh`. All data in them is synthetic (store `0000`,
      "Demo BU", generic departments); listing images are public even on an
      unlisted item, so never rebuild them against a real market.
- [ ] Bump the version on every re-upload — the store rejects a repeat.
- [ ] Have `docs/` ready but do not ship it; `pack-cws.sh` already excludes it.

Known question you cannot pre-empt: `vendor/pdfmake` is a 1.4 MB minified bundle.
Provenance is recorded in `modules/claimsdisposition/vendor/pdfmake/README.md` —
minified as published, MIT, v3.19.0, not obfuscated.
