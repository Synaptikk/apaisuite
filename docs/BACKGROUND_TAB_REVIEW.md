# Background tab lifecycle review — 2026-09-09

Policy: close extension-created data/authentication helpers when their operation
finishes, including failure and timeout. Reuse within a multi-store or lookup
batch, then close. Preserve pre-existing user tabs and intentional output tabs
(draft events, receipts, reports, print windows and manually opened sites).

| Module | Review result |
|---|---|
| ClosingList | Fixed CaseVisibility success/error cleanup, including failures before acquisition returns. IVR already uses tracked ownership and finally. |
| StockingPlan | Fixed acquisition failures and aisle child-window exceptions. Removed URL-wide cleanup that could close unrelated user tabs. Parent collection already closes owned tabs. |
| AurorBuddy | Fixed Auror authentication cleanup on all outcomes; APPRISS cleanup now includes exceptions and replacement tabs. Store/geolocation lookups already use finally. Event drafts and receipt windows remain user output. |
| ORC Monitor | Authentication now closes owned tabs on all outcomes. Coordinate lookups already use finally. Report output stays open. |
| ClaimsDisposition | Embed helpers now close after the request's store batch, including errors. Register ownership immediately after creation so initialization failures can be cleaned. |
| LiveDashboard | Hoops helper closes after its request. Compliance, Register and Recognition already have owned-tab finally cleanup. Explicit source-opening actions remain user tabs. |
| Workvivo | Manual heartbeat helper closes when the heartbeat finishes. Existing Workvivo tabs remain open. |
| SparkFraud | Owned reusable authentication helpers close after request/watchlist operations. OMS and dispatcher helper cleanup already exists. Interactive source/receipt windows are separate user actions. |
| SparkRisk | OMS helper already closes in finally. |
| SparkScanGo | No background tab creator found in module runtime. |
| DigitalLocks | No automatic background creator found; explicit Power BI opening is a user action. |
| DigitalRollup | Fixed load failures before tab acquisition returns. Main API request already closes owned tabs in finally. |
| Digital Metrics | Both Tableau and Workforce Planning acquisition already close in finally. |
| VizPick | Owned capture tabs now close on failure as well as success; interceptor cleanup failure no longer skips tab closure. Includes crawl lanes. |
| Market120 | Store clearance closes failed tabs too; clearance KPI fetch now has finally cleanup. ISA captures catch each report failure and close before processing results. |
| MetricShot | Capture already closes in finally. Fixed Sendbird credential-timeout return that leaked its newly opened tab; posting helpers already close in finally. |
| AssocPurchases (disabled) | Fixed APPRISS exceptions and MUMD initialization failure. MUMD batch release already exists. |
| Shared associate lookup | Workvivo/Workday helpers now close after outer lookup batches; concurrent calls keep the helper until every consumer finishes. Workvivo ownership registered before load wait. |

Shared tab registry updates are serialized to avoid losing another module's
registration. Active batches are protected from idle reaping, and new work
waits for a previous cleanup to finish. The idle reaper remains a fallback
for registered helpers if the service worker is interrupted.

Validation: 51 focused Node tests pass (tab helpers, session ownership,
concurrent batches, associate lookup, Sendbird REST, VizPick toolbar recovery).
Syntax checked for all modified JavaScript. Tests use mocks; no live corporate
site capture, posting, or sign-in was performed. No release was published.

Limits: a forcibly terminated worker cannot execute finally. Immediate cleanup
after a browser/worker crash is not guaranteed. Registry serialization and
operation counts apply within a JavaScript context, not a distributed lock
across multiple browser processes. Site-driven redirects/popups outside these
explicit acquisition paths still require live verification.

## Suite-wide Tableau lock (2026-09-14)

Captures that drive `stores.tableau.wal-mart.com` from hidden tabs take
`shared/tableau_lock.js::withTableauLock` and run one at a time, in arrival
order. VizPick (stores export, Today crawl) and Digital Metrics (per-store
view) both fire on their own alarm and on suite open, so they used to start
within seconds of each other and share Edge's background-tab budget; the
Digital Metrics 120 s viz wait was the one that lost. A waiter is told who
holds the lock and shows it in its own progress UI ("waiting for VizPick
stores capture to finish with Tableau"). Whole captures serialise; VizPick's
three lanes stay parallel inside its own turn. In memory only: every capture
runs in the one worker, so a dead worker leaves nothing stale. A hold past
30 min is evicted; a waiter gives up after 10 min and runs anyway.
Test: `shared/tests/tableau_lock.test.mjs`.
