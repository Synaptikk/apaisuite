# StockingPlan — where the numbers come from, and why the module shows them

Research behind `modules/stockingplan` 0.3.0 (2026-09-19).

No associate names, no sender details: the twelve plans and the 44 days of
schedule this is built on are real, the repo is public, so only aggregates and
job codes are written down here.

---

## 1. What a stocking plan actually is

Twelve plans sent for store 1458 between 2026-08-10 and 2026-09-18 were read
back out of Outlook. Every one of them has the same four blocks, in this order:

```
Stock 2          unload/downstack trucks, then GM areas with hours
                 ("stock toys-2.5 hours", "stock sporting goods-2 hours",
                  "stock automotive-2 hours", "stock hardware-3.5 hours")
Overnight        the food/consumables list, largely without hours
                 ("stock 90/91/97", "stock grocery", "stock 4/8/13/79",
                  "stock 2/40/46", "stock 82", "stock McLanes"),
                 plus the GM areas that spill over, WITH hours
                 ("stock home-12.5 hours", "stock 3/19/67-4 hours")
Mod Team         specific mods by dept + category ("D82 cat 331/615/643")
Stock 1          the NEXT morning: topstock rounds (A/E/J), leftover GM
                 freight, seasonal — i.e. whatever the night didn't reach
```

Three things follow directly, and the module is built on them:

1. **The unit of planning is hours of freight, not cases.** Every instruction
   that carries a number carries it in hours.
2. **The plan is a cascade across three shifts on two business dates.** Stock 2
   and Overnight are date D; Stock 1 is date D+1.
3. **The Mod Team block appears if and only if modular associates are
   scheduled.** 9-12 and 9-18 had zero `1-635-7441 Modular ON TA` hours and
   neither plan has a Mod Team block; every other plan in the window had mod
   associates scheduled and a block. The one exception proves the rule from
   the other side: 8-10 had 3 mod associates scheduled and the plan reads *"No
   mods tonight — help with the freight. Only night we can do this for this
   week."*

Qualitative sizing shows up constantly — "very heavy", "extremely light",
"only 15 hours", "pretty light tonight", "I would use 7 associates tonight",
"need 3 people in home tonight". That is a human doing in their head exactly
the arithmetic the Labour card now does on screen.

---

## 2. The shift day

`Main.ashx?func=init` returns `schedule.scheduled_associates` with
`shift1_job_code` and real start/end timestamps. For business date D at 1458:

| Job code | Description | Shift |
|---|---|---|
| `1-695-7550` | Stocking 1 TA | 06:00 D → 15:00 D |
| `1-695-7540` | Stocking 2 TA | 14:00 D → 23:00 D |
| `1-635-7440` | Stocking ON TA | **22:00 D → 07:00 D+1** |
| `1-635-7441` | Modular ON TA | 22:00 D → 07:00 D+1 |
| `1-995-710` | Maint Assoc ON | 22:00 D → 07:00 D+1 |

Verified on `shift_start_ts` / `shift_end_ts`, not inferred. The overnight
crew's shift is stamped against date D even though most of it is on D+1 — so
the morning crew a plan hands work to is **D+1's** `Stocking 1 TA`, which is a
second `func=init` call. That is why `onCollect` pulls two business dates.

The full job-code table (everything the store schedules, 44 consecutive days)
lives in `modules/stockingplan/lib/shifts.js`. Unmapped codes fall to `other`
and are flagged rather than silently counted as stocking capacity.

---

## 3. Labour vs freight, over the plan dates

Scheduled hours are net of the scheduled meal, team leads and coaches excluded
(they run the shift, they don't work freight). "Required" in this table is a
truck-case proxy — cases from `sdl` at the module's 55/45/80 case rates —
because the live per-department times are only available for the current day.

| Plan | Stock 2 | Overnight | Mod | Stock 1 next day | Required (proxy) | S2+ON ÷ required |
|---|---|---|---|---|---|---|
| 08-10 | 65 | 190 | 24 | 71 | 168 | 1.52 |
| 08-27 | 76.5 | 240 | 16 | 71 | 185 | 1.71 |
| 09-02 | 56 | 207 | 24 | 80 | 196 | 1.34 |
| 09-06 | 56 | 200 | 24 | 70 | 205 | 1.25 |
| 09-08 | 60 | 207 | 24 | 70 | 162 | 1.65 |
| 09-12 | 56 | 216 | **0** | 72 | 183 | 1.49 |
| 09-13 | 54 | 216 | 16 | 71 | 174 | 1.55 |
| 09-14 | 63 | 206 | 16 | 70 | 154 | 1.75 |
| 09-15 | 56 | 222 | 24 | 71 | 171 | 1.63 |
| 09-16 | 58.5 | 222 | 24 | 64 | 168 | 1.67 |
| 09-17 | 70.5 | 214 | 16 | 64 | 260 | **1.10** |
| 09-18 | 58.5 | **192** | **0** | 71 | 231 | **1.09** |

The two plans at the bottom of the ratio column are visibly the two hard
nights, and they are the two the module is really for:

- **09-17** — heaviest truck day in the window (13,817 cases). The plan warns
  *"grocery — several aisles are very heavy tonight"* and hands D18 seasonal,
  about 8.5 hours of freight, to Stock 1 the next morning.
- **09-18** — second-heaviest (12,361 cases) against the *lowest* overnight
  headcount in the window (24 associates / 192h) and no mod team. The plan
  opens with *"catch up on the 4 unworked home pallets where possible"*,
  hands Stock 1 two named jobs with explicit associate counts (*"3/19/67 — 6
  hours … 2 associates"*, *"D18 seasonal … 2 associates"*), and closes with
  *"It's going to take another gear we need to find to not keep chasing the
  freight."*

Everything at 1.25 and above had room in it for mod sets, topstock rounds and
reworking existing backroom pallets. So the thresholds in `shifts.js` are:

```
ratio < 1.10   → "short"   the night does not cover the freight on its own
ratio < 1.25   → "tight"   freight and little else
otherwise      → "ok"      room for mods, topstock, backroom catch-up
```

One night is outside this model on purpose: **09-16** reads *"need all
associates to leave an hour early"* on all three blocks. A budget cut lands as
scheduled hours that are never worked, and nothing in `func=init` says so — the
schedule still shows the full shift. If that becomes common the module needs a
"trim N minutes per associate" input.

---

## 4. Where the freight breakdown actually lives

`main.html` only renders the seven-row area roll-up (`#summaryTableByArea`).
The detail is shown by two child pages, `casesByDept.html` and
`casesByAisle.html`.

**Do not open them.** Neither page has any data of its own — both re-read
`main_json` and `psn_apiJson` out of sessionStorage and then call functions
`main.html` has already loaded (`calc.js`, `config.js`, `psn.js`). Opening
them with `window.open` also **steals focus**: Chrome fronts a window opened
that way even when the opener is a background tab, so collecting threw the user
out of the suite and onto CaseVisibility, twice per run.

So the module runs their arithmetic in the main page instead:

| Child page | What the module does instead |
|---|---|
| `casesByDept.html` | Same seven area buckets, same `calc_getCountsByDept` + `calc_getStockingHoursByDept` per department, same `psn_checkIncludeInPlanOrNot(loadID, date)` filter. |
| `casesByAisle.html` | Same `POST ../ashx/AisleLocation.ashx?func=getUniqueAislesAndLocationsFromSqlSvr&storeNbr=N` with `upcList=…`, same dept 92/95 scope, same allowed shipment types (`RDC HVDC MP MPDD F FDD MK MILK CANDY`). |

Verified against what the pop-ups produced for the same store-day: store total
262.1h vs 262h, every area to 0.1h, aisle totals 49.7h vs 49.8h.

### The trap that cost an hour

CaseVisibility declares its **functions** with `function` (so they land on
`window`) and its **department tables** with `let`/`const` — which are lexical
globals and *not* window properties:

```js
window.config_getDeptNbrsByArea   // → function
window.config_deptGrocFDD         // → undefined  ← let/const
config_deptGrocFDD                // → [90, 91, 97]
```

Reading them off `window` returned undefined, and grocery, frozen/dairy and
meat/produce came back **silently empty** — a plausible-looking 155h store
total instead of 262h. Bare identifiers with a `typeof` guard is the fix, plus
an explicit throw naming any area list that came back missing, so the next
version of the page fails loudly instead of quietly losing a third of the
freight.

Two smaller ones from the same rewrite:

- `psn_apiJson` rows carry `load_id` but **no** `trailer_id`. The store talks
  in trailer numbers ("RDC 192589"), so the pairing comes from
  `main_json.sdl`.
- Items with more than one aisle location would double-count if each aisle's
  UPC list were summed independently. There were none in the sample, and the
  module assigns each UPC to its first location regardless.

**The three levels are nested, never additive.** Area totals are the store
total; departments break down their area; D92/95 aisles break down two
departments inside Food (Non-FDD). Required hours are summed from the area
totals only, and the UI says so in the table footer and the rates note.

CV's own estimate is preferred over the module's 55/45/80 case rates wherever
it is present (`requiredBasis: "cv"`). The rates stay as the fallback.

---

## 5. Repro

Everything above came from the live pages over CDP against the debug Edge
(`dev/launch-edge-debug.sh`, port 9222 — see the memory note on that route):

- Outlook: `outlook.cloud.microsoft`, `#topSearchInput`, `subject:"Stocking Plan"`.
- Schedule history: `POST /Protected/CaseVisibility/ashx/Main.ashx?func=init&storeNbr=&businessDate=YYYY/MM/DD`
  from an open CaseVisibility tab. Roughly 45 days of history are available.
- Freight detail: in `main.html`'s MAIN world after `main_search()`, off
  `psn_apiJson` + `calc_*`/`config_*` (see §4). No child window is opened.

The probe scripts were deliberately not kept: they print a store roster.

---

## 6. Generating a plan from the emails (module 0.3.0)

The twelve plans are consistent enough to draft from. Three things had to be
recovered from them first.

### 6a. The line vocabulary, and the departments behind it

Plans are written in lines ("stock home-12.5 hours"), not departments. The
department sets were **fitted**, not guessed: 11 plans state hours for their GM
lines, and CaseVisibility's per-department stocking time is retrievable ~45 days
back, so each candidate set was scored against the hours actually written.

| Line | Departments | Fit against the stated hours |
|---|---|---|
| home | D14 + D17 + D22 + D74 | mean error 0.6h over 10 dates |
| hardware | D11 + D12 | paint travels with hardware; D11 alone always short |
| toys / sporting goods / automotive | D7 / D9 / D10 | one department each |
| garden | D16 + D56 | 1.9/2, 1.0/1, 0.9/1 |
| 3/19/67 | D3 + D19 + D67 | breakpack-heavy; see the note below |
| 90/91/97 · grocery · 4/8/13/79 · 2/40/46 · 82 | D90/91/97 · D92/95 · D4/8/13/79 · D2/40/46 · D82 | confirmed by the adjectives, below |

Two sets are deliberately narrower than they look: D20 (Bath & Shower) and D71
(Furniture) are *not* "home" — adding them overshoots every stated figure by
~20%. Departments no line claims (D5, D6, D20, D49, D71, D72, D87, D1, D81,
D96) roll into one "any remaining GM freight" line rather than being dropped.

Note on 3/19/67: the stated hours land about 45% of the way between CV's
cases-only time and its cases+breakpacks time, consistently across 10 dates.
The store works breakpacks roughly twice as fast as CV assumes. The module does
not model that yet — it quotes CV's number and lets the reader discount it.

### 6b. "Very heavy" and "very light" are a ratio

Every adjective in the sample turns out to be that line's hours over that
line's own median:

| Written | Line hours | Median | Ratio |
|---|---|---|---|
| "90/91/97 very light — only 15 hours" | 17.6 | 36.0 | 0.49 |
| "4/8/13/79 extremely light" | 13.8 | 27.5 | 0.50 |
| "grocery very light — only 21 hours" | 30.9 | 52.5 | 0.59 |
| "90/91/97 very heavy tonight" | 41.9 | 36.0 | 1.16 |
| "grocery very heavy" | 62.5 | 52.5 | 1.19 |
| "4/8/13/79 also very heavy" | 40.8 | 27.5 | 1.48 |
| "heavier than average in chemicals" (D13) | 9.3 | 5.6 | 1.66 |

Medians are seeded from the 10 complete dates and are per line, per store. The
module's bands are a notch calmer than the manager's vocabulary at the edges
(1.16 reads as "heavy", not "very heavy"), and no line under 2h gets an
adjective at all — garden at 1.7h against a 1.1h median is "very heavy" by
ratio and nonsense in a plan.

### 6c. What a loaded night sheds, and when

Overnight utilisation — overnight line hours ÷ `Stocking ON TA` net hours —
predicts what each plan did with its low-priority work:

| util | date | what the plan did |
|---|---|---|
| 0.49 | 09-13 | nothing pushed; Stock 1 just helps with D18 |
| 0.62 | 09-06 | nothing pushed; Stock 1 does topstock only |
| 0.74 | 09-12 | nothing pushed |
| 0.76 | 09-08 | 3/19/67 (2.5h) to Stock 1 |
| 0.79 | 09-16 | 3/19/67 (5h) + D18 (2h) to Stock 1 |
| 0.81 | 08-27 | "stock 3/19/67 if needed" on Stock 1 |
| 0.82 | 09-17 | D18 (~8.5h) to Stock 1 |
| 0.88 | 09-14 | D18 pallets to Stock 1 |
| 0.91 | 09-18 | 3/19/67 (6h) + D18 (5h) to Stock 1, with associate counts |

So: above ~0.78 the night starts shedding, below ~0.65 it absorbs everything
and can take D18 back off the morning. **3/19/67 is the only line it sheds.**
Home is 8–16h and the obvious candidate, but every plan in the sample kept it
overnight — 09-18 did at 0.91 — so the module refuses to move it and says the
night doesn't fit instead. Quietly handing 13h of home to a 9-person morning
crew is a worse plan than one that admits the problem.

Stock 2 is a different shape entirely: its freight lines run at 0.11–0.27 of
its hours because unload/downstack is the bulk of that shift. The only decision
it drives is the one the lightest GM nights make (09-13 at 0.13, 09-06 at
0.14): send Stock 2 to help zone and pick grocery, and pull the GM freight to
the floor for overnight.

### 6d. What the module will not invent

- **Mod Team content.** The block appears iff modular associates are scheduled,
  but the mods themselves come from the mod planner, which the module does not
  read. It emits the header and the crew size.
- **Carry-over.** "What's left from Friday morning", "the 4 unworked home
  pallets", "the 10 pallets of existing sporting goods freight from GM
  receiving" — none of that is in CaseVisibility, which only knows what is
  arriving. Several stated hours in the sample are new freight *plus* carry-over,
  which is the main reason the drafted hours run under what was written.
- **Associate counts.** "I would use 7 associates tonight", "need 3 people in
  home tonight". A shift's hours are known; how the coach splits them is not.
- **Topstock.** Every plan gives the morning crew an A/E/J round, but nothing
  in CaseVisibility sizes one, so the draft is freight only. The sweep-up line
  stays, because that *is* freight.
