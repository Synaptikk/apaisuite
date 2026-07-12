# Live Dashboard — Backend Discovery Questions (for the operator)

These are the **product / policy / workflow** questions that need an
operator decision before the Live Dashboard module ships. Technical /
probe-required questions live in
[`live_dashboard_backend/OPEN_QUESTIONS.md`](live_dashboard_backend/OPEN_QUESTIONS.md).

**Why this file is separate.** This file is the one to share with someone
who doesn't need to read all the discovery internals — it's just the
decisions you need from them.

**Status of each question.** Items are tagged:
- **[blocker]** — answer needed before V1 implementation can ship that
  source.
- **[default-ok]** — has a sensible default documented; answer can come
  later without blocking V1.
- **[V2]** — defers to a later release; not blocking now.

**Last reviewed:** 2026-06-02.

---

## Scope & store selection

1. **Default store on first launch.** Should the dashboard auto-default
   to **1458** or prompt on first launch? **[default-ok]**
   *Default: auto-default to 1458, with the Store Settings drawer
   visible from the header.*

2. **Multi-store support.** Should the dashboard support tracking
   multiple stores simultaneously, or only one configured store at a
   time? **[default-ok]**
   *Default: one store at a time in V1. Switching is fast (~1s for cached
   pulls). Multi-store-comparison view is V2 territory.*

3. **Default deptGroupNbr for CVP.** The Hoops query takes a
   `deptGroupNbr` — defaults to `2` ("all merch") in
   [`live_dashboard_backend/ENDPOINTS.md`](live_dashboard_backend/ENDPOINTS.md).
   Is this the right headline grouping? **[default-ok]**
   *Default: `2`. Drill-down by group is a follow-up.*

---

## Refresh & polling cadence

4. **Auto-poll vs. manual-refresh per source.** Per
   [`live_dashboard_backend/POLLING_PLAN.md`](live_dashboard_backend/POLLING_PLAN.md):
   - Absences, CVP, Accident Evidence, Compliance: **auto-poll**
   - Register Long/Short: **manual refresh only in V1** (Power BI
     workflow is expensive)
   Acceptable, or should Register also auto-poll in V1? **[default-ok]**

5. **Refresh intervals.** Defaults in
   [`live_dashboard_backend/POLLING_PLAN.md`](live_dashboard_backend/POLLING_PLAN.md):

   | Source | Default |
   |---|---|
   | Absences | 15 min |
   | Compliance | 6 hours |
   | Accident Evidence | 30 min |
   | CVP | 15 min |
   | Register | manual (V1) / 6 hours (V1.5) |

   Are these acceptable? Should anything be faster or slower? **[default-ok]**

6. **Cache duration / stale thresholds.** Defaults: cache for the poll
   interval, mark stale at 2× interval. **[default-ok]**

7. **Cold-start behavior.** When the user opens the dashboard after
   Chrome was closed overnight, should the dashboard auto-refresh stale
   sources immediately, or wait for the user to click Refresh? **[default-ok]**
   *Default: auto-refresh stale sources on mount.*

---

## Display & exception model

8. **Show only exceptions, or all sources (including green)?** **[default-ok]**
   *Default: show all sources with green/yellow/red status. User can
   toggle "exceptions only" via settings — when toggled, green sources
   collapse to a single-line "X normal" summary.*

9. **Last refresh visibility.** Always show per-source last-refresh time
   on every widget? **[default-ok]**
   *Default: yes, small subtitle on every widget. Tooltip shows error
   details for stale/error states.*

10. **Drill-down style.** When the user clicks a widget, should it open:
    - A full-page sub-route (replacing the dashboard grid temporarily)?
    - A modal/drawer?
    - A side panel?

    **[default-ok]**
    *Default: full-page sub-route with a clear back button. Modals are
    fine but make exporting/searching harder.*

11. **Dismissed findings persistence.** When the user dismisses a
    register finding, should it stay hidden:
    - Until the next register data import? **(recommended)**
    - Forever?
    - For 30 days?

    **[default-ok]**
    *Default: until next import. Dismissed findings re-evaluate when new
    data arrives — keeps the dashboard adaptive.*

---

## Risk thresholds

12. **CVP sell-through thresholds.**
    [`live_dashboard_backend/RISK_RULES.md`](live_dashboard_backend/RISK_RULES.md)
    uses: green ≥ 25%, amber 15–25%, red < 15%. Sourced from the planned
    R10 outlier rule in `CURRENT_TASKS.md`. Acceptable? **[default-ok]**

13. **Accident evidence priority score thresholds.** Defaults: high if
    `priorityScore >= 7`, medium 4–6, low 1–3. **[default-ok]**
    *Note: bodily-injury-claim-missing-video alone scores 5, so a single
    BI claim with missing video lands as medium. Increase that rule's
    weight to 7 if you want it to be high all by itself.*

14. **Compliance overdue severity.** Default: high if 7+ days overdue,
    medium if 1–6 days overdue. Acceptable? **[default-ok]**

15. **Callout volume thresholds.** Default: medium if 5+ callouts today,
    high if any department has 3+ callouts. Both configurable per-store?
    **[default-ok]**

---

## Register long/short — the analysis question

16. **Tolerance for "offset" matching.** Defaults: `±$5` for shortages
    under $100, `±5%` for shortages over $100. **[default-ok]**
    *Smaller tolerances → more findings flagged as "unmatched" (real
    losses). Larger tolerances → more findings classified as flips.*

17. **Time window for offset matching.** Default: 3 days. **[default-ok]**
    *Longer window → more matches found (fewer R1 findings). Shorter
    window → more confidence each unmatched finding is real.*

18. **Adjacent-register definition.** Default: numerical adjacency
    (±3). **[default-ok]**
    *True physical adjacency would require a per-store register-layout
    map, which we don't have. If you have such a map for store 1458, we
    can wire it in.*

19. **What is the bare minimum dollar value to surface?** Default: any
    shortage shows up as a finding, but only `>= $25` is medium severity
    or higher. Should small ($5–$25) shortages even appear in the
    exception list, or auto-suppressed? **[default-ok]**

20. **Operator data visibility default.** Default per
    [`live_dashboard_backend/SECURITY_NOTES.md`](live_dashboard_backend/SECURITY_NOTES.md):
    show operator IDs by default, names hidden behind a toggle. **[default-ok]**

---

## Export & reporting

21. **PDF / CSV export.** Per-finding export (single click) and bulk
    export (filtered list)? Bulk export shows confirmation dialog when
    it would include personal data (operator names). **[V2]**
    *Default: V2 feature. V1 is read-only display.*

22. **Daily summary email.** Should the dashboard be able to send a
    daily summary email (via the existing AP email helpers in
    `closinglist`)? **[V2]**

23. **Share view link.** Should the dashboard support generating a
    shareable URL that captures store + filter state? **[V2]**
    *No external sharing — would be internal-only deep links within
    the extension.*

---

## Out-of-scope (do NOT do in V1)

These were considered but deliberately deferred:

- **Cross-source compound signals** (e.g., "high callouts AND register
  exceptions today on same store"). Defer to V2.
- **Predictive / forecasting features** (e.g., "this store is on track
  for an overdue compliance task next week"). Out of scope.
- **Write-back to source systems** (e.g., "mark this evidence as
  collected from the dashboard"). Explicit non-goal — the dashboard is
  read-only by design.
- **Mobile / push notifications.** Extension-only surface.
- **Multi-tenant / multi-region.** Single Walmart corp profile.

---

## Where the answers go

Answers can be:
- Posted as comments in this file (one section at a time is fine).
- Captured in a memory ("**dashboard CVP thresholds confirmed at
  green≥25/amber15-25/red<15**") for future Claude sessions.
- Saved as durable settings in `chrome.storage.sync["livedashboard.settings"]`
  once the module ships.

For **[blocker]** items, please answer before kicking off the
corresponding implementation phase in
[`live_dashboard_backend/IMPLEMENTATION_PLAN.md §9`](live_dashboard_backend/IMPLEMENTATION_PLAN.md).
For **[default-ok]** items, the documented defaults will be used unless
overridden — no action required up-front.
