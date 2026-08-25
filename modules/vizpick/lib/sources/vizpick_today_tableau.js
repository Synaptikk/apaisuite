// modules/vizpick/lib/sources/vizpick_today_tableau.js
//
// Current-day ("Today") capture from the VizPickDetails view.
//
// WHY THIS IS SHAPED SO DIFFERENTLY FROM THE YESTERDAY CAPTURE
// ------------------------------------------------------------
// Discovered live 2026-08-16 (dev/probe-vizpick-view.mjs +
// dev/probe-vizpick-details-scope.mjs):
//
//   · views/VizPick/VizPick        → "This dashboard is refreshed daily for
//     the day prior."  Its date filter offers only 1. Yesterday, 2. Week to
//     Date, 3. Last WM Week, 4. Last 7 Days, 5. Last 30 Days — there is no
//     Today bucket. It DOES have a "Download Summary by Store" sheet, so one
//     export yields every store in every market.
//
//   · views/VizPick/VizPickDetails → "This dashboard is refreshed frequently
//     for the current business day. Data can be approximately 1-2 Hours
//     behind depending on upstream systems."  This is the only source of
//     current-day numbers. But it is scoped to ONE store at a time via a
//     Tableau *parameter* (a text box, aria-label="Store"), and it has no
//     Summary-by-Store sheet — only "Download Department Breakout (Current
//     Day)", whose "Total" row is that one store's rollup.
//
// So a market-wide Today necessarily means: set the Store parameter, wait for
// the viz to re-query, export, parse, repeat. That is one full export cycle
// per store, which is why the UI loads Today on demand rather than
// automatically.
//
// Read-only: sets a client-side view parameter and exports data that already
// exists. Nothing is written back to the workbook (Tableau parameter state on
// a view is per-session unless explicitly saved as a custom view, which we
// never do).

import {
  parseDeptBreakout, parseDonutHealth, parseDepartmentGroups,
  parseLocationDetails, parseLastUpdate,
} from "../parse_vizpick_stores_csv.js";
import { watchSourceSchema } from "../../../../shared/schema_watch_report.js";
import { readXlsxFile } from "../../../../shared/xlsx.js";
import { getUserHomeStore } from "../../../../shared/userStore.js";
import {
  readVizqlContext, replayExport, learnSheetIds, normaliseSheetName, summariseExportAttempt,
  base64ToBytes, base64ToText,
} from "./tableau_export_replay.js";

const DETAILS_URL = "https://stores.tableau.wal-mart.com/#/site/OnlineGrocery/views/VizPick/VizPickDetails?:iid=1&:linktarget=_self";
// See the note in vizpick_stores_tableau.js: Tableau's view name lives in the
// URL fragment, which chrome.tabs.query match patterns cannot see.
const TAB_PATTERN   = "https://stores.tableau.wal-mart.com/*";
const VIEW_FRAGMENT = /\/views\/VizPick\/VizPickDetails(?:$|[?#])/i;

const LOAD_TIMEOUT_MS   = 30_000;
const VIZ_READY_WAIT_MS = 120_000;  // cold session + SSO redirect chain; see the stores source
// A tab that is ALREADY open is warm — measured ~2s to render, hidden or
// visible (dev/probe-vizpick-bgtab.mjs). If it has not come up in this long it
// is not slow, it is broken, and reloading beats waiting.
const REUSED_TAB_READY_MS = 30_000;
const EXPORT_WAIT_MS    = 45_000;
const UPDATE_WAIT_MS    = 20_000;
const REQUERY_WAIT_MS   = 25_000;  // how long to wait for the viz to re-query after a store change
const PARAM_READY_WAIT_MS = 30_000; // the Store parameter box renders after the toolbar does
const SETTLE_MS         = 700;     // extra beat after the last vizql response lands
const DIALOG_SETTLE_MS  = 20_000;  // wait for the viz toolbar to reappear after a dialog closes
const POLL_MS           = 300;
const INSTALL_GRACE_MS  = 3_000;
// Whole-crawl ceiling. Each store costs two export cycles, so a large market
// legitimately runs for minutes — but it must still be guaranteed to end.
const OVERALL_BUDGET_MS = 25 * 60_000;

// Hard ceiling on how stale the Today snapshot may get, REGARDLESS of what the
// stamp says.
//
// The stamp is an optimisation, not a guarantee. It has now been wrong twice in
// ways that were invisible from outside: on 2026-08-22 a check reported
// "unchanged" against a stored key of 09:10:21 while a freshly loaded session
// reported 10:04:03, and no amount of reloading the reused tab shifted it. The
// underlying reason is still not fully understood.
//
// Rather than keep refining a signal that can silently pin the data forever,
// bound the damage: past this age the crawl runs whether or not the stamp
// moved. Worst case we re-crawl a market that had not changed — minutes of
// background work — against a failure mode where the tab shows hours-old
// numbers and says it is current.
//
// Set below the ~2-3h cadence the current-day data actually republishes at, so
// a genuine update is never more than this late.
const MAX_TODAY_AGE_MS = 90 * 60_000;

// How many background tabs share the crawl. Wall-clock per store (~18s) is
// almost entirely Tableau round-trips — set parameter, wait for the re-query,
// two export dialogs — with the extension idle in between, so the work divides
// nearly linearly across tabs. Three is the point of diminishing returns: each
// tab holds a whole viz in memory, and beyond that the shared vizql backend
// starts queueing our own requests behind each other.
const MAX_TABS = 3;

const DEPT_SHEET   = { match: "download department breakout (current day)", fallbackIndex: 3 };
// The department breakout has no Location %, Overstock % or VizPick composite —
// only this sheet carries the current-day equivalents of the dashboard rings,
// which is why each store costs two exports rather than one.
const DONUT_SHEET  = { match: "vizpick donut health", fallbackIndex: 11 };
// Fresh / F&C / GM, exactly as Tableau scores them. metricshot used to derive
// these from the department breakout because a third DOM export cost 5-8s per
// store; at ~700ms via the replay that trade no longer holds, and the derived
// version was badly low (57.9/8.2/0.05 against Tableau's 66/28/20 on the same
// store). Sheet index confirmed live 2026-08-22.
const GROUP_SHEET  = { match: "department groups donuts health", fallbackIndex: 1 };
// Per-location detail: Locations Seen % per department, and which bins still
// hold un-pulled suggested picks with who last scanned them. Sheet index
// confirmed live 2026-08-22.
const LOC_SHEET    = { match: "download location details", fallbackIndex: 4 };
const UPDATE_SHEET = { match: "last update",                                fallbackIndex: 6 };

// Header unique to the department-breakout export; "Suggested Picks" does not
// appear in the Summary-by-Store crosstab, so it cannot cross-match.
const DEPT_CSV_NEEDLE = "Suggested Picks";
// Unique to the donut-health sheet.
const DONUT_CSV_NEEDLE = "New VizPick";
// Unique to the department-groups sheet. "New VizPick" also appears there, so
// this must key off the group column instead or the two cross-match.
const GROUP_CSV_NEEDLE = "Department Group";
// Unique to the location-details sheet.
const LOC_CSV_NEEDLE = "last_seen_timestamp";

/**
 * Capture current-day figures for a list of stores.
 *
 * @param {string[]} stores       Store numbers, in the order to visit them.
 * @param {object}   [opts]
 * @param {(p:{done:number,total:number,store:string})=>void} [opts.onProgress]
 * @param {() => boolean} [opts.isCancelled]  Polled between stores.
 * @param {(info:{row:object,sourceUpdate:object|null,topUp:boolean,index:number})=>Promise<void>} [opts.onStore]
 *   Called as soon as each store is parsed, so the caller can persist and
 *   display it immediately instead of the UI sitting empty for the whole
 *   multi-minute crawl.
 * @param {string|null} [opts.knownSourceKey]  Stamp of the data already stored
 *   for this same market; when it matches, the whole crawl is skipped.
 * @param {string[]} [opts.coveredStores]  Stores already held at that stamp;
 *   when the stamp matches, only stores NOT in this list are visited.
 * @param {boolean} [opts.force]  Crawl even if the stamp is unchanged.
 * @param {number}  [opts.concurrency]  How many background tabs to crawl with
 *   (capped at MAX_TABS). 1 restores the old serial behaviour.
 * @returns {Promise<object>}
 */
export async function fetchVizpickTodayTableau(stores, opts = {}) {
  const wanted = (stores || []).map((s) => String(s).trim()).filter(Boolean);
  if (!wanted.length) {
    return { ok: false, errorClass: "INPUT", error: "No stores requested for the Today capture." };
  }

  // Resolved once for the whole crawl: it decides whether a store keeps its
  // full location-scan list (see the note at the parseLocationDetails call).
  // A failure here is not fatal — it just means nobody gets the wider list,
  // and metricshot falls back to the outstanding-picks bins.
  const homeStore = await getUserHomeStore().catch(() => null);

  // Not const: replaced if the tab we adopted turns out to be
  // toolbar-suppressed (see the recovery below).
  let opened = await findOrOpenReportTab();
  if (!opened) {
    return { ok: false, errorClass: "TAB", error: "Could not open the Tableau VizPick Details tab." };
  }

  // Background tabs, never focused — see the note in vizpick_stores_tableau.js.
  // It matters far more here: the crawl runs two exports per store, so
  // foregrounding would yank the user out of whatever they're doing once per
  // store for several minutes.
  //
  // Every tab this run touches. The first may be one the user already had
  // open, in which case didOpen is false and we must leave it exactly as
  // found; the extra lanes are always ours to close.
  const tabs = [opened];
  // Not const: a reused tab that turns out to be toolbar-suppressed is
  // abandoned and replaced with one of ours. See the recovery below.
  let primaryId = opened.tab.id;

  // A run the USER started leaves a failed tab open so they can look at it.
  // A background auto-check must not: the user never asked for a tab, so an
  // orphan is litter — and if it is later closed, an error still telling them
  // to "confirm data renders there" points at nothing.
  const keepFailedTab = !opts.auto;
  const tabHint = keepFailedTab
    ? " The tab was left open — confirm data renders there, then Refresh again."
    : " This ran automatically in the background; its tab was closed. Open the module and click Refresh to see the failure live.";

  let succeeded = false;
  const rows = [];
  const failures = [];

  // Getting to the first store takes a while — cold viz render, then the
  // source-stamp export, then opening and preparing the extra lanes. Left
  // silent, that is over a minute of a UI that says nothing, which reads as a
  // hang. Report the staging steps by name so there is always something moving.
  const stage = (label) =>
    opts.onProgress?.({ stage: label, done: 0, total: wanted.length, store: null });

  try {
    stage(opened.didOpen ? "Opening the VizPick Details tab" : "Reusing the open VizPick Details tab");
    // An already-open tab is either warm (renders in ~2s) or broken. The long
    // cold-session budget only applies to a tab we just created; spending it
    // on a reused one just delays the reload that actually fixes it.
    let primaryReady = await prepareTab(primaryId, {
      readyWaitMs: opened.didOpen ? VIZ_READY_WAIT_MS : REUSED_TAB_READY_MS,
    });

    // A REUSED tab is the dangerous case. A failed run deliberately leaves its
    // tab open for the user to inspect — and findOrOpenReportTab then hands
    // that same tab to the next run. If it is discarded, session-expired, or
    // was left mid-teardown, every subsequent capture inherits the wreckage
    // and fails identically, forever, while a freshly opened tab would have
    // worked. (This is what "live data still not loading" looked like: the
    // same SESSION error on repeat, on a view that renders in ~2s cold.)
    //
    // So: reload it once and try again before giving up. Only for reused tabs
    // — a tab we just created has nothing stale to shed, and a second
    // VIZ_READY_WAIT_MS would just double the wait before the real error.
    // A toolbar-suppressed tab is NOT stale and reloading cannot help — it
    // comes back with the same `:toolbar=n` url. It belongs to another module
    // (MetricShot opens exactly this view embedded), so leave it untouched and
    // open one of our own instead of failing the whole crawl.
    //
    // Before this, adopting that tab was terminal: every store in the market
    // failed, the Today tab sat frozen at its last good pull, and the error
    // said "still rendering — retrying often works".
    if (!primaryReady.ok && primaryReady.toolbarSuppressed && !opened.didOpen) {
      stage("The open tab has no toolbar — opening our own");
      const fresh = await chrome.tabs.create({ url: DETAILS_URL, active: false }).catch(() => null);
      if (fresh?.id != null) {
        opened = { tab: fresh, didOpen: true };
        tabs[0] = opened;
        primaryId = fresh.id;
        await keepAwake(primaryId);
        primaryReady = await prepareTab(primaryId, { readyWaitMs: VIZ_READY_WAIT_MS });
      }
    }

    if (!primaryReady.ok && !opened.didOpen) {
      stage("Reloading a stale Tableau tab");
      await chrome.tabs.reload(primaryId, { bypassCache: true }).catch(() => {});
      primaryReady = await prepareTab(primaryId);
    }

    if (!primaryReady.ok) {
      // Name what actually went wrong. "session may need SSO re-auth" for a
      // page that rendered fine but never produced the Store control sends the
      // user off re-authenticating a session that was never the problem.
      const diag = await diagnoseUnrenderedTab(primaryId, primaryReady.reason);
      return {
        ok: false,
        errorClass: diag.errorClass,
        error: diag.message + tabHint,
        debug: diag,
        keptTabOpen: keepFailedTab,
      };
    }

    // ── Source timestamp. On this view it is a FULL timestamp
    // ("2026-08-16 10:26:07"), which is what makes an honest absolute
    // "Last updated" display possible for Today.
    //
    // Read on the primary tab BEFORE fanning out: it is one export, every lane
    // would return the same answer, and the skip decision below may mean no
    // extra tabs need opening at all.
    // A REUSED tab reports the stamp of ITS OWN vizql session, not the
    // server's current state. A tab left open since 09:10 keeps exporting
    // "09:10:21" however many hours pass, so the skip check compares a stale
    // reading against the stored key it produced, matches, and skips forever —
    // observed 2026-08-22, where the stored key was 09:10:21 while a freshly
    // loaded session reported 10:04:03.
    //
    // So: reload before reading, unless this run opened the tab itself. One
    // page load per check, against a check that otherwise cannot ever notice
    // new data. `didOpen` is already tracked by findOrOpenReportTab().
    if (!opened.didOpen) {
      stage("Refreshing the Tableau session");
      try {
        await chrome.tabs.reload(primaryId, { bypassCache: false });
        await waitForTabLoad(primaryId, LOAD_TIMEOUT_MS);
        if (!(await waitForVizReady(primaryId, REUSED_TAB_READY_MS))) {
          // Not fatal: a stale stamp is still better than no capture, and the
          // per-store exports below re-render anyway.
          failures.push({ store: "(session)", reason: "viz did not return after the session refresh", soft: true });
        }
      } catch (e) {
        failures.push({ store: "(session)", reason: `session refresh: ${String(e?.message ?? e)}`, soft: true });
      }
    }

    stage("Reading Tableau's last-update time");
    const sourceUpdate = await readSourceStamp(primaryId);

    // ── Skip the crawl when nothing has been republished ───────────────
    // This matters far more here than on the yesterday capture: the crawl is
    // two exports per store and takes minutes. If Tableau's current-day stamp
    // is the one we already have for this market, there is nothing to fetch.
    // An unchanged stamp means the stored rows are still valid — but ONLY for
    // the stores they actually contain. Comparing the stamp alone was a bug: a
    // partial snapshot (3 of 10 stores, say, because a previous run was
    // cancelled or scoped to fewer stores) looked "current", so the missing 7
    // were never fetched and the tab silently stayed short.
    //
    // Full coverage  -> skip entirely.
    // Partial        -> visit only the gaps; the caller MERGES the result.
    // Changed stamp  -> everything is stale, crawl the lot.
    let toVisit = wanted;
    let topUp = false;
    // Compared on the NORMALISED iso, falling back to the raw string. The
    // stamp can now arrive from two places — the dashboard's own "Updated"
    // text or the Last-update sheet export — and those could render the same
    // instant differently ("2026-08-22 07:04:54" vs "8/22/2026 7:04:54 AM").
    // A raw-only compare would read that as "changed" on every check and
    // re-crawl the whole market forever.
    const knownIso = opts.knownSourceKey ? (parseLastUpdate(opts.knownSourceKey).iso || null) : null;
    const stampMatches =
      !opts.force && !!opts.knownSourceKey && !!sourceUpdate && (
        (knownIso && sourceUpdate.iso && sourceUpdate.iso === knownIso) ||
        (!!sourceUpdate.raw && sourceUpdate.raw === opts.knownSourceKey)
      );

    // The stamp says nothing changed — but how old is what we are holding?
    const storedAgeMs = opts.knownCapturedAt
      ? Date.now() - new Date(opts.knownCapturedAt).getTime()
      : Infinity;
    const tooOldToTrust = storedAgeMs > MAX_TODAY_AGE_MS;
    const stampUnchanged = stampMatches && !tooOldToTrust;
    if (stampMatches && tooOldToTrust) {
      stage(`Stamp unchanged but the stored data is ${Math.round(storedAgeMs / 60_000)}min old — refreshing anyway`);
    }

    if (stampUnchanged) {
      const covered = new Set((opts.coveredStores || []).map((x) => String(x).trim()));
      const missing = wanted.filter((st) => !covered.has(st));
      if (!missing.length) {
        succeeded = true;
        return {
          ok: true, unchanged: true, sourceUpdate, checkedAt: new Date().toISOString(),
          // BOTH sides of the comparison that produced this decision. Without
          // them "unchanged: true" is unfalsifiable from the outside: on
          // 2026-08-22 the server reported 10:04:03 while the stored key was
          // 09:10:21 — plainly different — and the crawl still skipped, with
          // no way to see which value it had actually read. Never report a
          // skip without showing what was compared.
          stampRead: sourceUpdate?.raw ?? null,
          stampReadIso: sourceUpdate?.iso ?? null,
          stampReadVia: sourceUpdate?.via ?? null,
          stampKnown: opts.knownSourceKey ?? null,
          stampKnownIso: knownIso,
          storedAgeMin: Number.isFinite(storedAgeMs) ? Math.round(storedAgeMs / 60_000) : null,
        };
      }
      toVisit = missing;
      topUp = true;
    }

    // ── Open the extra lanes ───────────────────────────────────────────
    // Only now, once we know there is real work: an unchanged stamp with full
    // coverage returns above without ever creating a second tab.
    const laneTarget = Math.max(1, Math.min(MAX_TABS, Number(opts.concurrency) || MAX_TABS));
    const laneCount = Math.min(laneTarget, toVisit.length);
    if (laneCount > 1) stage(`Opening ${laneCount} background tabs`);
    for (let i = 1; i < laneCount; i++) {
      const t = await chrome.tabs.create({ url: DETAILS_URL, active: false }).catch(() => null);
      // Lane tabs are unfocused for the whole crawl — prime Memory Saver bait.
      if (t) { await keepAwake(t.id); tabs.push({ tab: t, didOpen: true }); }
    }
    // Prepared concurrently — they are all doing the same cold SSO + viz
    // render, so serialising the waits would cost a full render each.
    const ready = await Promise.all(
      tabs.map((rec, i) => (i === 0 ? Promise.resolve({ ok: true }) : prepareTab(rec.tab.id)))
    );
    // A lane that never became usable is dropped, not fatal: the crawl simply
    // runs narrower. Recorded so a systematically failing lane is visible in
    // debug rather than just looking like a slow run.
    const lanes = tabs.filter((_, i) => ready[i].ok);
    ready.forEach((r, i) => {
      if (!r.ok) failures.push({ store: "(lane)", reason: `extra tab ${i}: ${r.reason}; crawling with ${lanes.length} lane(s)`, soft: true });
    });

    // ── Shared work queue ──────────────────────────────────────────────
    // Drained by index rather than sliced up front: stores differ in how long
    // Tableau takes on them, and static slices leave lanes idle at the end
    // waiting on whichever one drew the slow stores.
    const startedAt = Date.now();
    const deadline  = startedAt + OVERALL_BUDGET_MS;
    let next = 0;
    let done = 0;
    let cancelled = false;
    let exhausted = false;

    // onStore ultimately does a read-modify-write on chrome.storage.local
    // (mergeToday). Two lanes publishing at once would each read the same
    // snapshot and the later write would silently drop the earlier lane's row,
    // so the crawl would quietly come up short. One chain, one writer at a
    // time — the lanes stay parallel, only the persist is serialised.
    // Shared across every lane: the first lane to drive a DOM dialog learns the
    // sheetdocIds, and the rest replay. One dialog per sheet per market rather
    // than one per store per sheet.
    // A/B switch on the replay (2026-08-23). The donut-health export started
    // failing for ~80% of stores in the same change that first made the replay
    // engage, and the two are indistinguishable from the outside — a store
    // with no health rings looks identical whichever route dropped it. Set
    // `vizpick.debug.noReplay` in chrome.storage.local to force every export
    // down the DOM dialog and compare. Default off; this is an instrument, not
    // a feature.
    const noReplay = !!(await chrome.storage.local
      .get("vizpick.debug.noReplay")
      .then((g) => g?.["vizpick.debug.noReplay"])
      .catch(() => false));
    const replay = noReplay ? null : makeReplayState();

    let publishChain = Promise.resolve();
    const publish = (info) => {
      publishChain = publishChain.then(() => opts.onStore?.(info)).catch(() => {});
      return publishChain;
    };

    const runLane = async (rec) => {
      for (;;) {
        if (opts.isCancelled?.()) { cancelled = true; return; }
        if (Date.now() > deadline) { exhausted = true; return; }
        // Claim is a single synchronous step, so no two lanes can take the
        // same index however the awaits below interleave.
        const i = next++;
        if (i >= toVisit.length) return;
        const store = toVisit[i];

        // ETA from measured throughput (stores per ms across ALL lanes), not
        // from one lane's pace — otherwise three tabs would still quote the
        // serial estimate. A four-minute crawl with a bare "2 of 10" reads as
        // a hang; with "~1m left" it reads as progress.
        //
        // Withheld until every lane has finished something. With L lanes in
        // flight, the first completion has L stores' worth of work behind it
        // but only 1 counted, so elapsed/done overstates the per-store cost by
        // ~L× — observed quoting "about 2m left" on a crawl that had 48s to
        // run. No number beats a wrong one.
        const elapsed = Date.now() - startedAt;
        opts.onProgress?.({
          done,
          total: toVisit.length,
          store,
          elapsedMs: elapsed,
          etaMs: done >= lanes.length ? Math.round((elapsed / done) * (toVisit.length - done)) : null,
          lanes: lanes.length,
        });

        const row = await captureStore(rec.tab.id, store, failures, replay, sameStore(store, homeStore));
        done++;
        if (!row) continue;
        rows.push(row);

        // Publish this store straight away. Persisting per store also means a
        // crawl that dies at store 7 keeps those 7 — and because the skip logic
        // is coverage-aware, the next run tops up only the remainder.
        await publish({ row, sourceUpdate, topUp, index: i });
      }
    };

    await Promise.all(lanes.map(runLane));
    await publishChain;   // the last lane's write may still be queued

    if (cancelled) {
      return { ok: false, errorClass: "CANCELLED", error: "Today capture cancelled.", rows, sourceUpdate, keptTabOpen: keepFailedTab };
    }
    if (exhausted) {
      failures.push({ store: "(remaining)", reason: `overall ${Math.round(OVERALL_BUDGET_MS / 60000)}min budget exhausted after ${done} of ${toVisit.length} stores` });
    }
    opts.onProgress?.({ done: toVisit.length, total: toVisit.length, store: null, lanes: lanes.length });

    if (!rows.length) {
      return {
        ok: false,
        errorClass: "NO_CAPTURE",
        error: `Captured no current-day data for any of the ${toVisit.length} stores attempted.`,
        debug: { failures },
        keptTabOpen: keepFailedTab,
      };
    }

    succeeded = true;
    // Coverage is decided by what came back, not by what went wrong. A store
    // is missing only if it produced no row.
    const capturedStores = new Set(rows.map((r) => String(r.store)));
    const missingStores = toVisit.map(String).filter((s2) => !capturedStores.has(s2));
    return {
      ok: true,
      rows,
      sourceUpdate,
      capturedAt: new Date().toISOString(),
      // Partial means STORES ARE MISSING — a requested store produced no row
      // at all. It does NOT mean "something went wrong somewhere".
      //
      // This used to be `failures.length > 0`, which counts SOFT failures too:
      // a store whose donut sheet failed still yields a row, it just renders
      // without its health rings. One soft failure therefore made a complete
      // 10-of-10 capture announce "Some stores could not be captured", which is
      // simply false and sends the reader hunting for a store that is right
      // there on screen. The two conditions need different words, so they need
      // different fields.
      //
      // Partial success is normal here for a real reason: a market can contain
      // a store the user's Tableau row-level security doesn't cover.
      partial: missingStores.length > 0,
      missingStores,
      // Captured, but thin — present in `rows` with some sheet absent.
      incompleteStores: rows.filter((r) => !r.hasHealth).map((r) => String(r.store)),
      // The caller must MERGE rather than replace when this is a top-up, or it
      // throws away the stores it already had.
      topUp,
      debug: {
        requested: wanted.length,
        visited: toVisit.length,
        topUp,
        lanes: lanes.length,
        elapsedMs: Date.now() - startedAt,
        captured: rows.length,
        withHealth: rows.filter((r) => r.hasHealth).length,
        // How much of this crawl avoided the dialog. `replayed` should climb to
        // roughly 2x(stores-1) once the GUIDs are learned; if it stays at 0 the
        // learning step is failing and every store is paying the slow route.
        replay: replay ? {
          sheetsLearned: replay.learned,
          replayed: replay.replayed,
          fellBack: replay.fellBack,
          replayMs: replay.ms,
          haveContext: replay.ctxByTab.size,
        } : { disabled: true },
        failures,
      },
    };
  } finally {
    for (const rec of tabs) {
      await setSuppressDownloads(rec.tab.id, false);
      // At most ONE tab survives a failure, and only when the user is sitting
      // there to look at it. The extra lanes are identical views — three
      // orphans diagnose nothing and just clutter the tab strip.
      const keepThis = !succeeded && keepFailedTab && rec.tab.id === primaryId;
      if (rec.didOpen && !keepThis) chrome.tabs.remove(rec.tab.id).catch(() => {});
    }
  }
}

/**
 * One store, in one lane: point the viz at it, then take the two exports it
 * needs. Returns the row, or null after recording why not.
 *
 * Lanes never share a tab, so this needs no locking — all its state is the
 * capture ring inside the tab it was handed.
 */
// Compared NUMERICALLY: getUserHomeStore() strips leading zeros ("...s01458"
// -> "1458") while the Tableau Store column is passed through verbatim, so a
// string compare would miss a store the export writes padded.
function sameStore(a, b) {
  if (a == null || b == null) return false;
  const x = Number(a), y = Number(b);
  return Number.isFinite(x) && Number.isFinite(y) && x === y;
}

async function captureStore(tabId, store, failures, replay, isHomeStore = false) {
  try {
    // Clear first so "a new vizql response arrived" is an unambiguous
    // signal that THIS store's re-query completed.
    await clearRing(tabId);

    let set = await setStoreParameter(tabId, store);
    if (!set.ok) {
      // Tableau re-renders the parameter panel around dialog teardown, so a
      // lane can momentarily have no Store box even after a clean start. Give
      // it back once before writing the store off.
      await waitForStoreParam(tabId, PARAM_READY_WAIT_MS);
      set = await setStoreParameter(tabId, store);
    }
    if (!set.ok) { failures.push({ store, reason: `parameter: ${set.reason}` }); return null; }

    // Wait for Tableau to actually re-query before exporting. Without this the
    // export races the parameter change and silently returns the PREVIOUS
    // store's numbers — the worst possible failure, since it looks like valid
    // data.
    //
    // But a parameter set to the value it already held fires no query at all,
    // so waiting for one burns REQUERY_WAIT_MS and then discards a store whose
    // data was on screen the whole time. That is exactly what happened to the
    // first store of every crawl, whenever the view's default Store matched
    // it. Nothing changed means nothing to wait for.
    if (String(set.before ?? "").trim() !== String(store).trim()) {
      const requeried = await waitForRequery(tabId, REQUERY_WAIT_MS);
      if (!requeried) { failures.push({ store, reason: "viz did not re-query after store change" }); return null; }
      await sleep(SETTLE_MS);
    }

    const dept = await exportSheetText(tabId, DEPT_SHEET, DEPT_CSV_NEEDLE, replay);
    if (!dept.ok) { failures.push({ store, reason: dept.reason }); return null; }

    const parsed = parseDeptBreakout(dept.text);
    // Watch the header row whether or not the parse succeeded. The valuable
    // signal is a shape change that STILL parses — the warning shot before the
    // change that breaks us. Fire-and-forget; cannot affect this capture.
    watchSourceSchema("vizpick.deptBreakout", dept.text, parsed.ok);
    if (!parsed.ok) {
      // Name the SHEET, not just the columns. "unexpected columns; got: Dept,
      // Suggested Picks Seen, …" is the department breakout's own header row —
      // so a reason like that means some other sheet's parser ran on this
      // text, or this text is some other sheet. Without `via` and the first
      // line there is no way to tell which, and the two have opposite fixes.
      failures.push({
        store,
        reason: `dept parse (via ${dept.via || "?"}): ${parsed.reason}`,
        firstLine: String(dept.text || "").split(/\r?\n/)[0].slice(0, 200),
      });
      return null;
    }

    // Second export for this same store: the donut-health sheet, which is the
    // only current-day source of Location %, Overstock % and the VizPick
    // composite. The viz is already showing this store, so no re-query is
    // needed — just re-open the dialog on a different sheet. Non-fatal:
    // without it the card still renders its picks/cases numbers, just without
    // those three rings.
    let health = null;
    try {
      // The crosstab dialog from the export above is still tearing down, and
      // while it is up Tableau removes the viz toolbar from the DOM — so
      // firing the next export immediately finds no Download button and
      // silently does nothing. Wait for the toolbar to come back first.
      // No toolbar wait here any more — exportSheetText does it, and only when
      // it is actually about to drive the dialog. A replay never opens one, so
      // waiting unconditionally would have burned up to DIALOG_SETTLE_MS (20s)
      // per store for nothing once the GUIDs are learned.
      {
        let donut = await exportSheetText(tabId, DONUT_SHEET, DONUT_CSV_NEEDLE, replay);
        if (!donut.ok) {
          // Never silent: a failed second export used to look like a clean run
          // that merely happened to have no health data.
          failures.push({ store, reason: `donut: ${donut.reason}`, soft: true });
        } else {
          let dh = parseDonutHealth(donut.text);

          // The replay can come back with a DIFFERENT SHAPE than the dialog
          // does for this sheet — a two-column "VizPick, 93.33…" instead of the
          // five ring columns — and it still contains the needle, so the
          // needle check inside exportSheetText passes it through. Measured
          // 2026-08-24: 8 of 10 stores lost their health rings this way, and
          // the two that kept them were exactly the two that had driven the
          // dialog to learn the sheet ids.
          //
          // The dialog demonstrably returns the right shape, so fall back to it
          // once rather than dropping the rings. Costs one dialog for the store
          // that hits it; the alternative is a card with three blank rings.
          if (!dh.ok && donut.via === "replay") {
            const viaDom = await exportSheetText(tabId, DONUT_SHEET, DONUT_CSV_NEEDLE, null);
            if (viaDom.ok) {
              const retry = parseDonutHealth(viaDom.text);
              if (retry.ok) { dh = retry; donut = viaDom; }
            }
          }

          if (dh.ok) health = dh.health;
          else {
            failures.push({
              store,
              reason: `donut parse (via ${donut.via || "?"}): ${dh.reason}`,
              soft: true,
            });
          }
        }
      }
    } catch (e) {
      failures.push({ store, reason: `donut: ${String(e?.message ?? e)}`, soft: true });
    }

    // `depts` is part of the stored row: it drives the card's Show-details
    // breakdown. Already filtered to departments in play (see
    // parseDeptBreakout), so this is tens of small rows per store, not ninety.
    // Third export: Fresh/F&C/GM as Tableau scores them. Soft — the card
    // still renders its four rings without these, and metricshot falls back to
    // deriving them from `depts`. Only affordable because of the replay; via
    // the dialog this cost 5-8s per store and was rightly reverted.
    let deptGroups = null;
    try {
      const grp = await exportSheetText(tabId, GROUP_SHEET, GROUP_CSV_NEEDLE, replay);
      if (!grp.ok) {
        failures.push({ store, reason: `groups: ${grp.reason}`, soft: true });
      } else {
        const g = parseDepartmentGroups(grp.text);
        watchSourceSchema("vizpick.deptGroups", grp.text, g.ok);
        if (g.ok) deptGroups = g.groups;
        else failures.push({ store, reason: `groups parse: ${g.reason}`, soft: true });
      }
    } catch (e) {
      failures.push({ store, reason: `groups: ${String(e?.message ?? e)}`, soft: true });
    }

    // Fourth export: per-location detail. Soft — everything above still
    // renders without it. Affordable only via the replay (~700ms); through the
    // dialog this would be another 5-8s per store.
    let locations = null;
    try {
      const loc = await exportSheetText(tabId, LOC_SHEET, LOC_CSV_NEEDLE, replay);
      if (!loc.ok) {
        failures.push({ store, reason: `locations: ${loc.reason}`, soft: true });
      } else {
        // The full scan list is kept for the user's OWN store only. metricshot
        // reads it to build the "Un-scanned locations" section of its Workvivo
        // post, which ranks every scanned bin by staleness — a wider set than
        // `gaps`, which holds only bins with picks still outstanding. Keeping
        // it market-wide would be thousands of rows a day for a section that
        // only ever covers one store; making metricshot re-export the same
        // sheet to get it is the duplicate pull this replaces.
        const L = parseLocationDetails(loc.text, { allScans: isHomeStore });
        watchSourceSchema("vizpick.locationDetails", loc.text, L.ok);
        if (L.ok) locations = { byDept: L.byDept, gaps: L.gaps, scans: L.scans, locationCount: L.locationCount };
        else failures.push({ store, reason: `locations parse: ${L.reason}`, soft: true });
      }
    } catch (e) {
      failures.push({ store, reason: `locations: ${String(e?.message ?? e)}`, soft: true });
    }

    return {
      store, ...parsed.total, ...(health || {}),
      depts: parsed.depts || [], deptCount: parsed.deptCount, hasHealth: !!health,
      // Per-department location rollup + the bins still holding picks.
      locations,
      // Tableau's own group scores. null (not []) when the export failed, so
      // the consumer can tell "no data" from "genuinely empty".
      deptGroups,
    };
  } catch (e) {
    failures.push({ store, reason: String(e?.message ?? e) });
    return null;
  }
}

/**
 * Get a tab from "just created / just found" to "ready to export from": page
 * loaded, capture hook installed, viz rendered, file writes suppressed.
 * Every lane runs this, so it must be safe to call on several tabs at once.
 */
async function prepareTab(tabId, opts = {}) {
  // Ask Chrome to stop reclaiming this tab. The crawl runs for minutes in a tab
  // nobody is looking at, which is exactly what Memory Saver targets.
  await keepAwake(tabId);

  // Both dormant states report status "complete", so waitForTabLoad would
  // return instantly on a tab that either has no document (discarded) or has
  // one that cannot run (frozen). Reloading resumes it; every check below is
  // meaningless until it does.
  const t0 = await chrome.tabs.get(tabId).catch(() => null);
  if (t0?.discarded || t0?.frozen) {
    await chrome.tabs.reload(tabId, { bypassCache: false }).catch(() => {});
  }

  await waitForTabLoad(tabId, LOAD_TIMEOUT_MS);

  if (!(await waitForCaptureInstalled(tabId, INSTALL_GRACE_MS))) {
    await chrome.tabs.reload(tabId, { bypassCache: false });
    await waitForTabLoad(tabId, LOAD_TIMEOUT_MS);
    await waitForCaptureInstalled(tabId, INSTALL_GRACE_MS);
  }

  // A `:toolbar=n` tab renders the viz perfectly and simply has no toolbar —
  // and the export is driven through the toolbar's Download button. Detected
  // from the DOM rather than the url (see waitForVizReadyOrSuppressed), and
  // bailed on after a short grace instead of burning the full 120s budget per
  // lane and then reporting "still rendering — retrying often works".
  const ready = await waitForVizReadyOrSuppressed(tabId, opts.readyWaitMs ?? VIZ_READY_WAIT_MS);
  if (ready === "suppressed") {
    return { ok: false, reason: "toolbar suppressed", toolbarSuppressed: true };
  }
  if (!ready) {
    return { ok: false, reason: "the viz never rendered" };
  }

  // The toolbar is NOT a sufficient readiness signal for THIS view. Tableau
  // paints the download button before the parameter controls finish
  // rendering, and the crawl's first act on every store is to type into the
  // Store parameter.
  //
  // Measured 2026-08-16 (dev/test-vizpick-lanes.mjs): serially, the crawl got
  // away with it purely by accident — the source-stamp export runs first and
  // buys ~20s of slack. The moment extra lanes went straight from "toolbar
  // exists" to setStoreParameter, two of three stores died with "no Store
  // parameter input in this frame". Waiting for the control we are actually
  // about to drive is the honest check.
  if (!(await waitForStoreParam(tabId, PARAM_READY_WAIT_MS))) {
    return { ok: false, reason: "the Store parameter control never rendered" };
  }

  // One export per store would mean one downloaded file per store on every
  // refresh. We already hold the bytes from the Blob, so suppress the write.
  await setSuppressDownloads(tabId, true);
  return { ok: true };
}

/**
 * Wait for the Store parameter textbox itself, in any frame. Matches exactly
 * what setStoreParameter() looks for, so a pass here means that call can work.
 */
async function waitForStoreParam(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world:  "MAIN",
        func:   () => !!(
          document.querySelector('textarea[aria-label="Store"], input[aria-label="Store"]') ||
          [...document.querySelectorAll("textarea,input")].find(
            (n) => (n.getAttribute("aria-label") || "").trim().toLowerCase() === "store"
          )
        ),
      });
      if ((results || []).some((r) => r?.result === true)) return true;
    } catch {}
    await sleep(POLL_MS);
  }
  return false;
}

/**
 * The dashboard prints its own "Updated <timestamp>" in the top right. Reading
 * that text is nearly free; exporting the Last-update sheet to learn the same
 * thing costs a full crosstab cycle — open the dialog, match the sheet, export,
 * poll for the blob — which is the expensive part of this whole module.
 *
 * That mattered because the current-day data only republishes every few hours,
 * so the overwhelming majority of scheduled checks exist purely to discover
 * that nothing changed. Paying an export for each of those was the waste.
 *
 * allFrames: the portal URL renders the viz inside an iframe, the ?:embed=y URL
 * does not — see dev/VIZPICK_EXPORT_FINDINGS.md.
 *
 * Matched by shape rather than by a Tableau class name: the markup is generated
 * and its class names are not a contract, but "a date near the word Updated" is
 * what the dashboard is actually promising the reader.
 */
async function readSourceStampFromDom(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const RE = /(\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}(?::\d{2})?|\d{1,2}\/\d{1,2}\/\d{4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)?)/i;
        if (!document.body) return null;
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const text = (node.nodeValue || "").trim();
          if (!text) continue;
          const m = RE.exec(text);
          if (!m) continue;
          // ONLY a date that is actually labelled counts. An earlier version
          // fell back to the first date found anywhere on the page, which is a
          // silent-wrong-answer machine: an unrelated but stable date would be
          // read as the source stamp and every future check would report
          // "unchanged" while real data moved underneath. Returning null here
          // costs one sheet export and is always correct.
          let ctx = "";
          try { ctx = node.parentElement?.closest("div,span,td,th")?.innerText || ""; } catch {}
          if (/updated|last\s*update/i.test(ctx)) return m[1];
        }
        return null;
      },
    });
    for (const r of results || []) if (r?.result) return r.result;
  } catch { /* fall through to the export */ }
  return null;
}

/** Tableau's own "Last update" stamp for the current-day view, or null. */
async function readSourceStamp(tabId) {
  // Cheap path first. If it yields a parseable stamp we trust it: it is the
  // number the dashboard itself is showing the user.
  const fromDom = await readSourceStampFromDom(tabId);
  if (fromDom) {
    const p = parseLastUpdate(fromDom);
    if (p.ok) return { raw: p.raw, iso: p.iso, hasTime: p.hasTime, via: "dom" };
  }
  // Fallback: the authoritative sheet. Costs an export cycle, so it only runs
  // when the page did not show a stamp we could read.
  try {
    await clearRing(tabId);
    const t = await triggerCrosstabExport(tabId, UPDATE_SHEET);
    if (!t.ok) return null;
    const lu = await pollForCsv(tabId, UPDATE_WAIT_MS, "\t");
    if (!lu) return null;
    const p = parseLastUpdate(lu.respBody);
    return p.ok ? { raw: p.raw, iso: p.iso, hasTime: p.hasTime, via: "export" } : null;
  } catch {
    return null;   // metadata only — never fail the crawl over it
  }
}

// ── Store parameter ────────────────────────────────────────────────────────
// The Store control is a Tableau parameter rendered as a <textarea> with
// aria-label="Store" and the hint "After typing a new value, press ENTER to
// commit or Escape to revert." React-style value setters must be used or the
// framework never sees the change.
async function setStoreParameter(tabId, store) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world:  "MAIN",
      args:   [store],
      func:   (value) => {
        const el =
          document.querySelector('textarea[aria-label="Store"], input[aria-label="Store"]') ||
          [...document.querySelectorAll("textarea,input")].find(
            (n) => (n.getAttribute("aria-label") || "").trim().toLowerCase() === "store"
          );
        if (!el) return { ok: false, reason: "no Store parameter input in this frame" };

        const before = el.value;
        const proto = el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;

        el.focus();
        if (setter) setter.call(el, String(value)); else el.value = String(value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));

        for (const type of ["keydown", "keypress", "keyup"]) {
          el.dispatchEvent(new KeyboardEvent(type, {
            bubbles: true, cancelable: true,
            key: "Enter", code: "Enter", keyCode: 13, which: 13,
          }));
        }
        el.blur();
        return { ok: true, before, after: el.value };
      },
    });
    for (const r of (results || [])) if (r?.result?.ok) return r.result;
    return { ok: false, reason: (results || []).map((r) => r?.result?.reason).find(Boolean) || "not found in any frame" };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e) };
  }
}

// A non-blob ring entry means a vizql/dataserver response landed, i.e. the
// viz re-queried for the newly selected store.
async function waitForRequery(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world:  "MAIN",
        func:   () => (window.__APAISUITE_VIZPICK_TABLEAU_CAP?.all?.() || []).some((e) => e.via !== "blob"),
      });
      if ((results || []).some((r) => r?.result === true)) return true;
    } catch {}
    await sleep(POLL_MS);
  }
  return false;
}

// ── Tab lifecycle (mirrors vizpick_stores_tableau.js) ─────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A tab opened with `:toolbar=n` renders the viz but has no toolbar, and this
// capture drives Tableau THROUGH the toolbar's Download button. Adopting one is
// an instant 120-second timeout reported as SLOW_RENDER — the viz really had
// rendered, so every retry failed the same way.
//
// MetricShot opens exactly such a tab on this very view
// (modules/metricshot/data/defaults.js: `?:embed=y&:toolbar=n`), so whenever a
// metric had run, Today could not capture at all. Rejecting the tab here fixes
// it from this side regardless of what any other module opens.
const TOOLBAR_SUPPRESSED = /[?&](?::|%3A)toolbar=n\b/i;

// How long a rendered viz may go without a toolbar before we call it
// suppressed. Tableau paints the toolbar and the parameter controls at
// slightly different times, so this must be long enough to absorb that gap and
// short enough to beat the 120s render budget it exists to avoid.
const TOOLBAR_GRACE_MS = 20_000;

/**
 * Is this tab one we cannot drive?
 *
 * Read the tab's CURRENT url rather than the one chrome.tabs.query handed us.
 * That query is a snapshot, and a tab that is still loading reports its
 * pre-redirect url — so a MetricShot tab could pass the filter below and only
 * resolve to `:toolbar=n` afterwards. Observed live 2026-08-24: the filter was
 * correct, matched nothing, and the crawl adopted the tab anyway.
 */
async function isToolbarSuppressed(tabId) {
  const t = await chrome.tabs.get(tabId).catch(() => null);
  return TOOLBAR_SUPPRESSED.test(t?.url || "");
}

async function findOrOpenReportTab() {
  const all = await chrome.tabs.query({ url: TAB_PATTERN });
  const existing = all.filter((t) =>
    VIEW_FRAGMENT.test(t.url || "") && !TOOLBAR_SUPPRESSED.test(t.url || ""));
  if (existing.length) {
    // Chrome reclaims background tabs two different ways, and only one of them
    // is obvious:
    //
    //   discarded — the document is gone; the tab is a placeholder.
    //   frozen    — the document is intact but its event loop is SUSPENDED.
    //
    // Frozen is the nastier one. The tab still reports status "complete", still
    // matches this query and looks entirely healthy — but nothing runs in it,
    // so the viz never finishes rendering and injected polls never execute.
    // Waiting on it just burns the whole readiness budget.
    //
    // Observed in the field 2026-08-16: a tab left open by a failed run was
    // frozen by Memory Saver, and every capture afterwards reused it and failed
    // identically, forever. The user's diagnostics showed the Details tab
    // frozen:true while the Yesterday tab — used minutes earlier — was not,
    // which is exactly why Yesterday kept working and Today never did.
    const live = existing.find((t) => !t.discarded && !t.frozen) || existing[0];
    // Re-check at the moment of use, not at query time. See
    // isToolbarSuppressed: the url in a query result can still be the
    // pre-redirect one, which is how a `:toolbar=n` tab slipped past the
    // filter above and cost every store a 120s timeout.
    if (!(await isToolbarSuppressed(live.id))) {
      return { tab: live, didOpen: false, dormant: !!(live.discarded || live.frozen) };
    }
    // Fall through and open our own rather than driving a tab with no toolbar.
  }
  // active:false — the capture runs entirely in the background and must
  // never pull the user off the page they are on.
  const tab = await chrome.tabs.create({ url: DETAILS_URL, active: false });
  if (tab) await keepAwake(tab.id);
  return tab ? { tab, didOpen: true } : null;
}

/**
 * Ask Chrome not to reclaim a tab we are about to drive for minutes. The crawl
 * runs unfocused for the whole of a market, which is exactly what Memory Saver
 * targets — and losing a lane mid-crawl kills every store queued behind it.
 */
async function keepAwake(tabId) {
  try { await chrome.tabs.update(tabId, { autoDiscardable: false }); } catch {}

  // autoDiscardable only stops Chrome DISCARDING the tab. It does not stop
  // Chrome FREEZING it, which suspends JS execution outright — and a frozen
  // tab is why captures failed with "the page shell loaded but the viz never
  // finished": the document was complete, then execution stopped, so Tableau's
  // render never ran to completion. A status snapshot caught it red-handed:
  // { view: "VizPickDetails", discarded: false, frozen: true }.
  //
  // Two parts, because they solve different halves:
  //
  //   1. A tab that is ALREADY frozen when we adopt it stays frozen; nothing
  //      we set afterwards revives it. Reloading does, so reload it. Losing
  //      the current render costs nothing — a frozen tab renders nothing.
  //   2. Hold a Web Lock in the page. An unreleased lock marks the page as
  //      doing work, which is one of the conditions Chrome's freezing
  //      intervention exempts. Best-effort: the exemption list is a browser
  //      heuristic, not a contract, so this reduces re-freezing rather than
  //      guaranteeing against it.
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.frozen) {
      await chrome.tabs.reload(tabId);
      await _awaitTabComplete(tabId, 30_000);
    }
  } catch {}

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world:  "MAIN",
      func: () => {
        if (window.__apaiKeepAwake) return;
        window.__apaiKeepAwake = true;
        try {
          // Never resolves, so the lock is held for the life of the document.
          navigator.locks?.request?.("apaisuite-keep-awake", { mode: "exclusive" },
            () => new Promise(() => {}));
        } catch { /* Web Locks unavailable — fall through, nothing lost */ }
      },
    });
  } catch {}
}

// Resolve once the tab reports status "complete", or after `timeoutMs`.
// Polling rather than onUpdated: this runs inside a capture that may already
// hold listeners for the same tab, and a stray listener outliving its capture
// is how lanes started interfering with each other.
async function _awaitTabComplete(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return false;
    if (t.status === "complete" && !t.frozen) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * Why did the viz never appear? Distinguishing these matters because the
 * remedies are opposites: an SSO wall needs the user, a slow render needs
 * patience, a stale tab needs reloading. A single "session may need SSO
 * re-auth" for all of them sends people to re-authenticate a healthy session.
 *
 * Mirrors diagnoseUnrenderedTab() in vizpick_stores_tableau.js, against this
 * view's fragment.
 */
async function diagnoseUnrenderedTab(tabId, stageReason) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const url = tab?.url || "(unknown)";

  let page = null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world:  "MAIN",
      func:   () => {
        const txt = (document.body?.innerText || "").slice(0, 4000);
        return {
          url: location.href,
          title: document.title,
          installed: !!window.__APAISUITE_VIZPICK_TABLEAU_CAP,
          hasToolbar: !!document.querySelector('[data-tb-test-id="viz-viewer-toolbar-button-download"]'),
          // The Store parameter is this view's other hard requirement.
          hasStoreParam: !!(
            document.querySelector('textarea[aria-label="Store"], input[aria-label="Store"]') ||
            [...document.querySelectorAll("textarea,input")].find(
              (n) => (n.getAttribute("aria-label") || "").trim().toLowerCase() === "store"
            )
          ),
          loading: !!document.querySelector('[class*="tb-loading" i], [class*="LoadingSpinner" i], [class*="loading-indicator" i]'),
          hasPasswordField: !!document.querySelector('input[type="password"]'),
          signInish: /sign in|log in|password|authenticat|session (has )?expired|access denied|not authorized/i.test(txt),
          tableauError: /an unexpected error occurred|unable to (load|connect)|permission/i.test(txt),
          testIdCount: document.querySelectorAll("[data-tb-test-id]").length,
          textSample: txt.replace(/\s+/g, " ").slice(0, 400),
        };
      },
    });
    // The viz — and the toolbar — live in an embedded iframe, not the top
    // document (established 2026-08-16, dev/probe-vizpick-stuck.mjs). Prefer
    // whichever frame looks most like the real viz frame.
    const frames = (results || []).map((r) => r?.result).filter(Boolean);
    page = frames.find((f) => f.hasToolbar || f.hasStoreParam)
        || frames.find((f) => f.testIdCount > 0)
        || frames[0] || null;
  } catch (e) {
    page = { evalError: String(e?.message ?? e) };
  }

  let errorClass = "SESSION";
  let message;
  if (tab?.discarded || tab?.frozen) {
    errorClass = tab.frozen ? "FROZEN" : "DISCARDED";
    message = tab.frozen
      ? "Chrome had frozen the Tableau tab to save memory — its scripts were suspended, so the viz could not render. Try Refresh again; if this keeps happening, exclude stores.tableau.wal-mart.com from Memory Saver in edge://settings/system."
      : "Chrome had discarded the Tableau tab to save memory and it did not come back in time. Try Refresh again.";
  } else if (page?.hasPasswordField || page?.signInish) {
    errorClass = "AUTH";
    message = "Tableau is showing a sign-in / SSO page, so no data could be read. Sign in on the opened tab, then Refresh again.";
  } else if (!VIEW_FRAGMENT.test(url) && !VIEW_FRAGMENT.test(page?.url || "")) {
    errorClass = "WRONG_VIEW";
    message = `The Tableau tab is on "${url}", not the VizPick Details view.`;
  } else if (page?.hasToolbar && !page?.hasStoreParam) {
    errorClass = "NO_PARAM";
    message = "The viz rendered but its Store parameter box never appeared, so no store could be selected. Check that the VizPick Details view still exposes a \"Store\" parameter.";
  } else if (TOOLBAR_SUPPRESSED.test(url) || TOOLBAR_SUPPRESSED.test(page?.url || "")
             || (page?.hasStoreParam && !page?.hasToolbar)) {
    // The viz DID render — the Store box is right there. What is missing is the
    // toolbar, and the export is driven through its Download button.
    //
    // Reported as SLOW_RENDER until 2026-08-24, whose message ends "retrying
    // often works". Retrying can never work: the tab is `:toolbar=n` and will
    // never grow a toolbar. That wording sent three separate investigations
    // looking at Tableau's speed instead of at which tab was adopted.
    errorClass = "NO_TOOLBAR";
    message = "The Tableau tab has its toolbar suppressed (:toolbar=n), so there is no Download button to export through. The viz itself rendered fine. This is usually MetricShot's tab being adopted — close any embedded VizPick Details tabs and Refresh again.";
  } else if (page?.loading || page?.testIdCount > 0) {
    errorClass = "SLOW_RENDER";
    message = `Tableau was still rendering after ${Math.round(VIZ_READY_WAIT_MS / 1000)}s (the page shell loaded but the viz never finished). Usually a cold session or a slow upstream — retrying often works.`;
  } else if (page?.installed === false) {
    errorClass = "NO_CONTENT_SCRIPT";
    message = "The capture content script was not present on the Tableau tab. Reload the extension at edge://extensions, close any open Tableau tabs, then Refresh again.";
  } else if (page?.tableauError) {
    errorClass = "TABLEAU_ERROR";
    message = "Tableau reported an error on the page instead of rendering the viz.";
  } else {
    message = `VizPick Details was not usable within ${Math.round(VIZ_READY_WAIT_MS / 1000)}s — ${stageReason}.`;
  }

  return { errorClass, message, tabUrl: url, stageReason, discarded: !!tab?.discarded, page };
}



async function waitForTabLoad(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return null;
    if (t.status === "complete") return t;
    await sleep(250);
  }
  return chrome.tabs.get(tabId).catch(() => null);
}

async function waitForCaptureInstalled(tabId, graceMs) {
  const deadline = Date.now() + graceMs;
  do {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world:  "MAIN",
        func:   () => !!window.__APAISUITE_VIZPICK_TABLEAU_CAP,
      });
      if ((results || []).some((r) => r?.result === true)) return true;
    } catch {}
    await sleep(250);
  } while (Date.now() < deadline);
  return false;
}

/**
 * Wait for the viz, distinguishing "not ready yet" from "will never be ready".
 *
 * @returns {Promise<"ok"|"suppressed"|false>}
 *
 * The url is NOT a reliable test for a toolbar-suppressed tab, which is what
 * the first version of this fix got wrong. chrome.tabs.get can still report a
 * tab's pre-redirect url well after its document has settled, so a MetricShot
 * `:toolbar=n` tab passes a url check and is adopted anyway — then costs the
 * full 120s budget, per lane, on every crawl.
 *
 * The DOM is authoritative: if the Store parameter box is present the viz HAS
 * rendered, so a toolbar that is still absent after the grace below is absent
 * by design, not by slowness. Bail then rather than waiting out the budget.
 */
async function waitForVizReadyOrSuppressed(tabId, timeoutMs, graceMs = TOOLBAR_GRACE_MS) {
  const deadline = Date.now() + timeoutMs;
  const graceEnds = Date.now() + graceMs;
  while (Date.now() < deadline) {
    let frames = [];
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world:  "MAIN",
        func:   () => ({
          toolbar: !!document.querySelector('[data-tb-test-id="viz-viewer-toolbar-button-download"]'),
          store:   !!(document.querySelector('textarea[aria-label="Store"], input[aria-label="Store"]')
            || [...document.querySelectorAll("textarea,input")].some(
              (n) => (n.getAttribute("aria-label") || "").trim().toLowerCase() === "store")),
        }),
      });
      frames = (results || []).map((r) => r?.result).filter(Boolean);
    } catch { /* frame torn down mid-poll; try again */ }

    if (frames.some((f) => f.toolbar)) return "ok";
    // Rendered (Store box is there) but no toolbar anywhere, past the grace.
    if (Date.now() > graceEnds && frames.some((f) => f.store)) return "suppressed";
    await sleep(POLL_MS);
  }
  return false;
}

async function waitForVizReady(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world:  "MAIN",
        func:   () => !!document.querySelector('[data-tb-test-id="viz-viewer-toolbar-button-download"]'),
      });
      if ((results || []).some((r) => r?.result === true)) return true;
    } catch {}
    await sleep(POLL_MS);
  }
  return false;
}

async function setSuppressDownloads(tabId, on) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world:  "MAIN",
      args:   [!!on],
      func:   (v) => { window.__APAISUITE_VIZPICK_TABLEAU_CAP?.setSuppressDownloads?.(v); },
    });
  } catch {}
}

async function clearRing(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world:  "MAIN",
      func:   () => { window.__APAISUITE_VIZPICK_TABLEAU_CAP?.clear?.(); },
    });
  } catch {}
}

async function pollForCsv(tabId, timeoutMs, needle) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world:  "MAIN",
        args:   [needle],
        func:   (n) => window.__APAISUITE_VIZPICK_TABLEAU_CAP?.findBlobBySubstr?.(n) || null,
      });
      for (const r of (results || [])) if (r?.result) return r.result;
    } catch {}
    await sleep(POLL_MS);
  }
  return null;
}

// ── Export: replay if we can, drive the dialog if we must ────────────────
//
// See tableau_export_replay.js. The GUID a replay needs is learned from the
// first DOM export of each sheet, so a market pays one dialog per sheet
// instead of one per store per sheet.
//
// Scoped to a single crawl deliberately. The session id is only valid while
// the tab lives, and a stale one costs a 410 and a fallback — cheap, but
// pointless to carry between runs.
function makeReplayState() {
  return {
    // sheetdocId GUIDs are WORKBOOK-scoped, so learning them once serves every
    // lane — that is the whole value of sharing this object.
    sheetIds: {},
    // The vizql context is NOT shareable. It embeds a session id belonging to
    // ONE tab, and replaying against it exports THAT tab's current viz state.
    //
    // This was a single `ctx` field, set by whichever lane happened to finish
    // its first DOM export, and then used by all three. Lanes 2 and 3 replayed
    // into lane 1's session and got lane 1's store's rows back, labelled as
    // their own — associate names and bins filed under the wrong store, with
    // nothing about the output to show it was wrong. It stayed dormant only
    // because the replay had never once engaged; the moment learning started
    // working, every multi-lane crawl began mixing stores.
    //
    // Keyed by tabId, and a lane never shares a tab.
    ctxByTab: new Map(),
    learned: 0, replayed: 0, fellBack: 0, ms: 0,
  };
}

/** Rebuild tab-separated text so the existing parsers stay the single place
 *  that knows about columns — including the alias handling and the schema
 *  watch. The replay returns xlsx where the Blob route returned CSV. */
function rowsToTsv(headers, rows) {
  const line = (cells) => cells.map((c) => (c == null ? "" : String(c))).join("\t");
  return [line(headers), ...rows.map((r) => line(headers.map((h) => cellText(h, r[h]))))].join("\r\n");
}

/**
 * The one genuine difference between the two routes, found by diffing a live
 * replay against the dialog output on 2026-08-22.
 *
 * The CSV export renders a percentage as FORMATTED TEXT — "67%" — which the
 * parser's num() turns into 67. The xlsx stores the underlying value, 0.6667,
 * with a percent *display format* that readXlsxFile does not apply. Passing
 * that straight through produced pickPct 0.6667 where the CSV gave 67: it
 * parses cleanly, every check passes, and every card renders 0%. Precisely the
 * "confidently wrong" failure no schema check can catch.
 *
 * The scaling is deterministic, not a heuristic: for a column whose header ends
 * in "%", the stored xlsx value IS the fraction, so x100 is always correct.
 * Strings pass through untouched, in case a future export formats them itself.
 *
 * Side benefit: the xlsx values are unrounded, so this route is slightly more
 * precise than the CSV one (66.67 against Tableau's pre-rounded 67).
 */
function cellText(header, value) {
  if (!String(header).trim().endsWith("%")) return value;
  const raw = String(value ?? "").trim();
  // Already formatted (a future export, or the CSV route) — leave it alone.
  // Scaling twice would turn 67% into 6700%, which is the same class of bug in
  // the opposite direction and just as invisible.
  if (!raw || raw.includes("%")) return value;
  // readXlsxFile hands every cell back as a STRING, so a typeof check for
  // "number" here silently did nothing — which is how this was missed the
  // first time. Parse it.
  const n2 = Number(raw);
  return Number.isFinite(n2) ? `${n2 * 100}%` : value;
}

/**
 * Read the ring back and summarise why an export produced nothing.
 *
 * Best-effort by construction: this runs only on a path that has ALREADY
 * failed, so anything it throws would replace a real failure reason with a
 * diagnostic's own stack trace.
 */
async function describeExportAttempt(tabId, needle) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: () => window.__APAISUITE_VIZPICK_TABLEAU_CAP?.all?.() || [],
    });
    // Frames without the viz report an empty ring; the viz frame is whichever
    // one saw anything at all.
    const ring = (results || [])
      .map((r) => r?.result || [])
      .reduce((best, cur) => (cur.length > best.length ? cur : best), []);
    return summariseExportAttempt(ring, needle);
  } catch (e) {
    return `ring unreadable: ${e?.message ?? e}`;
  }
}

/** Learn any sheetdocIds the page has revealed since the last look. */
async function learnFromRing(tabId, replay) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: () => window.__APAISUITE_VIZPICK_TABLEAU_CAP?.all?.() || [],
    });
    for (const r of results || []) {
      const found = learnSheetIds(r?.result || []);
      for (const [name, guid] of Object.entries(found)) {
        if (!replay.sheetIds[name]) { replay.sheetIds[name] = guid; replay.learned++; }
      }
    }
  } catch { /* learning is best-effort; the DOM path still works */ }
}

/**
 * Get a sheet's contents as text, by whichever route is available.
 *
 * Replay first when we have both a session context and this sheet's GUID;
 * otherwise the DOM dialog, followed by an attempt to learn the GUID from the
 * request the page just made. A replay failure ALWAYS falls back — the worst
 * case is wasted work, never a capture that would otherwise have succeeded.
 */
async function exportSheetText(tabId, sheet, needle, replay) {
  const key = normaliseSheetName(sheet.match);

  const ctx = replay?.ctxByTab?.get(tabId) || null;
  // Refuse a context belonging to another tab. Replaying against another
  // lane's session returns THAT lane's store's rows under this store's name.
  if (ctx && ctx.tabId != null && ctx.tabId !== tabId) {
    throw new Error(
      `replay context tab mismatch: ctx is for tab ${ctx.tabId}, exporting on ${tabId}`);
  }
  if (ctx && replay.sheetIds[key]) {
    const r = await replayExport(tabId, { base: ctx.base, sheetdocId: replay.sheetIds[key] });
    if (r.ok) {
      try {
        const text = r.isZip
          ? await readXlsxFile(base64ToBytes(r.base64)).then((s2) => rowsToTsv(s2.headers, s2.rows))
          : base64ToText(r.base64);
        if (text && text.includes(needle)) {
          replay.replayed++;
          replay.ms += r.ms || 0;
          return { ok: true, text, via: "replay" };
        }
      } catch { /* fall through to the dialog */ }
    }
    // A dead session invalidates THIS TAB's context, not every lane's.
    if (r.sessionDead) replay.ctxByTab.delete(tabId);
    replay.fellBack++;
  }

  // While a crosstab dialog is up Tableau removes the viz toolbar from the
  // DOM, so firing the next DOM export immediately finds no Download button
  // and silently does nothing. This wait used to live at the donut call site
  // only; adding the groups and locations exports meant two more dialog-driven
  // exports with no wait at all, which is a soft failure on every one of them
  // for the store that has to learn the GUIDs. It belongs here, where we know
  // a dialog is about to be driven.
  if (!(await waitForVizReady(tabId, DIALOG_SETTLE_MS))) {
    return { ok: false, reason: "viz toolbar did not return before the export" };
  }
  await clearRing(tabId);
  const triggered = await triggerCrosstabExport(tabId, sheet);
  if (!triggered.ok) return { ok: false, reason: `export UI: ${triggered.reason}` };
  const blob = await pollForCsv(tabId, EXPORT_WAIT_MS, needle);

  // Learn BEFORE deciding whether this export succeeded. The GUID comes from
  // the export command the page has just posted, and that request fires
  // whether or not a file ever comes back — so bailing first threw away the
  // one thing a failed store could still contribute. Worse, it made failures
  // self-perpetuating: a store that times out teaches the crawl nothing, so
  // the next store pays the same slow dialog and can time out the same way.
  if (replay) {
    if (!replay.ctxByTab.has(tabId)) {
      const fresh = await readVizqlContext(tabId);
      // Stamp the owning tab INTO the context so misuse is detectable rather
      // than silent. The bug this replaces produced perfectly well-formed rows
      // belonging to the wrong store — nothing about the output said so.
      if (fresh) replay.ctxByTab.set(tabId, { ...fresh, tabId });
    }
    await learnFromRing(tabId, replay);
  }

  if (!blob) {
    // "no CSV captured" on its own is a dead end — it cannot distinguish the
    // export command never firing, firing and erroring, or succeeding into a
    // file whose contents did not match `needle`. The ring knows all three;
    // ask it, so the next occurrence is diagnosable instead of a shrug.
    const ev = await describeExportAttempt(tabId, needle);
    return { ok: false, reason: `no CSV captured (${ev})` };
  }
  return { ok: true, text: blob.respBody, via: "dom" };
}

async function triggerCrosstabExport(tabId, sheet) {
  // executeScript awaits a promise returned by the injected function, which is
  // what lets the driver report whether it actually clicked Export rather than
  // just whether it found a toolbar.
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world:  "MAIN",
    args:   [sheet.match, sheet.fallbackIndex],
    func:   exportDriverFn,
  });
  for (const r of (results || [])) {
    const res = r?.result;
    if (!res?.ran) continue;
    if (res.ok) return res;
    // Name the stage it stalled on. Previously this path did not exist — the
    // driver always claimed success, so a stall surfaced 45 s later as the
    // uninformative "no CSV captured".
    return {
      ...res,
      ok: false,
      reason: `stalled at "${res.stalledAt}" (${res.reason || res.error || "no detail"})`,
    };
  }
  return { ok: false, reason: "viz frame with toolbar not found" };
}

// Same staged driver as the yesterday source; kept local so this file stays
// self-contained when injected.
async function exportDriverFn(sheetMatch, fallbackIndex) {
  const steps = {};
  const rc = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, view: window };
    for (const t of ["pointerover","mouseover","mousemove","pointerdown","mousedown","focus","pointerup","mouseup","click"]) {
      const E = t.startsWith("pointer") ? PointerEvent : (t === "focus" ? FocusEvent : MouseEvent);
      try { el.dispatchEvent(new E(t, o)); } catch { el.dispatchEvent(new MouseEvent(t, o)); }
    }
    return true;
  };
  const tid = (t) => document.querySelector(`[data-tb-test-id="${t}"]`);

  if (!tid("viz-viewer-toolbar-button-download")) return { ran: false, ok: false, reason: "no toolbar in this frame" };

  const findSheet = () => {
    const thumbs = [...document.querySelectorAll('[data-tb-test-id^="sheet-thumbnail-"]')];
    if (!thumbs.length) return null;
    steps.sheetNames = thumbs.map((el, i) => `${i}: ${(el.textContent || "").trim().slice(0, 60)}`);
    const needle = String(sheetMatch || "").toLowerCase();
    const byName = needle ? thumbs.find((el) => (el.textContent || "").toLowerCase().includes(needle)) : null;
    if (byName) { steps.sheetPickedBy = "name"; return byName; }
    steps.sheetPickedBy = "fallbackIndex";
    return tid(`sheet-thumbnail-${fallbackIndex}`);
  };

  const stages = [
    { name: "download", find: () => tid("viz-viewer-toolbar-button-download") },
    { name: "crosstab", find: () => tid("download-flyout-download-crosstab-MenuItem") },
    { name: "sheet",    find: findSheet, pick: (el) => el.querySelector("img,[role=button],button,div") || el },
    { name: "csv",      find: () => tid("crosstab-options-dialog-radio-csv-RadioButton"), pick: (el) => el.querySelector("input") || el },
    { name: "export",   find: () => tid("export-crosstab-export-Button"), ready: (el) => !el.disabled },
  ];

  // AWAIT the stage machine rather than returning the moment it is kicked off.
  //
  // This used to `advance(); return { ran: true, ok: true, steps }` — a chain of
  // setTimeouts started, then an immediate unconditional success. So
  // `triggered.ok` meant "we found a toolbar", never "we clicked Export", and
  // `steps.reached` was serialised back empty because nothing had run yet. When
  // the machine stalled the caller learned nothing: it just waited out the full
  // 45 s poll and reported "no CSV captured". Four stores in ten failed that way
  // and there was no way to see where.
  //
  // The budget is now PER STAGE. It was one shared counter, so a slow first
  // dialog ate the allowance for every stage after it and the machine gave up
  // mid-sequence — which is exactly the shape of a failure that gets worse with
  // more lanes competing for the same Tableau backend.
  const PER_STAGE_TICKS = 60;   // 60 * 200ms = 12s per stage
  steps.reached = {};

  const clickThrough = () => new Promise((resolve) => {
    let i = 0;
    let ticks = 0;
    const step = () => {
      if (i >= stages.length) return resolve({ ok: true, stalledAt: null });
      const st = stages[i];
      let el = null;
      try { el = st.find(); } catch (e) { steps[`${st.name}Error`] = String(e?.message ?? e); }
      if (el && (!st.ready || st.ready(el))) {
        try { rc(st.pick ? st.pick(el) : el); }
        catch (e) { return resolve({ ok: false, stalledAt: st.name, error: String(e?.message ?? e) }); }
        steps.reached[st.name] = true;
        i++;
        ticks = 0;                       // fresh budget for the next stage
        return setTimeout(step, 200);
      }
      if (++ticks > PER_STAGE_TICKS) {
        // Name the stage. "stalled waiting for the sheet thumbnail" and
        // "stalled waiting for the Export button to enable" have completely
        // different fixes, and both used to surface as "no CSV captured".
        return resolve({
          ok: false,
          stalledAt: st.name,
          found: !!el,
          reason: el ? "found but never became ready" : "never appeared",
        });
      }
      setTimeout(step, 200);
    };
    step();
  });

  const outcome = await clickThrough();
  return { ran: true, ok: outcome.ok, steps, ...outcome };
}
