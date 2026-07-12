# Live Dashboard — Backend Discovery Package

Backend/data discovery for the future **Live Dashboard** module — an
APAISuite module that shows high-priority daily operational signals
(callouts, compliance, accident evidence, CVP, register exceptions) on a
single dashboard surface.

**Last reviewed:** 2026-06-02. **Phase:** discovery only — no module code
written yet.

---

## Quick orientation (read these in order)

1. **[DISCOVERY_SUMMARY.md](DISCOVERY_SUMMARY.md)** — top-of-stack
   synthesis: what's feasible, what reuses existing modules, what NOT done.
   *(5 min read)*
2. **[SOURCE_MAP.md](SOURCE_MAP.md)** — one-line-per-source table
   answering "what / from where / by what method / how confident?".
   *(1 min read)*
3. **[../LIVE_DASHBOARD_BACKEND_QUESTIONS.md](../LIVE_DASHBOARD_BACKEND_QUESTIONS.md)** —
   the operator/policy questions that need decisions (lives at top-level
   `docs/` per the brief). Defaults are sane; answers can come later.

## Implementation-focused (when ready to build)

4. **[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)** — module skeleton,
   manifest edits, SW handlers, view layout, phasing.
5. **[ENDPOINTS.md](ENDPOINTS.md)** — per-source endpoint detail, auth
   modes, request/response shapes.
6. **[DATA_CONTRACTS.md](DATA_CONTRACTS.md)** — normalized schemas the
   module persists.
7. **[POLLING_PLAN.md](POLLING_PLAN.md)** — refresh cadence + rationale.
8. **[RISK_RULES.md](RISK_RULES.md)** — analysis rules. Register
   long/short matching algorithm is the heart of this file.
9. **[SECURITY_NOTES.md](SECURITY_NOTES.md)** — auth/secret-handling
   policy, what never to log, personal-data rules.

## Probe-required (next live session)

10. **[OPEN_QUESTIONS.md](OPEN_QUESTIONS.md)** — granular technical
    questions tagged BLOCKER vs. default-ok per source.

## Machine-readable contracts

Live in [`../../data/live_dashboard/`](../../data/live_dashboard/):

| File | Purpose |
|---|---|
| `source_registry.json` | What sources exist + their handler/widget hints. The module reads this at `register()` time. |
| `endpoints.json` | Endpoint contracts (URL, method, auth mode). |
| `schemas.json` | Runtime schemas for source data and dashboard state. |
| `polling_plan.json` | Per-source intervals, cache lifetimes, stale thresholds. |
| `risk_rules.json` | Configurable thresholds for every rule. |
| `sample_data.json` | Mock data for tests + UI dev. |

---

## What's done in this session

- All 9 discovery markdown docs.
- All 6 JSON contracts.
- Top-level `LIVE_DASHBOARD_BACKEND_QUESTIONS.md` (operator-facing).
- No module code; no manifest edits; no probe runs.

## What's NOT done (requires follow-up)

- **Probe sessions** for sources B (Enviance) and C (Accident Evidence),
  plus the per-store CVP query variant for source D, plus the
  register-grid query signature for source E. See
  [OPEN_QUESTIONS.md](OPEN_QUESTIONS.md) BLOCKER tags.
- **Implementation.** The plan in
  [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) is sequenced for
  ~6 days of work across 5 phases.

---

## Feasibility scorecard (TL;DR)

| Source | Method | Confidence | Notes |
|---|---|---|---|
| A — Absences | reuse `closinglist` IVR scraper | **H** | Just subscribe |
| B — Compliance | bg-fetch (probe required) | M | Net-new origin: `go.enviance.com` |
| C — Accident Evidence | bg-fetch (probe required) | M | Origin already permitted |
| D — CVP | bg-fetch (pattern proven) | **H** | `dev/HOOPS_FINDINGS.md` has the endpoint |
| E — Register Long/Short | XLSX import V1, cs-capture V1.5 | M-H | Mirror of `digitallocks` pattern |

---

## How to update this folder

- Update the **Last reviewed** date in each doc when content changes.
- New per-source findings go in `dev/<SOURCE>_FINDINGS.md` (matches
  `dev/HOOPS_FINDINGS.md` convention), then summarized back into
  [ENDPOINTS.md](ENDPOINTS.md) and [OPEN_QUESTIONS.md](OPEN_QUESTIONS.md).
- Schema changes go in `data/live_dashboard/schemas.json` + the
  matching prose in [DATA_CONTRACTS.md](DATA_CONTRACTS.md).
- When the module ships, this folder becomes historical. Move it under
  `docs/_archive/` and link a brief "see git history" note at the
  top-level docs index.

---

## Cross-references in the broader suite docs

- `docs/AI_CONTEXT_BRIEF.md` — should gain a "Live Dashboard" row in the
  module table when the module is registered.
- `docs/CURRENT_TASKS.md` — add an entry when implementation starts (most
  likely after the in-flight Hoops Sell-Through work lands, since that
  validates the cross-origin cookie behavior question that gates V1's
  CVP source).
- `docs/DOC_STATUS.md` — when added, classify this folder as ACTIVE and
  add the LIVE_DASHBOARD_BACKEND_QUESTIONS.md as ACTIVE.
- `dev/HOOPS_FINDINGS.md` — directly upstream of source D.
- `modules/closinglist/content/ivr.js` — directly upstream of source A.
- `modules/digitallocks/content/capture.js` — directly upstream of
  source E.
