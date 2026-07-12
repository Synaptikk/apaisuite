# DigitalLocks — Open Questions

These do **not** block V1. The module ships with reasonable defaults; each
question lists the current assumption and what would change if the answer
differs.

## Import / file format

1. **Is the import file Excel, CSV, or both?**
   *Assumption:* both. V1 supports `.csv` and `.xlsx`/`.xlsm` directly.
   *Change if different:* none — both already work.

2. **What is the exact column header format from the Power BI export?**
   *Assumption:* the headers observed in `digitallocks.xlsx`:
   `store · Lock name · Zone Name · Unlock Source · USER ID · FIRST NAME
   · LAST NAME · Position · Event_time`. Aliases live in
   `lib/parseLockEvents.js::HEADER_ALIASES` (case- and whitespace-insensitive)
   and accept common variants like `Store Number`, `User ID`, `First Name`,
   `Timestamp`.
   *Change if different:* add the new spelling to the appropriate alias
   array and re-import. No code change.

3. **Does the Power BI report export all stores or only filtered stores?**
   *Assumption:* whatever the user filtered in Power BI is what they want
   to review. The module never re-filters at import time.
   *Change if different:* none — but if exports start including filter
   metadata rows (e.g. `Applied filters: Column is N`), the parser drops
   them via the "all-empty natural-key row" guard.

4. **Is the user expected to filter the report before export?**
   *Assumption:* yes — by store and date range as needed.
   *Change if different:* none.

## Scope

5. **Should the module support only Market 120 or any stores?**
   *Assumption:* any stores. Nothing in the code hard-codes a store list.
   *Change if different:* could add a store allow-list to
   `data/role_zone_rules.json` if a reviewer wants imports outside Market
   120 dropped.

6. **How many days of data should each daily review include?**
   *Assumption:* whatever's in the import — the reviewer controls the
   range in Power BI. Multi-day data also unlocks the user-volume and
   day-spike rules.
   *Change if different:* none.

7. **Should new imports replace the current active review list or append
   to history?**
   *Assumption:* reviewer chooses on every import (Replace · Append ·
   Archive · Cancel modal).
   *Change if different:* could persist the choice as a per-user default.

## Rules

8. **Which positions are normal for each zone?**
   *Assumption:* the generic map in `data/role_zone_rules.json`. Notably:
   Hardlines is treated as covering Electronics, Toys, Auto, Home — this
   varies by store and is the most likely thing a real reviewer will want
   to adjust.
   *Change if different:* edit the JSON; no code change.

9. **Which lock/zone types are high risk?**
   *Assumption:* the keyword list in `data/high_risk_keywords.json`
   (electronics, cage, half-cage, phones, gaming, jewelry, sporting,
   firearms, pharmacy, wireless, tobacco, liquor, high-ticket).
   *Change if different:* edit the JSON.

10. **Should AP / Coach / TL accesses be treated differently?**
    *Assumption:* yes — they're in `broadAccessPositions` and the
    role/zone mismatch rule never fires for them. They are still subject
    to after-hours, volume, multi-zone, and unusual-source rules.
    *Change if different:* edit the JSON to remove them from the broad-
    access list.

## Lifecycle

11. **How should events be cleared?**
    *Assumption:* the reviewer opens the event drawer and picks Needs
    Follow-Up / Non-Malicious / Theft Review / Dismiss. The score and
    reasons remain unchanged — only `reviewStatus` flips.

12. **Should cleared events remain in history?**
    *Assumption:* yes. Cleared events move out of the Active tab but
    appear under History. Deleting them requires a manual delete-import or
    a future "Clear history" affordance.

13. **Should "theft" and "non-malicious" be the final disposition
    options?**
    *Assumption:* alongside Needs Follow-Up and Dismiss, yes. "Theft
    Review" is named after the downstream process, not an accusation.
    *Change if different:* add a new status to `lib/statusStore.js::STATUSES`
    + `STATUS_LABEL` + add a CSS color in `styles.css` (`.dl-status-<id>`).

14. **Should there be a "needs follow-up" status?**
    *Assumption:* yes (`needs_follow_up`).

15. **Should the daily checklist export to PDF/CSV?**
    *Assumption:* CSV in V1 (`Export checklist CSV` button on the
    Checklist tab and the Active tab). PDF deferred to V2; `pdfmake` is
    already vendored in `claimsdisposition/vendor/` and could be moved to
    `shared/vendor/` for cross-module reuse when V2 lands.

## Permissions / privacy

16. **Should imports stay on the reviewer's machine only?**
    *Assumption:* yes. V1 makes no network calls. IndexedDB and
    chrome.storage.local both live in the extension's own profile-bound
    storage; nothing syncs to other devices. Power BI link uses
    `chrome.tabs.create` which doesn't require host permissions.

17. **What is the retention policy for cleared events?**
    *Assumption:* indefinite, bounded only by manual deletion. There's no
    auto-eviction. If a retention rule is later required, add a periodic
    sweep keyed off `clearedAt` to `lib/statusStore.js`.
