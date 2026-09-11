# Multi-user and first-run review — 2026-09-09

Scope: static review of shell startup, onboarding, shared store/market identity,
Digital Metrics persistence and assignment editing, and store/market defaults
in LiveDashboard, DigitalRollup, VizPick, MetricShot and StockingPlan. This is
not a two-PC production reproduction or a review of every module's backend.

## Fixed locally, not published

- Home render could leave a settled promise in its lock when no dashboard
  header mounted. Subsequent renders starved the event loop. Regression test
  covers repeat and concurrent calls without a header.
- Market role with no manual home store now returns null rather than an
  observed or legacy hire store. An explicitly selected store still works.
- Setup now writes defaults and completion together. Blank entries clear old
  defaults when rerun. Save failures are shown and duplicate submissions are
  guarded. Store/market length validation now matches the persistence limits.
- Digital Metrics no longer chooses shared-list stores for automatic pulls or
  its default display. Schedule automation requires a home store.
- DigitalRollup's hierarchy fallback now requires exactly one available market;
  previously it chose the first of multiple markets despite its comment.

## Outstanding findings

### High: same-store lost updates

`modules/digitalmetrics/lib/firestore.js`: setDoc replaces complete documents
without an updateTime precondition. Two analysts loading the same assignment
day and editing different cells can erase each other's changes. Classification
maps have the same problem, including automatic classification versus manual
edits. The shared store list is also a read-modify-write replacement.

Use server-enforced version checks with a visible conflict/reload path for
assignment days; apply individual classification changes instead of posting
stale maps. Retrying a stale whole-document write is not a fix. Store-list
registration should use an atomic union.

### High: partial schedules replace complete schedules

`lib/sources/wfm_schedule.js` marks partial/filtered rosters but returns them.
`service.js` writes those documents unconditionally. A second analyst with a
filtered scheduler can replace the same store's complete roster. Reject these
automated writes or introduce an explicit reviewed merge.

### High: assignment date and async load races

`view.js`: setAssignmentDate changes the date before pending autosave is
flushed. saveAssignments reads the current mutable date and roster. A timer
can therefore save the previous roster under the next date. Concurrent
loadAssignments calls also have no stale-response guard. Capture the edit's
store/date at scheduling time, serialize saves, and discard superseded loads.

### High: store paths are not authorization

Firestore rules accept anonymous authenticated clients across stores. Moving
classifications under stores prevents accidental shared-document collisions,
but does not enforce store membership. Named identity and server-verified
claims are required for an actual store access boundary. Old clients still
can write wrongly labelled schedules under current rules.

### Medium: legacy classification seed remains cross-store

classifications.get reads the entire legacy map whenever a store document is
absent. This is not an isolated migration and can carry other stores' values
into a new map. Migrate against a verified store roster or explicitly abandon
the legacy map; do not assume name tokens establish store membership.

### Medium: unverified schedule identity still accepted

The earlier mismatch fix rejects a known disagreement but still fills in the
expected store when the page has no store. An unknown page is not evidence
that it belongs to the expected store. Require reliable page identification
before a schedule is written.

### Medium: defaults and viewing selection differ

DigitalRollup and VizPick can follow an explicitly viewed/cached market even
with a blank home market. Blank home market therefore does not mean all
market automation is disabled. LiveDashboard and StockingPlan can similarly
retain module settings. This is existing behavior; UI wording should describe
it consistently. Market users may choose a store inside a module without
making it their home store.

## Validation and release limits

25 focused Node tests pass (home rendering, onboarding state and boot ordering,
shared user defaults); syntax checks pass for this pass's changed JS files.
No live simultaneous-edit test or affected-PC crash reproduction was run.
Earlier Digital Metrics test run had an unresolved missing wmweek.js import.
Earlier classification rules deploy was denied; no rules or release were
deployed during this review. Current downloads do not include these fixes.

Before release: test two independent profiles editing the same day; changing
days during autosave; filtered scheduler imports; Market with blank store;
both defaults blank; failed sync-storage write; and role changes after setup.
