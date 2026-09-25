# BoB and Lisa — findings (2026-09-14)

Wire-level facts behind `modules/boblisa/`, the missed-item finder. Recorded
on store 1458, EJ Viewer store-days 2026-09-01 → 09-07 (probe) and 09-07 →
09-13 (first live run in the module).

## The pattern

A cashier on a manned lane (POS 9–25) misses an item, usually a bulky one.
The door host catches it; the customer pays for it in a second transaction
1–15 minutes later with fewer than 5 items, often at self-checkout. The door
host frequently prints a **training-mode receipt** for the missed items.

Two catches in the probe week matched exactly:

| Date | Missed at | Cashier | T1 | Paid later | Training receipt |
|---|---|---|---|---|---|
| 9/3 | Reg 25, TR 2419, 14:32 | op 155 | 69 items, $399.45 | SCO 31 at 14:35, Charmin 12XXL $23.83 | Reg 98 at 14:36 |
| 9/6 | Reg 21, TR 1243, 15:58 | op 3859 | 44 items, $211.20 | SCO 31 at 16:01, Pedigree Adult $25.97 | Reg 94 at 16:07 |

## EJ facts the search depends on

- **Whole store-day in one call.** `POST /api/v1/receipts/US/<site>/<MM-DD-YYYY>`
  with `registerNumber: ""` returns every receipt for the day: 7–9k records,
  ~10.7 MB, ~13 s. (Per-register pulls are what `registerls` does.)
- **Customer link = `TOKEN: <44 hex>`** on card receipts. Same token = same
  customer (analyst's rule). ~55% of sales carry one. Cash sales have none.
- **Training-mode receipts** print `**** INVALID RECEIPT - TRAINING ****`
  (and `*** TRAINING MODE STARTED ***`), total $0.00, at the Money Center
  registers 92–94 and the Vision Center 98 (seen: 93, 94, 98 with op 9025;
  92, 94 with ops 9052/9053). **Never match on the word TRAINING** — puppy
  "TRAINING PAD" items give ~100 false hits a week; the real banner appears
  ~3–4 times a week.
- **Register map (store 1458):** 1–8 and 27–34 self-checkout (op = 9000 +
  register); 9–25 manned; 62–63 and 92–94 Money Center; 82 OPD dispense (op 9998);
  92–94 Money Center; 95 Automotive; 98 Vision Center (the only one).
  `modules/boblisa/lib/registers.js` holds the ranges.

## Rules (from the analyst)

- T2 = same token's next sale 1–15 min later, < 5 items, **≥ $3** (gum and
  drinks are often rung separately).
- A T2 UPC that is also on T1 **stays a hit** (one of two waters missed).
- First transaction on 9–25 → "Manned" tab (cashier miss). Anywhere else →
  "Unmanned" tab (a second trip after self-checkout can be theft).
- T2 on 98 (Vision Center) is flagged **Vision**.
- Training receipts with **no** paid sale of the item within 15 min get
  their own tab — the item was handed back, or it left unpaid.
- Money Center T2s (bill pay, card payments, debit loads) are hidden by
  default on both tabs. So is Automotive (95: tires and service) — a
  separate purchase, not a missed item (2026-09-15).
- Back-to-back sales on the **same register under 2 minutes** apart are one
  customer ringing twice, never a miss — excluded outright
  (`pairs.js` `sameRegisterMinGapSec`, 2026-09-15).
- **Money services are not merchandise** (2026-09-15): bill pay, debit /
  credit card loads, money orders and gift-card activations (`ARBYS DEBIT
  $35.00`, `VISA $7.84`, `DEBIT LOAD $35.00`) cannot be a missed item. A
  transaction made only of them never pairs, as T1 or T2, whatever register
  it was rung on; on a mixed receipt only the merchandise lines count toward
  the item limit and the $3 floor, and they are tagged "money service" in
  the item list. The EJ marks these lines with sale-type flag `K` (DEBIT
  LOAD, WMMC RELOAD, AMOUNT, ONE SECURED); bill pay and money orders come
  through as `S` with 12-char descriptors (VNLLADPAYAMT, CFPRENBILFEE, WU
  MONEY ORD, RIA RCV AMT), so `pairs.js::isServiceItem` checks both
  (`skipServices` option; analysis schema 5).

## Documented misses (2026-09-15)

The analyst's record that a cashier missed an item lives in
`lib/misses.js`: a snapshot of the pair plus cause, how it was caught, video
review, cashier name and a note drafted from the receipts. One object per
store (`boblisa.misses.<store>`) so it survives `clear_cache` and re-pulls.
The "Documented misses" tab rolls records up per cashier op and exports one
CSV to `Downloads\APAISuite\boblisa\<store>\`. "Find APPRISS video" reuses
registerls' Open Drawer search (`link_video`) for transaction-id CCTV and
receipt links, falling back to the nearest drawer open within 90 s.

## Noise level

Bare rule (token + window + item count + $3): ~55 pairs/day, of which ~7–14
are manned. Same-register-same-cashier pairs are mostly ordinary add-ons.
The training-receipt anchor and "T2 is one bulky item at self-checkout after
a 40+ item manned order" are what separate real misses.

## Extension mechanics

- **Analyze in the tab, not the SW.** Returning 10 MB of records through
  `chrome.scripting.executeScript`'s result channel hangs. `lib/ej_day.js`
  injects `content/ej_day_bridge.js` (which dynamic-imports `lib/pairs.js`
  via `web_accessible_resources` for `https://ej.walmart.com/*`), then runs
  the fetch + `analyzeDay` in the page and returns ~30 KB per day.
- **Frozen tabs hang executeScript forever.** Edge freezes background tabs
  after a few idle minutes (`chrome.tabs.Tab.frozen === true`). The module
  opens a fresh inactive tab per pull and reloads it if it froze between
  days. `registerls/lib/ej.js::openEjSession` reuses an existing EJ tab and
  is exposed to the same hang — fix there when convenient.
- **Video without a transaction id.** The APPRISS CCTV viewer
  (`/walmart-usa/video/react#/cameras`) has a second mode the Explorer never
  exposes: `?storeNo=<store>&posNo=<register>&startTime=<ISO local>&endTime=<ISO local>`
  (verified 2026-09-14: `getcameras?storeNo&posNo` then
  `getcameraconfiguration?storeNo&posNo&startTime&endTime&providerName`;
  the server pads 30 s before / 120 s after). `lib/video.js` builds it from
  the receipt's trailing timestamp. The Open Drawer route (id per TR#) only
  covers drawer-opens, i.e. cash, so it was dropped from this module.
- **APPRISS signs itself back in (2026-09-25).** `link_video` and
  `lookup_names` go through `apprissAuthGate({ moduleId: "boblisa" })`
  (`shared/appriss.js`): an `AUTH` / `AUTH_OR_HTTP` result drives ONE
  background SAML tab (`APPRISS_HOME`, adopted if the analyst already has
  Secure open, closed again if we opened it) and then retries the same call.
  One reauth per gate, so an 80-drawer name run costs at most one tab, and a
  non-auth failure (HTTP 500, empty search) never opens one. Before this the
  module had no reauth at all — every first lookup after the browser started
  came back "APPRISS session expired" and the analyst opened Secure by hand.
  The mechanics were lifted out of `registerls/lib/workview.js`, which now
  delegates to the shared helper.
- **Storage.** `boblisa.day.<store>.<date>` = the per-day analysis only
  (pairs, trainings, stats). Raw records are never stored. `boblisa.range`
  remembers the last date range; `boblisa.storeOverride` the manual store.
