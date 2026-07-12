# Risk Rules

Analysis rules that convert raw source data into actionable findings.
Each rule defines: when it fires, severity, the human-readable reason,
and what fields it touches. Rules are deliberately small and composable
— compound signals come from a finding triggering multiple rules.

**Last reviewed:** 2026-06-02.

**Severity scale.** `low / medium / high`. A finding can be promoted by
multiple rules — take the max.

**Configurability.** Thresholds noted as `<configurable>` live in
`data/live_dashboard/risk_rules.json` and can be overridden via the
dashboard's settings UI later. Don't hardcode them in module code.

---

## 1. Absences (Source A)

The absences widget is rollup-only — it's not really a "rule engine,"
just count + filter. Listed here for symmetry.

### A1: Callout volume threshold
- **When:** `count(absences where absenceDate == today AND absenceType != "Tardy")` >= `<configurable: 5>`
- **Severity:** medium (under threshold = green)
- **Reason:** `"{N} associates called off today (threshold: 5)"`

### A2: Department concentration
- **When:** Any single department has >= `<configurable: 3>` callouts today
- **Severity:** high
- **Reason:** `"{N} callouts in {dept} today — possible coverage gap"`

---

## 2. Compliance Tasks (Source B)

### C1: Any overdue
- **When:** `isOverdue == true`
- **Severity:** **high** if `daysUntilDue <= -7`, else **medium**
- **Reason:** `"{taskName} is {Math.abs(daysUntilDue)} days overdue"`
- **Rollup:** `overdue_count` on the widget

### C2: Due within 24 hours
- **When:** `0 <= daysUntilDue <= 1`
- **Severity:** medium
- **Reason:** `"{taskName} due tomorrow ({dueDate})"`

### C3: Due within 7 days (informational)
- **When:** `0 <= daysUntilDue <= 7`
- **Severity:** low
- **Reason:** `"{taskName} due {dueDate} ({daysUntilDue} days)"`
- **Rollup:** `due_within_7_count` on the widget

---

## 3. Accident Evidence (Source C)

The `priorityScore` field on `AccidentEvidenceRecord` is computed by
summing the rules below. Higher score = higher priority for the user
to chase.

### AE1: Missing video on a bodily injury claim
- **When:** `reportType == "BodilyInjury" AND video == "missing"`
- **Score:** +5
- **Severity:** high (alone — bodily injury without video is the worst
  evidence gap)
- **Reason:** `"Bodily injury claim {referenceNbr} missing video evidence"`

### AE2: Missing customer statement
- **When:** `customerStatement == "missing"`
- **Score:** +2
- **Severity:** medium

### AE3: Missing witness statement (when there should be one)
- **When:** `witnessStatement == "missing" AND daysOpen >= 3`
- **Score:** +1
- **Severity:** low

### AE4: Aging open claim
- **When:** `daysOpen >= <configurable: 14>`
- **Score:** +2
- **Severity:** medium

### AE5: Multiple missing items
- **When:** `missingCount >= 3`
- **Score:** +3
- **Severity:** high
- **Reason:** `"Claim {referenceNbr} missing {missingCount} evidence items"`

### Overall severity from `priorityScore`
- `>= 7` → high
- `4–6` → medium
- `1–3` → low
- `0` → none (suppress from exception list unless `showOnlyExceptions == false`)

---

## 4. CVP (Source D)

### CVP1: Low sell-through with non-trivial CVP volume
- **When:** `sellThroughPct < 15 AND cvpTotalQty >= <configurable: 100>`
- **Severity:** **high** if `sellThroughPct < 10`, else medium
- **Reason:** `"Sell-through {sellThroughPct.toFixed(1)}% on {cvpTotalQty} CVP units"`
- **Note:** This is the same shape as the planned R10 outlier rule in
  `CURRENT_TASKS.md::Hoops Sell-Through`. Keep the threshold in sync — if
  the ClaimsDisposition team tunes their R10, port the change here.

### CVP2: Sell-through trend declining
- **When:** Last 3 weeks each lower than the prior, AND current < 25%
- **Severity:** medium
- **Reason:** `"Sell-through declining 3 weeks ({week-2}% → {week-1}% → {week}%)"`
- **Requires:** 3 weeks of history in `livedashboard.cvpHistory.<storeNbr>`

---

## 5. Register Long/Short (Source E) — the real engine

This is the biggest analysis section because the user's goal is **not**
"surface all over/short" — it's "surface the ones that aren't simple
till/check-in flips."

### Vocabulary

- **Primary:** the discrepancy being scored. Usually a shortage we care
  about, but also runs on overages to find "bounce-back" patterns.
- **Offset:** another discrepancy on a different register within the time
  window whose amount approximately cancels the primary (e.g. primary
  short $20, offset over $20 ⇒ likely flip).
- **Bounceback:** a discrepancy on the *same* register within the time
  window whose amount approximately cancels the primary (e.g. register 10
  short $200 yesterday, register 10 over $200 today ⇒ likely reconciled
  internally — drawer count fix, not real loss).
- **Tolerance:** how close two amounts must be to count as offsetting.
  Default `±$5` for amounts under $100; `±5%` for amounts over $100.
  Both configurable.
- **Time window:** how many days apart two discrepancies can be and still
  match. Default 3.

### R1: Unmatched shortage (the headline rule)

- **When:** A shortage record has NO discrepancy within the time window
  and tolerance that offsets it (neither on adjacent register nor on the
  same register).
- **Severity:**
  - high if `amountAbsCents >= <configurable: 10000>` ($100)
  - medium if `amountAbsCents >= <configurable: 2500>` ($25)
  - low otherwise
- **Reason:** `"Register {N} short ${amount} on {date} — no offset found within {window} days"`
- **MatchType:** `"none"`

### R2: Nearby-register offset (likely flip — LOWER priority)

- **When:** A shortage matches an overage on a different register within
  `±1–3` register-number proximity AND within the time window AND within
  tolerance.
- **Severity:** low (this is the "almost certainly a till flip" case)
- **Reason:** `"Register {N} short ${amt} likely offset by register {M} over ${amt2} on {date}"`
- **MatchType:** `"nearby-register-offset"`
- **Display behavior:** by default, R2 findings are hidden when the
  widget is in "show only exceptions" mode. Toggle reveals them.
- **Note:** "adjacent register" can mean numerically adjacent OR
  physically adjacent — the latter requires a register-layout map per
  store, which we don't have. Numeric adjacency (±1–3) is the V1 proxy.

### R3: Same-register bounceback

- **When:** Same register shows over/short reversal within the time
  window AND within tolerance.
- **Severity:** low
- **Reason:** `"Register {N} short ${amt} on {date1}, over ${amt2} on {date2} — likely drawer-count fix"`
- **MatchType:** `"same-register-bounceback"`
- **Display:** same as R2 — hidden by default in exceptions-only mode.

### R4: High-dollar repeated shortage on same register

- **When:** Same register has >= `<configurable: 2>` unmatched (R1)
  shortages within `<configurable: 14>` days totaling >=
  `<configurable: 20000>` ($200).
- **Severity:** high
- **Reason:** `"Register {N} has {count} unmatched shortages in {days} days totaling ${total}"`

### R5: Operator exposure (V1.5 — requires operator detail)

- **When:** Same operator (by `operatorId`) is linked to >=
  `<configurable: 2>` R1 findings within `<configurable: 30>` days.
- **Severity:** medium first hit, high on subsequent.
- **Reason:** `"Operator {operatorId} linked to {count} unmatched shortages in {days} days"`
- **Privacy note:** This rule names a person. The dashboard must show
  operator IDs only (not names) by default; the name field exists but is
  hidden behind a tooltip or expand. See [SECURITY_NOTES.md](SECURITY_NOTES.md).

### R6: Repeated involvement pattern (V1.5+)

- **When:** An operator appears in the operator list of >= 3 distinct
  R1 findings spanning multiple registers within 30 days.
- **Severity:** high
- **Reason:** `"Operator {operatorId} involved across {count} registers with unmatched shortages"`

### R7: Suspicious timing (V2+)

- **When:** Unmatched shortages cluster on specific weekdays / shift
  times for a given operator or register.
- **Severity:** medium
- **Requires:** shift/timestamp data we don't have in V1's per-day grid.
- **Defer** until the data is available.

---

## Tolerance and matching algorithm

### Tolerance function

```js
function withinTolerance(primaryCents, candidateCents) {
  // candidate.amount + primary.amount should be ~0 for an offset
  // (one negative, one positive)
  const delta = Math.abs(primaryCents + candidateCents);
  const primaryAbs = Math.abs(primaryCents);
  if (primaryAbs <= 10000) return delta <= 500;            // ±$5 for ≤$100
  return delta <= primaryAbs * 0.05;                       // ±5% for >$100
}
```

Both numbers are signed cents. The `+` (not `-`) is intentional: a $20
short is `-2000` and the matching $20 over is `+2000`; their sum is `0`.

### Matching algorithm sketch

```js
for (const primary of shortages.sort(byDateAsc)) {
  // R2: nearby register offset (±3 registers, ±N days, opposite sign)
  const r2 = findIn(allDiscrepancies, {
    differentRegister: true,
    registerNumberDelta: 3,
    daysApart:  windowDays,
    oppositeSign: true,
    withinTolerance: true,
  });
  if (r2) { emit({ matchType: "nearby-register-offset", ...primary, matched: r2 }); continue; }

  // R3: same-register bounceback
  const r3 = findIn(allDiscrepancies, {
    sameRegister: true,
    daysApart:    windowDays,
    oppositeSign: true,
    withinTolerance: true,
  });
  if (r3) { emit({ matchType: "same-register-bounceback", ...primary, matched: r3 }); continue; }

  // R1: unmatched (the interesting case)
  emit({ matchType: "none", ...primary });
}
```

**Ambiguity.** If multiple candidates match, pick the closest in time, then
the closest in register-number proximity. Record `matchedAgainst[]` with
all candidates considered (not just the winner) so the user can audit the
decision in the drill-down.

**Recomputation.** Run the algorithm fresh on every register data import.
Don't try to incrementally maintain. The dataset is small (registers ×
30 days per store), recomputation is cheap, and incremental matching
has too many edge cases.

### Operator data not yet available

R5 and R6 require `operators[].operatorId` to be populated. In V1
(XLSX import), operator detail is **not** present in the exported grid.
Skip these rules and document them as V1.5 features. Findings still
trigger R1–R4 without them.
