# Doc Status

Status of every markdown file in the project. Use this to decide whether a
doc is worth reading and which one to trust when two contradict.

**Last reviewed:** 2026-06-02. Suite version 0.8.2.

---

## Status legend

| Status | Meaning |
|---|---|
| **CANONICAL** | Current, authoritative, safe to follow. |
| **ACTIVE_REFERENCE** | Domain reference still in use; read when working on that area. |
| **CURRENT_TASKS** | In-flight work; updated as it progresses. |
| **HISTORICAL** | Pre-shipping; kept to explain *why*. Not actionable. |
| **SUPERSEDED** | Mostly replaced by a newer doc; a section or two may still be useful. |
| **STALE** | Frozen at a past state; tracking fields no longer maintained. Skip. |
| **MIXED** | Contains both current and stale chunks; read with the noted caveat. |

---

## Project-level

| File | Status | Notes |
|---|---|---|
| `CLAUDE.md` (project root) | CANONICAL | Loaded into every AI session. Single source of truth for hard rules. |
| `unified-extension-suite/README.md` | CANONICAL *(after 2026-06-02 rewrite)* | Public-facing intro. Rewritten in this pass to reflect v0.8.2 shipped state. |
| `claims_disposition_reference.md` (project root) | ACTIVE_REFERENCE | Upstream Looker Studio data-source reference for claimsdisposition. **Factual correction:** the "4-digit store number (e.g., `0669`)" claim is wrong for the BigQuery side — store IDs in the Looker `_STORE_` filter are bare ints (`669`, not `0669`). See `MEMORY.md::Claims Disposition store IDs no leading zeros`. |

## Suite docs (`unified-extension-suite/docs/`)

| File | Status | When to read | Notes |
|---|---|---|---|
| `AI_CONTEXT_BRIEF.md` | CANONICAL | First — orientation | Created 2026-06-02 as the canonical entry point for AI sessions. |
| `MODULE_CONTRACT.md` | CANONICAL | When adding/editing a module | Created 2026-06-02. Replaces the dispersed module guidance in ARCHITECTURE.md + MIGRATION_PLAN.md. |
| `ACTIVE_FILES.md` | CANONICAL | When orienting on what files matter | Created 2026-06-02. |
| `CURRENT_TASKS.md` | CURRENT_TASKS | When picking up work | Created 2026-06-02. Hoops integration, DigitalLocks V1.5, ClaimsBuddy re-enable. |
| `DOC_STATUS.md` | CANONICAL | This file | You are here. |
| `DO_NOT_READ_BY_DEFAULT.md` | CANONICAL | Before reading anything below STALE | Skip-list with rationale. |
| `DESIGN_SYSTEM.md` | ACTIVE_REFERENCE | When editing UI/styles | Tokens + components. Stable since 2026-05-23; no known drift. |
| `RELEASING.md` | MIXED | When cutting a release | **Heed:** Chrome Web Store sections describe a path that was deferred — qrcallbox.com is the only channel today. Per `MEMORY.md::Update channel`. The qrcallbox.com flow + the in-extension nag pill description are still correct. |
| `DIGITAL_LOCKS_MODULE.md` | CANONICAL | When editing digitallocks | Newest doc in `docs/` (2026-06-02). |
| `DIGITAL_LOCKS_QUESTIONS.md` | CURRENT_TASKS | When extending digitallocks | Open Qs that don't block V1. |
| `ARCHITECTURE.md` | MIXED | When designing platform-level changes | §2 describes `service: { handlers: () => import("./service.js") }` (dynamic import) — this was **abandoned** because MV3 SWs cannot do dynamic import. Use `MODULE_CONTRACT.md` instead. Everything else in this doc (shell layout, host API surface, CSS scoping, manifest assembly intent) still describes the live system. |
| `MIGRATION_PLAN.md` | SUPERSEDED | Almost never | Phases 1–5 are done; Phase 6 (polish + retirement) partially done. The "Importing a new extension" recipe is the only useful surviving section and has been folded into `MODULE_CONTRACT.md::13. Recipe`. |
| `EXTENSION_SUITE_AUDIT.md` | HISTORICAL | When asking *why* a donor pattern survived | Pre-migration audit of the 3 original donors. Useful for understanding why certain decisions were made; not actionable. |
| `FEATURE_PARITY.md` | STALE | Don't | Every feature shows `not-started` because the doc was frozen 2026-05-23 before any feature shipped. Six modules are live. |
| `SOURCE_MAPPING.md` | STALE | Don't | Covers only 3 of 6 modules; status fields never maintained after the initial migration. Git history is authoritative. |
| `PERMISSIONS_MATRIX.md` | STALE | Don't | Matrix lists 10 perms / 11 hosts; actual `manifest.json` has 14 perms / 23 hosts. `manifest.json` is the source of truth. |
| `BACKEND_OVERVIEW.md` | CANONICAL | First when touching AurorBuddy backend | One-page guide; links the six per-phase docs. Created 2026-06-07. |
| `BACKEND_TELEMETRY_AUDIT.md` | CANONICAL | Investigating a backend bug | Audit of the proxy-value bug + the three parallel codebases (shanesmith/donor/suite). |
| `BACKEND_DATA_MODEL.md` | CANONICAL | Adding fields to events/workflows/metrics | Corrected schema. `transactionTotalCandidate` ≠ `finalEventValue`. |
| `AUROR_WORKFLOW_LIFECYCLE.md` | CANONICAL | Adding/changing a workflow state | 14-status enum + transitions + value-field gate. |
| `BACKEND_MIGRATION_PLAN.md` | CURRENT_TASKS | Tracking the shanesmith → suite cutover | 6-phase plan. Phases 1.1 + 1.2 deployed 2026-06-07. |
| `USAGE_METRICS_MODEL.md` | CANONICAL | Adding a metric action or PII rule | `tool_metric_events` schema + helper API + redaction rules. |
| `FINAL_VALUE_CAPTURE_PLAN.md` | CANONICAL | Touching the Mark Submitted UX or DOM-scrape probe | V1 shipped 2026-06-07. V1.5 + V2 deferred. |

## Dev probe findings (`unified-extension-suite/dev/`)

| File | Status | When to read | Notes |
|---|---|---|---|
| `HOOPS_FINDINGS.md` | CURRENT_TASKS | When working on the Sell-Through integration | 2026-06-02 — endpoint + query captured. |
| `DIRECTORY_FINDINGS.md` | ACTIVE_REFERENCE | When resuming user-directory lookup work | 2026-05-31. Most endpoints dead-ended; documents the one viable lead (Workvivo `/users/lookup`). |

## Per-module READMEs (`modules/<slug>/...`)

| File | Status | When to read |
|---|---|---|
| `modules/sparkfraud/fixtures/README.md` | ACTIVE_REFERENCE | When working on sparkfraud fixtures (REPLAY-01/02) |
| `modules/sparkfraud/models/README.md` | ACTIVE_REFERENCE | When touching sparkfraud's typed domain models. **Caveat:** references a `docs/TASKS.md` that no longer exists; treat MODEL-01/02/03 task IDs as historical. |
| `modules/sparkfraud/registries/README.md` | ACTIVE_REFERENCE | When editing sparkfraud's JSON registries |
| `modules/sparkfraud/telemetry/README.md` | ACTIVE_REFERENCE | When touching sparkfraud telemetry. **Caveat:** references TELEMETRY-01/02/03 task IDs from the dead `docs/TASKS.md`. |
| `assets/icons/README.md` | ACTIVE_REFERENCE | When regenerating icons |

---

## How to update this file

When you create a new doc, add a row. When a doc becomes stale, flip its
status. When two docs contradict, pick one as canonical and mark the other
SUPERSEDED with a pointer.

The cheapest way to keep this file honest is to add a one-line entry the
moment you create or stop using a doc — never let it drift.
