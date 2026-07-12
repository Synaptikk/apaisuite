# Data Contracts

Normalized internal schemas the Live Dashboard module stores and renders
from. Every source's raw shape is mapped to one of these before persistence,
so the UI and risk-rule engine never see source-specific fields.

**Last reviewed:** 2026-06-02.

**Naming conventions** (suite-wide):
- camelCase fields.
- Times are ISO 8601 strings unless a field is explicitly a `*Date` (YYYY-MM-DD)
  or `*Time` (HH:MM[:SS] local).
- Money fields are integers in **cents** to avoid float drift
  (`shortageCents: -2000` for $20 short). The UI formats on render.
- IDs that may have leading zeros (facility, store, register, operator) are
  **strings**, not numbers. Stripping leading zeros on parse has bitten the
  suite before — Claims Disposition store IDs note in `MEMORY.md`.
- Source-of-record is preserved as `_source: { module, capturedAt, raw? }`
  on every record, so we can audit where any datum came from.

---

## 1. Absences (Source A)

```ts
type AbsenceRecord = {
  // identity
  storeNbr:        string;       // "1458"
  associate:       string;       // "DOE, JOHN"
  win:             string|null;  // Walmart ID number, if extractable from associate string
  absenceDate:     string;       // YYYY-MM-DD — converted from "MM/DD/YYYY" raw
  callDateTime:    string|null;  // ISO if parsable; else raw display string
  // categorization
  dept:            string;       // "GM" / "Front End" / "Fuel"
  job:             string;
  absenceType:     string;       // "Absence" / "Tardy" / "Early Out" etc.
  absenceReason:   string;
  // status
  confirmation:    string|null;  // confirmation # if IVR returned one
  source:          string|null;  // "IVR" / "Manual" — IVR-page provided
  // provenance
  _source: {
    module:     "closinglist";   // V1 reuses closinglist's scraper
    capturedAt: string;          // ISO from the content script
    sourceUrl:  string;          // page URL at scrape time
  };
};
```

**Indexing.** Stored as `IndexedDB livedashboard.absences` keyed by
`(storeNbr, absenceDate, associate, callDateTime)` to dedupe re-pulls.

**WIN extraction.** Some associate strings include the WIN inline (e.g.
`"DOE, JOHN (12345678)"`). If present, populate `win`; otherwise `null`.
This is best-effort and should never block a record from being saved.

**Dashboard rollup.**
- `callouts_today` = count where `absenceDate == today AND absenceType !== "Tardy"`
- `tardies_today` = count where `absenceDate == today AND absenceType == "Tardy"`

---

## 2. Compliance Tasks (Source B)

```ts
type ComplianceTask = {
  // identity
  facility:        string;       // "01458" (leading zeros preserved)
  taskName:        string;       // "Weekly Eyewash Inspection"
  assignedGroups:  string[];     // ["AP", "Facilities"]
  // dates
  dueDate:         string;       // YYYY-MM-DD
  dueAt:           string|null;  // ISO if Enviance provides a time
  // derived
  daysUntilDue:    number;       // can be negative (overdue)
  isOverdue:       boolean;      // daysUntilDue < 0
  isDueSoon:       boolean;      // 0 <= daysUntilDue <= 7
  // category (best effort)
  category:        "weekly" | "monthly" | "annual" | "ad-hoc" | "unknown";
  // provenance
  _source: {
    module:     "livedashboard";
    capturedAt: string;
    sourceUrl:  string;
    panelId:    string;          // the Enviance panel UUID
  };
};
```

**Category inference rules** (string match on `taskName`, lowercased):
- starts with `weekly ` → `weekly`
- starts with `monthly ` → `monthly`
- starts with `annual ` or `yearly ` → `annual`
- else → `unknown` (until Enviance exposes a category field)

**Dashboard rollup.**
- `overdue_count` = count where `isOverdue`
- `due_within_7_count` = count where `isDueSoon`

---

## 3. Accident Evidence (Source C)

```ts
type AccidentEvidenceRecord = {
  // identity
  storeNbr:           string;
  reportType:         "BodilyInjury" | "GarageKeeperPropertyDamage";
  referenceNbr:       string;
  trackingNbr:        string|null;
  claimant:           string;
  daysOpen:           number;
  // evidence checklist — every field is one of:
  //   "complete" | "missing" | "partial" | "unknown"
  customerStatement:        EvidenceStatus;
  witnessStatement:         EvidenceStatus;
  video:                    EvidenceStatus;
  photos:                   EvidenceStatus;
  evidenceCollectionSheet:  EvidenceStatus;
  evidenceStatus:           EvidenceStatus;     // overall — source-provided
  enhancedExport:           "yes"|"no"|"unknown";
  // derived
  missingItems:             string[];           // names of fields == "missing"
  missingCount:             number;
  priorityScore:            number;             // see RISK_RULES.md
  // provenance
  _source: {
    module:     "livedashboard";
    capturedAt: string;
    sourceUrl:  string;
  };
};

type EvidenceStatus = "complete" | "missing" | "partial" | "unknown";
```

**Status mapping** (from the page's likely text values — to refine with
probe):
- "Complete" / "Yes" / "✓" → `complete`
- "Missing" / "No" / "—" / blank → `missing`
- "Partial" / "In Progress" → `partial`
- anything else → `unknown` (logged for follow-up)

**Dashboard rollup.**
- `claims_with_missing_evidence` = count where `missingCount > 0`
- `high_priority_evidence_gaps` = count where `priorityScore >= 7`

---

## 4. CVP Metrics (Source D)

```ts
type CvpMetric = {
  // identity
  storeNbr:           string;
  wmWeekNbr:          number;       // Walmart fiscal week
  deptGroupNbr:       number;       // 2 = all merch (default)
  // raw qty (this year)
  firstCvpQty:        number;       // _Ty454 in raw
  cvpToCvpQty:        number;
  cvpTotalQty:        number;
  cvpSalesQty:        number;
  cvpSalesRetailCents: number;      // _Ty454 cents
  // derived
  sellThroughPct:     number;       // (cvpSalesQty / cvpTotalQty) * 100, 0 if total==0
  // provenance
  _source: {
    module:     "livedashboard";
    capturedAt: string;
    queryParams: { storeNbr: string; wmWeekNbr: number; deptGroupNbr: number };
  };
};
```

**Color thresholds for the Sell Through widget** (matches the planned
ClaimsDisposition column in `CURRENT_TASKS.md`):
- green: `sellThroughPct >= 25`
- amber: `15 <= sellThroughPct < 25`
- red: `sellThroughPct < 15`

**Stored history.** Keep the last 8 weeks per store in
`livedashboard.cvpHistory.<storeNbr>` for trend rendering. Each pull
replaces the row for that `(storeNbr, wmWeekNbr)`.

---

## 5. Register Long/Short Discrepancies (Source E)

```ts
type RegisterDiscrepancy = {
  // identity
  storeNbr:        string;
  date:            string;          // YYYY-MM-DD (the business date)
  registerNbr:     string;          // "10", "67" — string to preserve leading zeros if any
  amountCents:     number;          // signed; negative = short, positive = over
  // categorization
  type:            "short" | "over";
  amountAbsCents:  number;          // |amountCents|, for ranking
  // operator linkage (V1.5 — may be empty in V1)
  operators:       Array<{
    operatorId:    string;
    operatorName:  string|null;
    sourceVisual:  string;          // "drill-through" / "manual"
  }>;
  // provenance
  _source: {
    module:        "livedashboard";
    capturedAt:    string;          // import timestamp
    sourceMethod:  "powerbi-capture" | "xlsx-import";
    reportId:      string;          // "65c97d6a-7ad8-498d-b752-69028d408993"
  };
};
```

**Derived analysis records** (computed by the risk-rule engine and stored
separately; not source-of-record):

```ts
type RegisterFinding = {
  id:               string;                  // hash of (storeNbr,date,registerNbr)
  storeNbr:         string;
  primaryDate:      string;
  primaryRegister:  string;
  primaryAmountCents: number;
  // matching attempt
  matchType:        "none" | "nearby-register-offset"
                    | "same-register-bounceback" | "ambiguous";
  matchedAgainst:   Array<{
    date:           string;
    registerNbr:    string;
    amountCents:    number;
    deltaCents:     number;     // signed: matched.amount + primary.amount
    daysApart:      number;
  }>;
  // severity (from RISK_RULES.md)
  severity:         "low" | "medium" | "high";
  reason:           string;
  // research workflow
  dismissed:        boolean;
  dismissedAt:      string|null;
  dismissedBy:      string|null;             // operator note
  note:             string|null;
};
```

**Storage.** Raw `RegisterDiscrepancy` rows live in
`IndexedDB livedashboard.registerDiscrepancies`. Computed `RegisterFinding`
rows live in `IndexedDB livedashboard.registerFindings`. Recomputing
findings is idempotent — wipe findings, re-run analysis over current
discrepancies + the offset-match window.

---

## 6. Per-source "freshness" metadata (cross-cutting)

Every source maintains a freshness record so widgets can render
last-updated and stale states.

```ts
type SourceFreshness = {
  sourceId:     "absences" | "compliance" | "accident" | "cvp" | "register";
  lastSuccess:  string|null;     // ISO of last successful pull
  lastAttempt:  string|null;     // ISO of last attempt (success or failure)
  lastError:    string|null;     // human-readable error (no secrets)
  staleAfterMs: number;          // see POLLING_PLAN.md
  isStale:      boolean;         // (now - lastSuccess) > staleAfterMs
};
```

Stored at `chrome.storage.local["livedashboard.freshness.<sourceId>"]`.
Updated by every SW handler that pulls a source.

---

## 7. User settings (cross-cutting)

```ts
type LiveDashboardSettings = {
  storeNbr:        string;       // default "1458"
  refreshIntervals: {
    absences:    number;         // ms — see POLLING_PLAN.md for defaults
    compliance:  number;
    accident:    number;
    cvp:         number;
    register:    number;
  };
  showOnlyExceptions: boolean;   // default false — show normal/green too
  dismissedFindings:  string[];  // RegisterFinding.id list
};
```

Stored at `chrome.storage.sync["livedashboard.settings"]` (syncs across
devices) for personal prefs. `dismissedFindings` may need to move to
`storage.local` if it grows past `storage.sync`'s quota (~100KB).
