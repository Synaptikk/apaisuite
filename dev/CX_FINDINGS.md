# Cx module — source findings

What the `cx` module reads, how each source authenticates, and the field
vocabulary. Everything here was verified live against store 1458 on
**2026-09-25** over the debug Edge (`dev/launch-edge-debug.sh`).

Probe scripts: `dev/cx-probe-hoops.mjs`, `dev/cx-probe-hoops-time.mjs`,
`dev/cx-probe-hoops-comments.mjs`, `dev/cx-probe-medallia.mjs`,
`dev/cx-probe-medallia-headers.mjs`, `dev/cx-probe-medallia-replay2.mjs`,
`dev/cx-probe-medallia-pull.mjs`, `dev/cx-probe-limit.mjs`,
`dev/cx-gateway-test.mjs`.

---

## 1. Hoops — the graded numbers

Same tRPC pattern as `costinventory/lib/itr.js` and
`livedashboard/lib/sources/cvp.js`: plain cookie-authenticated GET, no tab
driving needed when the Hoops SSO session is warm; falls back to replaying
the GET inside a `hoops.wal-mart.com/ops-portal/*` tab when it is not.

```
GET https://hoops.wal-mart.com/ops-portal/v1/trpc/<proc>
      ?input={"json":{"buId":1458,"buType":6,"timeType":202}}
```

`buType: 6` = store. `timeType`: **100** day, **202** WM week, **302** month,
**402** quarter, **502** year (the full enum is echoed in the 400 body for an
invalid value). Responses are array-mode: `meta.columns` is the only key to
`rows`, and `pivotRows` carries the same columns at day/week/month/quarter/year
for the current period.

### `metric.cx.megaCard.nps`

Columns: `timeType, timeOffset, timeInt, timeText, timeTextShort,
timeTextLong, netPromotorScore_Ty454, netPromotorScore_Ly454`.

14 rows ending at the current period. **NPS is not published daily** —
`timeType: 100` returns `null` for every day, and `timeType: 201` is null
throughout, so **202 is the only useful weekly type**. Month, quarter and year
all populate.

Store 1458 as at WM26 WK34: TY **58** vs LY **62**, down from 72 at WK21 — a
14-point slide over 13 weeks that crossed below LY at WK32.

### `metric.cx.megaCard.inStore`

The sub-scores behind NPS, all 1-5 averages, TY and LY
(`*_Score_Ty454` / `*_Score_Ly454`):

| Column prefix | Card label |
|---|---|
| `assocInteractions` | In-Store Associate Interactions |
| `productAvailability` | In-Store Product Availability |
| `checkoutSatisfaction` | In-Store Checkout Satisfaction |
| `scoPinpad` | SCO / Pinpad |
| `pickupDelivery` | OPD 5-Star (pickup + delivery combined) |
| `pickup` | Pickup |
| `delivery` | Delivery |
| `overallSatisfaction` | Overall Satisfaction |

Unlike NPS these **do** publish daily (`timeType: 100`), so the module offers a
daily view of the sub-scores even though the NPS line stays weekly.

### The market: `buType` 5

`buType` is the level the figures describe. **6 is a store, 5 is a MARKET** —
`{ buId: 120, buType: 5 }` returns a real published NPS series (65 at WM26 WK34),
so the market line on the scoreboard is Hoops' own number rather than an average
of store averages. Probed 2026-09-25; buTypes 1-4 answer
`Lineage not found`, and 7+ are rejected by the enum.

Per-store works for any store in the roster, not just the home store — all ten of
market 120 returned 14 weeks each. At WM26 WK34, TY / LY:

| Store | 5151 | 1089 | 756 | 5173 | 658 | 2988 | 3660 | 1458 | 669 | 1215 |
|---|---|---|---|---|---|---|---|---|---|---|
| TY | 74 | 74 | 73 | 69 | 66 | 66 | 64 | **58** | 56 | 53 |
| LY | 72 | 59 | 66 | 60 | 56 | 66 | 56 | **62** | 55 | 57 |

Market 65. Store 1458 is 8th of 10 and the only store more than 3 points *below*
its own last year.

Cost is one request per store per metric — 2N + 2, all plain cookie GETs with no
tab driving, four at a time. Market 120 lands in well under a minute.

### `metric.cx.genAiSummary`

`{"json":{"buType":6,"buId":1458}}` — no `timeType`. Columns
`jsonVersion, summaryJsonBase64, lastUpdatedTimestamp`. The middle column is
**gzip then base64**; a `DecompressionStream` of type gzip in the SW yields
`{ summary: { brief, positive[], negative[], suggestions[] }, json_version,
timestampUTC }`, each `positive` / `negative` entry being
`{ theme, subtheme, comments[] }`.

**It is stale.** The copy served on 2026-09-25 is stamped
`2026-01-31T22:21:09Z` — nearly eight months old. The module shows it, but only
under its own date, and never as the current read. This is exactly why the
module computes its own breakdown from Medallia instead of leaning on this.

### `metric.cx.comments` — fallback only

Undocumented but live. Columns `storeNbr, businessDateFormatted, commentText,
tripType, commentRating`. **Hard-capped at 50 rows, ignores `timeType`
entirely, and trails about a week** (through 2026-09-18 when probed on 09-25).
Useful only as a no-Medallia fallback so the module can still show something.

---

## 2. Medallia — the comments

`https://walmart.medallia.com` behind Walmart SAML. A GET of
`https://walmart.medallia.com/sso/walmart/` redirects a signed-in user to their
own default page **with `roleId` filled in** — so the role is discovered, never
hard-coded (it was 251254 / "Store Manager" here).

Reporting API:

```
POST https://walmart.medallia.com/api-comp/reporting/query?view_as_role=<roleId>
```

### Why a tab, and not just a service-worker fetch

Worth writing down because it looks like it should work. `chrome.cookies.getAll`
from the service worker **does** return the Medallia session — 7 cookies
including `JSESSIONID`, all `SameSite=no_restriction` — and a credentialed SW
`fetch` of `https://walmart.medallia.com/sso/walmart/` comes back `200` on a URL
carrying `?roleId=251254`, which looks signed in.

It is not. Fetching an actual reporting page from the SW redirects to
`/sso/walmart/samlRequest.do`: the reporting session is established by the SAML
POST round-trip that only a real browsing context completes, and the shell
document the SW gets back never contains a usable `csrfToken`. **The anchor tab
is load-bearing** — tested and ruled out on 2026-09-25, so it does not need
testing again.

### The landing page differs per profile

`GET /sso/walmart/` lands wherever that user's default view is. This machine's
debug profile lands on `/sso/walmart/applications/ex_WEB-5/pages/4899`; a plain
session lands on `/sso/walmart/pages/?roleId=…`. An early version of
`lib/medallia.js` required `/applications/` in the path before it would accept a
tab, and would have waited out the full timeout and declared the session dead for
anyone landing on the second shape. Readiness is now decided by **whether the
page hands over a CSRF token**, never by its URL.

### Auth: cookies are not enough

A POST carrying only session cookies answers `200` with the body
`{"error":"Unauthorized access.","status":401}` — note the **200 status
wrapping a 401 body**, so the code must inspect the body, not the status.
Two request headers are required:

- `x-csrf-token` — served in the page HTML as `csrfToken: "<a>|<b>|<c>"`.
  It is **not** on `window` (`window.CONFIGURATION` is an empty object by the
  time a script can read it) and **not** a cookie, so it has to be scraped out
  of `document.documentElement.outerHTML`.
- `x-medallia-active-role-id` — the same `roleId`.

`x-medallia-reporting-query-data-view: 27` is sent by the app and kept for
parity. The `x-medallia-ngr-*` module-tracking headers are telemetry and are
not required.

Because the token lives in the page and the cookies are SameSite-scoped, the
module runs the POST **inside a `walmart.medallia.com` tab** via
`chrome.scripting.executeScript` — the same shape as `cvp.js`, and registered
with `shared/tabSessions.js` so a background tab it opened gets reaped.

**The anchor tab must be probed before it is trusted.** The first end-to-end run
sat for seven minutes and stored nothing: the `walmart.medallia.com` tab it
borrowed had been backgrounded for half an hour and was already frozen, and a
frozen tab **never settles an executeScript** — it does not reject, so the paging
loop had nothing to catch. Identical to VizPick's overnight hang
(MEMORY.md::VizPick tab leak). Two guards, both needed:

- a per-call deadline on every `executeScript` (90 s; a real 1,000-record page
  measures 14 s), which turns a hang into an ordinary failure, and
- a **liveness probe** before the pull starts: one regex against the DOM with an
  8 s deadline. An awake tab answers in milliseconds; a frozen one never answers.

On a failed probe the module opens **its own** background tab rather than
reloading the user's. Reloading was tried first and measured: it cost 193 s and
still ended in a `TAB` timeout, and it would have discarded whatever the user had
on screen. Opening a fresh tab is about 15 s and is ours to reap.

### The query

`operationName: getComments` on the `feedback` connection. The app's own query
is 9 KB; the module sends a slim hand-written one (`lib/medallia_query.js`)
asking only for what it renders. Two argument shapes cost a round of
`GRAPHQL_VALIDATION_FAILED` and are worth writing down:

- `matchingTaggings(filters: ...)` — **plural**, not `filter:`.
- `$taFilter` is `[TaggingFilter!]!` — a **list**, even for a single filter.

Store scoping is implicit in the role; there is no store field in the
variables. `subject` confirms it (`1458 - FORT OGLETHORPE - GA | Surveys`).

**Dates take plain ISO strings** — `{ fieldIds: [dateField], gte:
"2025-09-25", lte: "2026-09-25" }`. The app itself sends Medallia's opaque
`"IntervalId: 10892"` tokens, whose id space mixes granularities (10892 was a
*month*, Jun-26); ISO avoids having to reverse that mapping, and was verified
to bracket correctly: 09-18 to 09-25 = 155, September = 575, 90 days = 1,989,
52 weeks = 7,961.

Key field ids:

| Purpose | Field id |
|---|---|
| Response date | `k_walmart_voc_ltp_update_responsedate` |
| Has a comment | `k_walmart_survey_has_comment_yn::seqnum` = `1` |
| 1-5 score bucket | `a_overall_score_with_social_media_5_buckets` |
| Journey (trip type) | `k_walmart_voc_journey_type_filter_alt` |
| Subject (store + channel) | `k_walmart_voc_store_source_concat_txt` |
| Data view | `27` |
| Tag pools | `27`, `33`, `37` |

Comment body fields (a record answers exactly one, so they are requested
together and the populated one wins): `q_walmart_voc_store_ovrl_exprc_cmt`
(in-store "Comment"), `q_walmart_voc_ogp_customer_comments_cmt` (OPD "Customer
Comments" — the single biggest field), `q_walmart_voc_ogp_ltr_recommend_cmt`,
`q_walmart_voc_ogp_what_went_wrong_cmt`,
`q_walmart_voc_store_rating_reason_cmt`, `q_walmart_voc_scan_go_ltr_trans_cmt`,
`q_walmart_voc_store_fin_service_osat_cmt`,
`q_walmart_voc_store_fuel_osat_reason_cmt`,
`q_walmart_voc_store_ltr_auto_care_cntr_reason_cmt`.

### Scope: the role sees ONE store

Decisive for anything market-wide. Store scoping is implicit in the Medallia
role, and this account's role ("Store Manager", roleId 251254) covers exactly one
store. A 1,000-response September sample taken with **no store filter at all**
came back 1000/1000 store 1458.

Two things that look like counter-evidence and are not:

- The unfiltered September count is **25,806**, which looks far too large for one
  store. It is not: 823 of every 1,000 sampled are the
  `1458 … | Self-Checkout & Pinpad` micro-survey, which carries no comment field
  in our list and so never appears in the comment pull.
- `e_walmart_voc_store_num_unit` looks filterable. It is a **`UnitField`**, not an
  enum, so `in: ["658"]` is rejected with `Invalid field value` — including for
  1458 itself. Filtering by store number is not the answer; a market-level
  Medallia role would be.

So the market view is **scores only**, and the module says so on the panel rather
than leaving a reader to infer it from a missing section.

### Paging and cost

`first: <limit>`, `after: <cursor>`, cursor from
`nextPages(n: 1) { hasNextPage endCursor }`. Measured on the 52-week window
(7,961 records):

| `first` | records | bytes | time |
|---|---|---|---|
| 200 | 200 | 153 KB | 4.7 s |
| 500 | 500 | 358 KB | 8.4 s |
| 1000 | 1000 | 714 KB | 14.2 s |
| 2000 | 2000 | 1.41 MB | 23.9 s |

The module pages at **1000** — eight requests and roughly two minutes for a
cold 52-week pull, then incremental (newest-first, stop at the newest record id
already stored), which is one small request a day.

### What a record carries

```
id, timestamp ("2026-09-24 22:02:43"), journey[], subject[],
scoreFieldData[0].values[0]          -> "1".."5"
commentData[].textsWithLanguage[0].text
commentData[].matchingTaggings.topicRegions[]     { startIndex, endIndex, topics[{id,name}] }
commentData[].matchingTaggings.sentimentRegions[] { startIndex, endIndex, sentiment }
commentData[].sentimentTaggings[]                 { sentiment, regions[] }   <- whole-comment fallback
```

Sentiment per topic is resolved by **span overlap**: the sentiment region that
overlaps a topic region wins; with no overlap the whole-comment
`sentimentTaggings` sentiment is used; failing both the topic is counted
`UNSPECIFIED`. Values: `STRONGLY_POSITIVE`, `POSITIVE`, `MIXED_OPINION`,
`NEGATIVE`, `STRONGLY_NEGATIVE`, `NO_OPINION`.

Coverage over the 90-day sample (1,989 records): **845 carry topic tags (42%)
and 1,468 carry sentiment (74%)**. So the topic breakdown is a view of a
minority of the feedback — the module prints the tagged count next to every
breakdown rather than implying it covers everything. Score and journey are
present on essentially all records, which is why the rating mix is computed
over the full set.

### Journeys and channels, 90 days, store 1458

Journey: Scheduled Delivery 724, Store 374, Scheduled Pickup 312, Shipping 157,
Rx 123, App 105, InHome 82, Unscheduled Pickup 50, Vision 37, Returns 17,
ACC 8. **In-store is a minority of the comments** while NPS blends all of it,
which is the whole reason the view carries journey chips.

Channel (`subject`): Surveys 1907, Google Reviews 35, Store LTP 24, Pickup &
Delivery LTP 13, plus Auto Care Center / Pharmacy / Vision Google Reviews.

Rating mix: 1 star 348, 2 star 86, 3 star 101, 4 star 156, 5 star 1260 —
barbelled, so a mean is close to meaningless here and the module shows the mix.

### Topic taxonomy

Medallia runs **parallel taxonomies** across the three tag pools: in-store
surveys and OPD surveys use different names for the same idea
(`Interaction - Attitude` vs `Associate Interaction - Attitude`,
`Checkout - General` vs `Checkout Experience - Checkout Process`,
`Product Availability - ...` vs `Product Page - Stock/Availability
Information`). Left raw they split one problem into two half-sized rows and
nothing ranks correctly. `lib/topics.js` folds them into one theme vocabulary
while keeping the original topic name for drill-down. Families seen in 90 days,
by volume: Interaction 426, Brand 297, Fulfillment 199, Associate -Direct
Mentions 192 (no subtheme), Product 191, Associate Interaction 168, Speed 157,
Accuracy of Order 152, Checkout 136, Delivery Location 135, Associate Dept 82,
Delivery Instructions 52, Tipping 41, Atmosphere 36, Checkout Experience 35,
Returns 27, Shopping Bags 25, Pricing Value 23, Product Availability 22,
Product Page 21, Shopping Cart 20, Customer Support 18, Service Desk 18,
Product Overall/Issues 17, Substitutions 14, Payment/Fees 12, Notifications 11.

---

## 3. Walmart AI gateway — the written read

`POST https://puppy-backend.walmart.com/anthropic/v1/messages`, Anthropic
message format, auth `X-Api-Key: <puppy_token>` plus
`anthropic-version: 2023-06-01`. Verified from a plain fetch on 2026-09-25:
200 in 1.8 s on `claude-sonnet-5`. See `MEMORY.md::Walmart AI gateway`.

- The response carries **no `access-control-allow-origin`**, so this only works
  from the service worker, where `host_permissions` exempts the fetch from
  CORS — never from a content script or the shell page.
- **It intermittently answers with extended-thinking blocks.** On 2026-09-25 a
  real call came back `stop_reason: max_tokens, blocks: thinking` with no prose
  at all on a 2,000-token budget — while eight back-to-back probes of the same
  prompt, four from node and four from the service worker, all returned
  `thinking_tokens: 0`. It is not the request shape and it is not the caller;
  the gateway's default simply varies. `thinking: { type: "disabled" }` is
  accepted but is not on its own sufficient, so `lib/narrative.js` sets it,
  budgets 4,000 tokens (the read-out itself is about 1,100), and retries once at
  12,000 when a response comes back as nothing but thinking.
### Where the token lives, and how the extension can get it

Code Puppy stores it with `config.py::set_value("puppy_token", …)`, which writes
`~/.code_puppy/puppy.cfg` — a plain INI file, `[puppy]` section, key
`puppy_token`. Confirmed on disk 2026-09-25.

**An extension cannot read that file on its own.** There is no filesystem API; it
is a sandbox boundary, not a setting. The three routes that do exist:

1. **A file the user picks.** `<input type="file">` is the one filesystem door an
   extension has, and it needs no install. The settings panel has
   **Load from puppy.cfg**: the file is parsed in the page, only `puppy_token` is
   forwarded to the service worker, and the rest of the file (names, model
   choice, colours) is never read or stored. Verified against the real file —
   token extracted, `exp` decoded to 2026-10-05, status green.
2. **A native messaging host** — a registered executable that could read the file
   directly. The suite already has the pattern (`claimsbuddy/native_host/`), but
   it needs an installed binary and a registry entry per machine.
3. **A local HTTP helper** on `127.0.0.1` serving the token, as `incidentintake`
   does with `dev/intake-helper.py`. The manifest already carries
   `http://127.0.0.1/*` and extension fetches are exempt from Private Network
   Access, so the service worker can read it directly — but it means running a
   helper.

(1) is what shipped: no install, no helper, and it beats copying a
1,900-character token by hand.

### Signing in without a paste

Code Puppy's own auth (`code_puppy/plugins/walmart_specific/auth.py`) opens
`https://puppy.walmart.com/authenticate_puppy` and starts a local HTTP server to
receive the result. Two details make this reproducible from an extension:

- The auth site returns the token by **POSTing a form** to that server:
  `http_server.py` answers `@app.post("/save_token")` with
  `puppy_token: str = Form(...)`.
- `urls.py::get_authentication_url` accepts an arbitrary **`callback_url`**
  (it exists for devcontainers) — but see below, the deployed page ignores it.

A form POST cannot be caught by `chrome.identity.launchWebAuthFlow`, which only
sees redirect URLs. It does not need to be. `Form(...)` means urlencoded or
multipart, and both populate `webRequest.onBeforeRequest`'s
`requestBody.formData` — **and that listener fires when the browser forms the
request, before it tries to connect**. Verified 2026-09-25: a POST to a dead port
failed with "Failed to fetch" and the service worker still read `puppy_token`
out of the body, correct length.

So `lib/puppy_auth.js` opens the real sign-in page, lets the user finish SSO, and
reads the token off the wire. Code Puppy does not need to be running, there is no
native messaging host, and nothing is pasted.

**The deployed page ignores `callback_url`.** The first live sign-in logged:

```
Target port: 8090
Attempting to connect to CLI on localhost:8090...
Authentication failed: Failed to fetch
```

— its own default port, against the host `localhost`, despite being passed a
`callback_url`. The module no longer tries to steer it: it opens the page with no
callback parameter and watches the whole of loopback. Letting the page use its
default is also friendlier — a user whose Code Puppy CLI *is* listening on 8090
gets a clean success and a refreshed CLI token as well.

**Two things had to be right for the capture to fire**, and the first live
attempt captured nothing because of them:

- **`localhost` and `127.0.0.1` are different hosts for permission purposes.**
  webRequest never fires for an origin the extension was not granted, and the
  manifest had only `127.0.0.1`. Both are now in `host_permissions`. This fails
  **silently** — no error anywhere, just no event.
- **Match patterns carry no port.** A literal `http://127.0.0.1:53682/*` is
  accepted by `addListener` without complaint and matches nothing. The portless
  form matches every port, which is what is wanted since the page picks it.

Verified against the exact URL the page uses
(`POST http://localhost:8090/save_token`): armed → captured, unarmed → ignored,
stale arming → ignored, wrong path → ignored.

The listener is registered at service-worker top level (the POST lands minutes
after the click, long after the worker that started the flow has idled out) but
only KEEPS a token while a flow the user started in the panel is armed, and the
arming expires after five minutes. Harvesting the credential whenever someone
runs `/puppy_auth` in their terminal would be taking something they did not offer.

**When it does not work, the panel says why.** The two failure modes look
identical from the UI — the status sits on "waiting" — and they need opposite
fixes: either the listener never saw the request (permission or match pattern) or
it saw it and rejected it (wrong path, no field, not armed). Every loopback POST
seen during a flow is logged to `chrome.storage.session` as metadata — host, port,
path, field NAMES, token length, whether the flow was armed, never a token value
— and a failed sign-in renders it under "What the extension saw" together with
the loopback origins actually granted. Handler: `authDiagnostics`.

Expect the sign-in page to show **"Authentication failed — make sure your CLI is
running"** whenever the CLI is not up. That is the CLI hand-off failing, not the
capture; the extension has the token by then and closes the tab. The settings
panel says so, because two contradictory messages on screen at once is otherwise
just confusing. The paste field remains behind a disclosure either way.

### The gateway gates on a CLI version, and blocks with a 200

`x-puppy-version` is read by `puppy_backend_rs::cli_version_blacklist`. Measured
2026-09-25 against the live gateway:

| `x-puppy-version` | Result |
|---|---|
| *(header absent)* | **blocked** |
| `0.1.61` (the CLI installed here) | **blocked** |
| `0.1.70`, `0.2.0`, `1.0.0`, `99.99.99` | passes |

So there is a floor between 0.1.61 and 0.1.70, and **sending no header is also
blocked** — Code Puppy's own `puppy_version_header.py` says an absent header
lets the backend spot a client "so old it never sent the header at all".

**The block is HTTP 200 with the notice as the assistant's text.** Nothing
errors, nothing is non-200, and the `content` array holds a normal text block
reading "Hey there! Your Code Puppy CLI is out of date…". Without an explicit
check the module would store that as the store's Cx read and render it in the
panel and the PDF as a finished analysis. `lib/narrative.js::BLOCKED_RE` catches
it and raises `errorClass: "BLOCKED"` with instructions instead.

The version sent is a **visible setting** (`gatewayClientVersion`, default
`DEFAULT_CLIENT_VERSION` = 0.1.70) rather than a buried constant: this module is
not the Code Puppy CLI, and that header is the only way any client identifies
itself to the gateway, so what gets sent should be in plain sight and editable
when the floor moves.

Note the pattern across this whole module: **this stack signals failure in the
body, never in the status.** Medallia answers 200 wrapping a 401, the gateway
answers 200 wrapping a version block, and the gateway also answers 200 with
thinking-only content. Check the body.

- The token is a JWT that **expires** (the one on this machine: 2026-10-05).
  Code Puppy keeps it in `~/.code_puppy/puppy.cfg`, which an extension cannot
  read, so the module takes it in Settings and stores it device-local. It
  decodes `exp` locally to warn before it lapses, and the panel says plainly
  when the narrative is unavailable rather than silently showing nothing.
- The narrative is **optional**. Every number and every ranked theme in the
  module is computed locally first; the gateway is handed that finished summary
  plus capped verbatims and asked to write it up, so it cannot invent a figure
  the panel does not already show.
