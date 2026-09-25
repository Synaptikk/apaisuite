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
- The token is a JWT that **expires** (the one on this machine: 2026-10-05).
  Code Puppy keeps it in `~/.code_puppy/puppy.cfg`, which an extension cannot
  read, so the module takes it in Settings and stores it device-local. It
  decodes `exp` locally to warn before it lapses, and the panel says plainly
  when the narrative is unavailable rather than silently showing nothing.
- The narrative is **optional**. Every number and every ranked theme in the
  module is computed locally first; the gateway is handed that finished summary
  plus capped verbatims and asked to write it up, so it cannot invent a figure
  the panel does not already show.
