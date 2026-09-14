# Build prompt — Register Long/Short Triage module (`registerls`)

Written 2026-09-12 after reconnaissance of the three sources
(`dev/REGISTER_LS_FINDINGS.md`) and the user's answers. This is the prompt
that was run to build the module. Everything below is the spec; the
findings doc is the wire-level reference.

## Goal

An APAISuite module that clears the APPRISS WorkView register long/short
queue of noise and points the analyst at the shortages that deserve video.
For every open long/short work item at the user's store it must answer, on
one screen: *is this a till flip or bounceback (nothing found), or an
unmatched shortage — and if unmatched, who was on the register and is there
a single cash transaction that explains the amount?*

The user's own examples define the verdicts:

- Register 63 is $81 short and 62 is $83 over on the same day → tills checked
  in as each other → **nothing found**.
- Register 95 short $100 Monday, over $100 Tuesday → same-register
  bounceback → **nothing found**.
- Register 75 short $40, exactly one $40 cash transaction that day → **watch
  the video of that transaction**.

## Decisions already made (do not re-ask)

1. **New module** `modules/registerls/`, sidebar name "Register L/S Triage".
   Reuse the Live Dashboard register engine by importing
   `fetchRegister`, `runMatching`, `rollup` from
   `../livedashboard/lib/sources/register.js`. Do not copy that code, do not
   edit it.
2. **Dispositions are recommend-only in this build.** The tool produces the
   verdict and a disposition text ready to paste, and deep-links the work
   item. One-click disposition comes later, after a real disposition has been
   recorded with the request logger (the endpoint is unknown; see findings §1).
   Leave a clearly marked seam (`lib/workview.js::dispositionWorkItem` throwing
   "not captured yet") so it slots in.
3. **Evidence on an unmatched shortage = everything:** EJ cash tenders near
   the amount, who was on the register (EJ sign-ons + Power BI shifts), the
   10-day Cash Research ledger, and voids / no-sales / post-voids from EJ.
4. **Store = the suite's user home store** (`shared/userStore.js::getUserHomeStore`),
   with a per-module override field in the toolbar. Only long/short work
   items are analysed: `sourceAppId` `mel` with category "Action Required:
   Long/Short Item", and `sourceAppId` `overshort` (category prefix
   "Long/Short"). Other WorkView types are counted in the header ("+N other
   items in WorkView") but not listed.

## Sources and how to reach them (all from the service worker)

- **WorkView list** — `POST {APPRISS_BASE}/platform/workview/api/v2/workviewItems`
  with `credentials: "include"` and the JSON body in findings §1; window =
  last 30 days (WorkView items appear up to 11 days after the L/S). Parse
  the unique id `store|register|date|amount` from `subjects[]`; take the
  signed amount from the `Item Amount` card section. Detail link
  `{APPRISS_BASE}/platform/workview#/detail/<id>?id=<id>`.
- **Power BI grid + shifts** — `fetchRegister(storeNbr)` (opens/reuses the
  report tab itself, handles reauth, closes what it opened). Returns
  `{ ok, discrepancies[], capturedAt, … }`; `runMatching(discrepancies)` gives
  findings keyed by primary (register, date) with `matchType`,
  `flipConfidence`, `matchedAgainst[]`, `severity`, `displayPriority`, `reason`.
- **Cash Research Search** — `POST` to the APPRISS `getsearchresults` endpoint
  using `modules/aurorbuddy/lib/appriss_http.js::postJson` (import it; do
  not copy). Body and columns in findings §1. One call per register, 10
  trading days.
- **EJ receipts** — `GET https://ej.walmart.com/api/v1/isp-token` then
  `POST https://ej.walmart.com/api/v1/receipts/US/<site>/<MM-DD-YYYY>`. The
  POST needs the token plus the mandatory headers recorded in findings §2
  (the bare body is rejected with "Missing Mandatory headers"). Try from the
  SW first; if the SW call fails auth, fall back to `chrome.scripting.executeScript`
  in a background `ej.walmart.com` tab (`withTempTab`) where the page's own
  cookies and headers apply. Add `https://ej.walmart.com/*` to
  `manifest.json` host_permissions.

Every source pull must classify auth failures (HTML login page, 401/403)
into `{ ok:false, errorClass:"AUTH", loginUrl }` so the view can show a
"sign in" button per source instead of a generic error. Reuse
`shared/auth.js::classifyAuthResponse`.

## Module layout

```
modules/registerls/
  module.js            fullpage, icon, handlers, permissions.hosts documented
  service.js           handlers: refresh_queue, refresh_grid, analyze_item,
                       get_state, set_store_override, clear_cache
  view.js / view.html / styles.css
  lib/workview.js      fetchWorkItems(storeNbr, {days}), normalizeWorkItems(json) [pure]
  lib/cash_research.js fetchCashLedger(storeNbr, registerNbr, days), decodeLedger(json) [pure]
  lib/ej.js            fetchReceipts(site, dateIso, registerNbr)  (token + POST, fallback tab)
  lib/ej_parse.js      parseRecords(records) [pure] → { transactions, signons, dayStats }
  lib/evidence.js      buildEvidence({ item, finding, ledger, ej }) [pure] → verdict + bullets + disposition text
  lib/tests/*.test.mjs node:test suites for every pure function, using the
                       real captured shapes (a WorkView item, Cash Research rows,
                       EJ records) as fixtures
```

Storage keys (raw `chrome.storage.local`, prefixed `registerls.`):
`queue` (items + fetchedAt), `grid` (discrepancies, findings, capturedAt,
storeNbr), `analysis.<workItemId>` (evidence + at), `storeOverride`.

## Analysis rules

**Verdict per work item** (`lib/evidence.js`):

| verdict | when | disposition text |
|---|---|---|
| `flip` | grid finding `nearby-register-offset` with `flipConfidence ≥ 0.70` | "Nothing found — till flip: reg {A} short {amt} / reg {B} over {amt2} on {date}. Offsetting entries, no loss." |
| `bounceback` | `same-register-bounceback` with `flipConfidence ≥ 0.70` | "Nothing found — reg {A} short {amt} on {d1}, over {amt2} on {d2}. Drawer count corrected, no loss." |
| `suspect_flip` | a match exists but `flipConfidence < 0.70` | recommend review; list the candidate match and why it is weak |
| `unmatched` | finding `matchType:"none"` | recommend review; evidence sections below decide `watch_video` |
| `no_grid` | Power BI has no cell for that register-day (or grid not pulled) | say so; still run EJ + ledger |

**Evidence for `unmatched` / `suspect_flip`:**

- **Cash-tender match:** transactions on that register-day whose `CASH TEND`
  total, `CHANGE DUE`, or `TOTAL` is within the engine's tolerance (±$5 under
  $100, ±5% over) of |amount|. Exactly one match → `videoCandidate` with
  time, operator, TC#, and the tender line; zero → say "no cash transaction
  near {amt}"; many → list up to 5 with times.
- **Who was on the register:** distinct operators from EJ sign-on/sign-off
  records (`is16` records; name after the operator number) with first/last
  times, merged with `finding.operators` / `discrepancy.operators` from the
  Power BI shifts. Show as a timeline.
- **Ledger (10 days):** table of trading day, finalized L/S, cash advances,
  pickups, till check-ins/outs; highlight the item's day and any other
  non-zero L/S in the window (repeat pattern → severity bump).
- **Red flags from EJ:** `** VOIDED ENTRY **` lines, post-voids, no-sale /
  drawer-open records, refunds paid in cash (`CASH TEND` negative / change
  due with no items), and cash transactions with change due ≥ $20.

Amounts are integers in cents; register and store numbers are strings.

## View

Two panes. Left: the queue — one row per L/S work item: date, register,
amount (red short / green over), verdict pill, SLA (overdue / days left),
"View in APPRISS" link. Header: store field, "Refresh WorkView", "Refresh
Power BI" (with captured-at), a "show nothing-found" toggle (flips and
bouncebacks hidden by default, count shown), and per-source auth pills.
Right: the selected item — verdict banner with reason, "Copy disposition
text", evidence sections in the order above, "Analyze" (runs
`analyze_item`; cached result shown with its timestamp and a re-run button),
links to open the work item, the EJ viewer, and the Power BI report.

Follow `docs/MODULE_CONTRACT.md` (namespaced storage, unsubscribe in
cleanup, `.module-registerls` scoping, design tokens from
`styles/tokens.css`). Empty/loading/error states for every pane.

## Wiring

- `modules/_registry.js`: import + array entry directly after `aurorbuddy`.
- `manifest.json`: add `https://ej.walmart.com/*` host permission.
- `docs/AI_CONTEXT_BRIEF.md`: add the module row. `docs/CURRENT_TASKS.md`:
  correct the stale "Register Long/Short (E): no probe yet" note and add a
  short entry for the disposition-capture follow-up.

## Verification

- `node --test modules/registerls/lib/tests/` green.
- `node --check` every new file.
- Load the extension (edge://extensions reload), open the module, refresh
  WorkView and Power BI for the user's store, analyze the $81 short on
  register 63 (2026-08-27) and report what the tool concluded.

## Amendments made while running the prompt (2026-09-12)

- **Neighbouring registers only.** The engine's default offset window (99
  registers) paired reg 63 with reg 12 and called the $81 short a "probable
  flip". The analyst's rule: 62↔63 flips, 63↔12 does not. The module now
  passes `lib/match_opts.js::MATCH_OPTS` (`nearbyRegisterRangeDelta: 3`) to
  `runMatching`; the engine itself is untouched.
- **All open work items.** The queue lists every open WorkView item for the
  store, not only the register ones — a second "Other open work items" group
  with a card/tag detail and the APPRISS link. Analysis still runs only on
  long/short items.
- **Cash Research window** is anchored to the item's date (today − date + 4
  days, 10–60), since the search counts trading days back from today.
- **Reversal pairs** (equal-and-opposite finalized L/S within 3 days, i.e. a
  till checked out one day and in the next) are excluded from the "repeat
  pattern" flag.
- **Operator ids** from Power BI are zero-padded ("0193"); EJ's are not.
  Normalised before merging the operator timeline.
- Shell facts learned: `host.ui.delegate(root, event, selector, fn)`;
  `host.messaging.send` rejects on `ok:false` (use `sendRaw` to keep the
  handler's `loginUrl`); the Power BI capture needs `keepAwake`.

First live result (store 1458, reg 63, 2026-08-27, −$81): unmatched; one cash
transaction with change due $76.00 at 18:56:31 flagged for video; $66 short on
the same register three days earlier surfaced as a repeat.

## Second pass (same day): readable board + fill-in-APPRISS

User feedback: output hard to read; wants to see what we classify each item
as and why, click to fill the work item from the suggestion, and for items
we can't safely classify, the details most likely to matter.

- View rebuilt as a triage board: summary strip (need a look / ready to
  close / not analyzed / other open items), grouped queue with a one-line
  why per row, and a detail card: what we think → why (bullets) → action →
  suggested disposition (reason + editable text) → "what to look at"
  ordered video candidate, cash matches, operators, red flags, ledger.
- `lib/dispo.js` drives the real WorkView form (recorded in findings §1):
  Start Work → Disposition → reason picker → More Information. Never clicks
  Complete. Flips/bouncebacks → Process Errors; others → Not Identified
  placeholder with the evidence text.
- `analyze_all` handler + button; analyses carry a schema number so shape
  changes re-run instead of serving stale caches.

## Third pass (same day): the analyst's shortage model + wider grid

- **Cash-in only.** A shortage is cash the register recorded as received that
  never reached the drawer (fraudulent card keyed as cash, short-change,
  pocketed tender). Candidates are transactions whose cash tender, or net
  cash after change, is near the amount. Change due and refunds are cash
  going out that the register expects to be gone — never matched. "Cash and a
  card on one receipt" is flagged as the declined-card pattern.
- **No disposition without a found cause.** Only flips/bouncebacks get a
  one-click fill (Process Errors). Review items keep investigation notes and
  a cause picker; Fill in APPRISS is enabled only once the analyst chooses
  the cause (Internal Theft, Process Errors, …).
- **Power BI window.** The report filters `action_date` with one literal per
  day copied from the slicer (19 days on capture). The engine now accepts
  `{ days }` and rebuilds the list; the module asks for 60 so every WorkView
  item (30-day queue + 11-day lag) has a cell. Small, default-preserving edit
  to `livedashboard/lib/sources/register.js`.

## Fourth pass (same day): the whole queue, and overages

- WorkView pages 20 at a time and filters by date; the first pull saw 7 of 87
  open items. `fetchWorkItems` now walks every page of both the New and the
  assigned views, two years back.
- Most open items are `overshort` "Cash" work items, and half of those are
  overages. The register engine only scores shortages, so the module now
  feeds the WorkView items themselves into the match (union with the Power
  BI cells — WorkView reaches further back than the report's ~60 days) and
  scores the overage half of every pair via `findCounterpartFinding`.
  Result on store 1458: 37 of 82 register items are clean pairs, filed from
  the match alone; 45 need a look, 8 with a single cash-tender candidate.
- Analyze all skips clean pairs; analyses are invalidated by a new grid.

## Fifth pass (same day): the till check-in/out log

New source: Power BI "Cash Recycler" (reportId 59fc9ae6-…), the per-event
till log with the associate. Captured/replayed like the long/short report
(findings §4), 60 days, paged with RestartTokens. Used three ways: (1) a
store-wide "Till handling" panel listing tills moved between registers by
the same associate; (2) per item, the till timeline (±1 day) and who handled
it; (3) cash advances near a shortage — surfaced as an overage elsewhere →
verdict flip "advance carried to another till" (the legitimate far-register
exception, filed as Process Errors naming the associate); not surfaced →
severity high and the carrier named. Overages never get video candidates.

## Sixth pass (same day): per-source reasons, cashier ledger

- "Fill in APPRISS" failed silently on "Long/Short - Cash" items: their
  reason list is different (Process Error - Till Check-Ins / Cash Advances /
  Cash Pickups / …), and the picker is paged. `lib/reasons.js` maps the fill
  per source; the driver types the reason into the picker's Filter box.
- Cashier ledger (`lib/cashiers.js`): per-associate $ involved and error
  types (till moved, advance to wrong register, advance never surfaced, quick
  re-check-in, override, handled a till with an unmatched shortage), built
  from the cached sources; coaching notes persisted per WIN; "Export" writes
  one CSV per associate to Downloads\APAISuite\cashiers\<store>\ via
  chrome.downloads (events + coaching log). Shown as a collapsible panel.

## Seventh pass: direct responsibility only

User rule: a cashier's ledger shows only what they were directly responsible
for. Removed "handled a till with an unmatched shortage" (exposure, not
blame). Till moves are now orphan pairs (a register whose till never came
back + a register that received a till never checked out to it), charged to
the check-in associate; the old same-person check-out→check-in pairing flagged
cash-office staff doing their job. An advance is not "missing" when the
shortage is already a flip/bounceback. Store 1458: ledger went from 24
associates / $7,066 to 3 associates / $664, each for one specific act.

## Eighth pass: verify, then complete in the background

"Complete in APPRISS…" opens a verification dialog (item, reason, editable
More Information, acknowledgement checkbox); on confirm the service worker
runs Start Work → Disposition → reason → text → Complete in a background tab
it opens and closes itself, never focused, then drops the item from the
board and logs it to `registerls.completed`. Flip pairs now name who checked
the tills in (one person on both = charged as "flipped check-ins"; two = named
only; SCO pairs unattributable).

## Ninth pass: tiers, near-misses, permanent ledger

- Matching runs in tiers (`lib/matching.js`): tier 1 strict (±$5/±5%) claims
  its pairs; tier 2 (±$10/±10%) runs only over what is left and is never
  auto-filed — a $331 short vs $350 over shows as "weak offset, $19 apart".
- The cashier ledger is permanent (`registerls.ledger`): every attributed
  event is merged in when seen and never removed; completed work items
  (`registerls.completed`) keep feeding it while the till log covers them.
  Panel has a From/To date range and "All time"; exports honour the range.
- First real completions ran from the module on 2026-09-13 (reg 93 07-26 as
  Till Check-Ins, reg 6 09-02 as Cash Advances).

## Tenth pass: "Disposition button not available"

Cause: the item had already been dispositioned in APPRISS (toolbar shows
Reinstate) while the board's cached queue still listed it; the driver also
judged the toolbar from its first paint, which lags in a background tab.
Now: the driver waits for the toolbar and distinguishes new / mine /
assigned-to-someone-else / already dispositioned; an already-closed item is
dropped from the board with a toast instead of an error; the queue re-pulls
itself on open when older than 30 minutes. Note: a dry run still clicks
Start Work, so tested items end up assigned to the tester.

## Eleventh pass: "opening the extension does not load the data"

Cause: opening the module auto-pulled only WorkView. In a profile with
nothing cached (the analyst's everyday Edge, not the debug one) the board
sat on "Power BI: not pulled / Till log: not pulled" with nothing analyzed
until three more buttons were clicked.
Now: `view.js::bootstrap()` runs on every open and pulls, in order, whatever
is missing or stale — WorkView (older than 30 min), Power BI grid and the
Cash Recycler till log (older than 6 h) — then runs `analyze_all` so the
detail pane has the cash ledger and journal ready. Measured on store 1458
from an empty cache: the three pulls finish in about 100 s, analysis of 49
items in about 6.5 min, progress shown in the header. `clear_cache` now
keeps the cashier ledger, coaching notes and the completed log (they are
records, not cache).

## Twelfth pass: video on every transaction, CFTs, cash-outs

Ask: "finish the video integration" and add the Cash Fund Transfers report.
WorkView has no video on L/S items; APPRISS video keys on its own
transaction id, which the EJ lacks. The Open Drawer supporting search
(already linked from every L/S item) returns every drawer-opening
transaction with that id, so `analyze_item` now pulls it alongside Cash
Research and EJ and every cash match / investigation candidate / red flag
carries ▶ Video and Receipt buttons (join on TR#, fallback on end time).
The full drawer-open list is shown with cash in / cash out flagged near the
amount; a cash-out of the shortage amount with nothing tendered is its own
`cashout` bullet (refund/payout shape). CFT report: captured, replayed with
store + date, 165 rows for 1458; CFTs near the amount within a day before to
a week after are offered as a cause with who/why/when keyed and a "keyed
late" mark — never auto-filed (the report has no register column). Also
fixed: view.js had been re-saved as cp1252 + CRLF by another tool, which
rendered "·" as "�"; restored to UTF-8 + LF. ANALYSIS_SCHEMA 6. 59 tests.

## Thirteenth pass: analysis speed

Measured per item: Open Drawer 0.4 s, Cash Research 0.3 s, whole
`analyze_item` 6.7 s — the EJ pull opened and closed an ej.walmart.com tab
every time (the SW fetch path always fails auth first). Now `analyze_all`
opens one background EJ tab for the run (`ej.js::openEjSession`), runs three
items at a time, and the SW path is skipped for 15 min after an auth
failure. Forced full run on store 1458: 56 items in 99 s (was ~6.5 min for
49). A single "Analyze" on one item still uses the temp-tab path.

## Fourteenth pass: who gets charged for a flip

User: registers 1–8 and 27–34 (no till check-ins in the log) are
self-checkouts; "should be a lot more cashiers listed for errors". A flip
means each till landed on the other's register, so with two closers both
check-ins were wrong: each is now charged their own side (`flipCheckins`
`both`, `cashiers.js`), instead of nobody. One person doing both check-ins
is still charged the pair. Self-checkout lanes are detected from the log
(`registerKind`: desc "SCO", or rows but never a check-in) and the
"who swapped them" line says so instead of guessing; a date older than the
log says that. Grid-only flip pairs feed the ledger (agent pass). Store
1458 ledger went from 3 cashiers / 3 events to 26 / 60. The till log keeps
~60 days; completed items older than that cannot be attributed.
