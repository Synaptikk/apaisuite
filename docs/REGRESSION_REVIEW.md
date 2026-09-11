# Regression review — 2026-09-10

Reviewed the uncommitted changes from the store-isolation, onboarding,
attribution, tab-cleanup and VizPick refresh work. This report supersedes the
earlier background-tab review where they differ. No deployment was performed.

## Confirmed regressions corrected

1. **SparkFraud cleanup was too broad.** Wrapping every handler could close an
   authentication tab at the end of setup, before a later data handler used
   it. Removed the blanket handler/watchlist wrappers. Its existing idle
   ownership remains until an explicit lifetime spanning setup and data
   collection is implemented. It is deliberately not claimed to close
   immediately after every handler.
2. **Shared cleanup ignored other modules/contexts.** Module-only counters
   allowed one scoped operation to close a helper used by another. Cleanup now
   waits for scoped consumers in the context and only removes locally
   registered helpers. It cannot sweep a different context's registrations.
   Registry read-modify-write operations use Web Locks across extension
   contexts, with a local queue fallback for test environments.
3. **ClaimsDisposition sign-in handoff was closed.** A foregrounded sign-in
   page is released from automatic ownership. Only the pull handler has
   operation cleanup; status and CSV handlers no longer sweep helpers.
4. **VizPick and MetricShot could adopt each other's tabs.** Their captures now
   create exclusive helper tabs. Finishing one capture cannot close or navigate
   a tab borrowed by the other. This trades some additional page loading for
   an explicit lifetime and avoids driving an existing user's report.
5. **Unknown-source incremental captures could discard earlier lanes.** When
   Tableau's source timestamp is missing, incremental writes are withheld;
   the final result supplies the rows together. Known-source writes preserve
   existing healthy rows during a partial retry. Snapshot writes use Web Locks
   across contexts as well as local serialization.
6. **Classification loads could cross a store switch.** Classifications,
   attribution and week-list requests now share a captured store and a request
   generation. Late replies are discarded. Week data has a matching store/week
   check. Missing attribution dates no longer render as January 1970.

## Validation

- Broad run: 783 tests, 780 passed, two skipped, one failed. The failure is
  `digitalmetrics/lib/tests/wmweek.test.mjs` importing the absent
  `lib/data/wmweek.js`; that target is also absent at HEAD.
- After adding two more regressions, 15 focused tests passed for tab lifetimes,
  cross-module consumers, independent contexts, interactive handoff and stale
  store loads. The exclusive VizPick-tab and snapshot regression tests passed
  in the broad run.
- Syntax checks passed for changed JavaScript; `git diff --check` passed.
- Test fixtures mock the browser APIs; no live corporate-site operation,
  sign-in, message posting or two-PC concurrency test was performed.

## Limits and release blockers

The exact reported “No current window” incident is not reproduced. It is not
valid to claim the timing proves which cleanup closed a tab or window. The
explicit-window acquisition fix remains; its no-window branch reports a
retryable condition without opening a new browser window.

Scope counts are not distributed tab-use leases. A different context or an
unscoped operation can still borrow a helper in older acquisition paths;
exclusive ownership is verified here for the VizPick/MetricShot pair, not
every site in the suite. The idle reaper cannot consult another context's
in-memory active counter. Abrupt worker/browser termination also bypasses
finally. Live overlap testing remains necessary before publishing.

The previously reported same-store assignment lost updates, assignment
date/autosave race, filtered schedule overwrite, legacy classification seed
contamination and anonymous cross-store access remain outstanding. Attribution
does not fix them. Per-store classification rules are still undeployed.

Preserved unrelated work: the existing untracked VizPick history findings
document was not edited or incorporated into this review.
