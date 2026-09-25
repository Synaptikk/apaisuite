// modules/vizpick/view.js
//
// Full-page dashboard mount. Loads view.html, wires the Refresh button, the
// Market picker and the Yesterday/Today tabs, subscribes to source_complete
// broadcasts, and re-renders on each update. The Market select is the whole
// point of this module: pick a market once and see every store in it side by
// side, instead of typing store numbers one at a time into Tableau's VizPick
// Details search box.

import { gaugeSvg, bandFor } from "./lib/charts.js";
import { isTodayRowComplete, withholdDuplicateLocations } from "./lib/today_coverage.js";
import { rowSourceUpdate, stampSpread } from "./lib/store_stamp.js";
import { getUserHomeMarket, getUserHomeStore, onUserMarketChange } from "../../shared/userStore.js";
import { rollUpSkippedByAssociate } from "./lib/parse_vizpick_stores_csv.js";
import { buildPerformanceHtml, buildPickListHtml, buildCardEmail } from "./lib/card_report.js";
import { timeline as historyTimeline, toCsv as historyCsv, indexSchedule, matchPerson, unseenBins, firstSeenEvents, diffDepts, updateGaps,
  scanLedger, scanImpact, ledgerCsv, cleanDay } from "./lib/home_history.js";
import { isDigitalJob } from "../digitalmetrics/lib/data/job_classify.js";
import * as associateDirectory from "../../shared/associateDirectory.js";
import { hasName, normalizeWin } from "../../shared/associateDirectory.js";
import { lookupNames, lookupDiagnostics, diffLookupDiagnostics, lookupTitles, needsWorkdayLookup } from "../../shared/associateLookup.js";
import { canonical as canonicalName } from "../digitalmetrics/lib/names.js";
import { createLogging } from "../../shared/logging.js";

const log = createLogging("vizpick");

// Goals published on the Tableau VizPick dashboard. These are both the gauge
// captions AND the colour thresholds — see lib/charts.js::bandFor. Metrics
// absent from this map (Pallets %) have no published target and are therefore
// never judged.
const GOALS = {
  casesSeenPct: 95,
  locationPct:  95,
  pickPct:      90,
  overstockPct: 90,

  // VizPick Health is NOT an average of the four rings — store 1 scores 98.14
  // with a best component of 98, so no mean of them can produce it. Fitted
  // against the full roster (4,598 stores, 2026-08-16) it is the mean
  // ATTAINMENT of each component against its own goal, capped at 100%:
  //
  //   mean( min(100, cases/95), min(100, location/95),
  //         min(100, pick/90),  min(100, overstock/90) ) × 100
  //
  // median error 0.28pp, p95 1.74pp. The residual is the components being
  // published rounded to whole percents while the composite is computed from
  // unrounded values. (A least-squares fit of the four raw percentages was far
  // worse and extrapolated above 100 — which is what gave the capping away.)
  //
  // So the composite's goal is not invented: it is 100 by construction. A
  // store at or above every component goal scores exactly 100, and 809 of the
  // 4,598 stores do.
  vizpick: 100,
};

// Tab ids are "today" or "day:<YYYY-MM-DD>". Today is always leftmost and
// first; the closed days follow, newest to oldest, out of the rolling history.
const TODAY_NOTE =
  "Source: the VizPick Details view, refreshed through the current business day. Tableau warns it can run 1–2 hours behind upstream systems.";
const DAY_NOTE =
  "Source: the VizPick summary view, which Tableau refreshes once daily for the day prior.";

/** Local YYYY-MM-DD, so day keys never shift across a UTC boundary. */
function localDayKey(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Name a stored day relative to now: the most recent closed day reads
 * "Yesterday", the one before it "2 days ago" is unhelpful — a weekday name is
 * what people actually navigate by — so anything older is shown as its day
 * name, with the date underneath in every case.
 */
function dayTabLabel(dataDate) {
  if (!dataDate) return { name: "Unknown day", date: "—" };
  const [y, m, d] = dataDate.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const today = new Date();
  const diff = Math.round((new Date(localDayKey(today)) - new Date(dataDate)) / 86_400_000);
  const date = dt.toLocaleDateString(undefined, { month: "numeric", day: "numeric" });
  if (diff === 1) return { name: "Yesterday", date: `${dt.toLocaleDateString(undefined, { weekday: "short" })} ${date}` };
  return { name: dt.toLocaleDateString(undefined, { weekday: "long" }), date };
}

// What the user can actually do about each capture failure class, stated up
// front — the raw envelope stays available underneath for diagnosis.
//
// MUST stay at module scope. This lived inside mount() next to renderDebug(),
// which put it in the temporal dead zone: mount() calls paint() near the top,
// paint() reaches renderDebug() whenever a stored capture error exists, and
// the `const` further down had not initialised yet — so the module failed to
// load with "Cannot access 'FIXES' before initialization", but ONLY for users
// who already had a failed capture stored.
const FIXES = {
  // SESSION is the fallback when the page couldn't be classified, and is what
  // the Today source reports for a render timeout. It must have a hint too.
  SESSION:           "Open the Tableau tab that was left open and check what it is showing. If the viz renders there, click Refresh again — the capture will reuse that tab and finish in seconds.",
  TAB:               "The Tableau tab could not be opened. Check that pop-ups/new tabs aren't blocked for stores.tableau.wal-mart.com, then Refresh.",
  AUTH:              "Open the Tableau tab that was left open, complete the sign-in, then click Refresh again.",
  SLOW_RENDER:       "Usually transient. Click Refresh again; if it keeps happening, open the Tableau tab first and let the viz finish loading, then Refresh.",
  NO_CONTENT_SCRIPT: "Reload the extension at edge://extensions, close every open Tableau tab, then click Refresh.",
  WRONG_VIEW:        "Close the stray Tableau tab so a fresh one can be opened on the right view, then Refresh.",
  TABLEAU_ERROR:     "Tableau itself errored. Open the tab that was left open to see its message.",
  EXPORT_UI:         "Tableau's Download → Crosstab dialog changed or did not open. Check the sheet list in the debug details below.",
  NO_TOOLBAR:        "A Tableau tab with its toolbar suppressed (:toolbar=n) was adopted — there is no Download button to export through. Close any embedded VizPick Details tabs, then Refresh.",
  NO_CAPTURE:        "The export was triggered but no CSV came back. Check the captured URLs in the debug details below.",
  PARSE:             "The CSV was captured but its columns were not what we expect — Tableau may have changed the sheet.",
};

// Card order / sort preferences. Versioned so a future shape change can be
// discarded rather than half-read, same rule as the snapshot store.
// v2: the default sort changed to worst-first. A v1 pref written before that
// would pin the old default and mask it, so v1 is discarded rather than
// migrated — the only thing lost is a drag arrangement, which is one drag to
// recreate.
const UI_PREFS_KEY = "vizpick.ui.v2";

// Worst-first by default: the point of the rollup is to see which stores need
// attention, so the lowest composite scores lead on both tabs.
const DEFAULT_SORT = "score-asc";

// How long to let Today rows accumulate before rebuilding the card grid.
// Comfortably longer than the ~6s a 3-lane crawl takes per store, so an entire
// crawl produces one repaint rather than one per store. The progress bar and
// the run note update independently and are not debounced — those are cheap
// text writes that do not touch the grid, so the crawl still looks live.
const ROWS_REPAINT_DEBOUNCE_MS = 10_000;

// How many associates a store card lists, worst-first.
//
// Both a display and a cost decision, and they have to be the same number. A
// store has ~50 distinct scanners; a market of ten is 300-500 people. Titles
// come from Workday, which needs its own tab and a DOM scrape, SERIAL because
// they would otherwise fight over that tab — so resolving everyone meant a
// single paint kicking off twenty-plus minutes of background scraping.
//
// Ten is also the useful number: this list exists to answer "who do I talk to",
// and nobody works a tail of forty.
const TOP_ASSOCIATES = 10;

const SORTS = {
  "store-asc":  { label: "Store number — low to high",  cmp: (a, b) => storeNum(a) - storeNum(b) },
  "store-desc": { label: "Store number — high to low",  cmp: (a, b) => storeNum(b) - storeNum(a) },
  "score-desc": { label: "Total score — high to low",   cmp: byScore(-1) },
  "score-asc":  { label: "Total score — low to high",   cmp: byScore(1) },
};

function storeNum(r) {
  const n = Number(r.store);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

// "Total score" is the VizPick composite. A store missing one (a Today card
// whose donut-health export failed) sorts LAST in both directions — treating
// it as 0 would fake a terrible score and push it to the top of the
// worst-first view, which is exactly where a data gap must not appear.
function byScore(dir) {
  return (a, b) => {
    const ha = Number.isFinite(a.vizpick);
    const hb = Number.isFinite(b.vizpick);
    if (!ha && !hb) return storeNum(a) - storeNum(b);
    if (!ha) return 1;
    if (!hb) return -1;
    return dir * (a.vizpick - b.vizpick) || storeNum(a) - storeNum(b);
  };
}

export async function mount(host, container) {
  // 1. Inject module CSS (removed on unmount) and WAIT for it to apply.
  //
  // Without the await, the first render lands before the stylesheet has
  // loaded, so the card grid and gauge grid lay out with default block rules —
  // full-width cards that ignore the window size. Resizing the window forced a
  // recalc once the CSS had since arrived, which made it look like a
  // responsive bug rather than a load-order one.
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = host.url("styles.css");
  link.dataset.module = host.id;
  const cssReady = new Promise((resolve) => {
    // `sheet` is already set if the browser had it cached.
    if (link.sheet) return resolve();
    link.addEventListener("load", resolve, { once: true });
    // Never block the module on a missing stylesheet — render unstyled rather
    // than not at all.
    link.addEventListener("error", resolve, { once: true });
    setTimeout(resolve, 3000);
  });
  document.head.appendChild(link);
  await cssReady;

  // 2. Load view.html into the container.
  const resp = await fetch(host.url("view.html"));
  container.innerHTML = await resp.text();

  // 3. Grab handles.
  const btnRefresh   = container.querySelector('[data-action="refresh"]');
  const btnLoadToday = container.querySelector('[data-action="load-today"]');
  const btnCancel    = container.querySelector('[data-action="cancel-today"]');
  const btnForce     = container.querySelector('[data-action="force-refresh"]');
  const btnForceToday = container.querySelector('[data-action="force-today"]');
  const btnResetOrder = container.querySelector('[data-action="reset-order"]');
  const sortSelect    = container.querySelector("[data-sort-select]");
  const marketSelect = container.querySelector("[data-market-select]");

  let state = null;
  let selectedMarket = null;
  let marketIsUserSet = false;
  // "today" or "day:<YYYY-MM-DD>". Resolved on first paint once the stored
  // history is known — Today leads, but only when it actually has data.
  let activeTab = null;
  // Card ordering. `sortMode` is one of the SORTS keys; `customOrder` maps a
  // market to the store order the user dragged into place. Both persist so an
  // arrangement survives closing the module.
  let sortMode = DEFAULT_SORT;
  let customOrder = {};
  let dragStore = null;
  let lastRunNote = null;
  // Cards show only their graphs by default; the text rows are opt-in per
  // card. Keyed by market so expanding a store in one market doesn't expand a
  // same-numbered store elsewhere.
  let expanded = {};
  // Which detail pane each card is showing ("dept" | "assoc"), and which
  // associates are expanded within it. Keyed by store so opening one card's
  // Associates tab does not flip every other card.
  let detailPanes = {};
  let assocOpen = {};
  // WIN -> { name, title } resolved from shared/associateDirectory.js. Held in
  // memory only for the render; the raw WIN is what the capture stores, and a
  // name is never written back into the snapshot.
  //
  // KEYED BY normalizeWin(win) — lower-cased — never by the raw capture value.
  // associateDirectory keys every record that way, so getMany() hands back
  // lower-cased keys; reading the map with Tableau's verbatim WIN meant a WIN
  // carrying any upper case resolved successfully and then rendered as an id
  // anyway. Go through dirGet(), never directory.get() with a raw win.
  let directory = new Map();
  // WINs this mount has already put through the resolver, so a repaint does
  // not re-query them. Deliberately NOT expressed as a null in `directory`:
  // that conflates "we tried and failed" with "we hold no record", and it
  // would also clobber a record carrying a title but no name.
  let attempted = new Set();
  // Outcome of the last resolution pass, so the Associates card can explain a
  // column of ids instead of just showing one. null = never ran.
  let nameResolve = null;
  // Set when a pass failed transiently. Until it elapses, refreshDirectory()
  // does not re-attempt — otherwise every sort/expand render would re-fire a
  // full round of lookups at a Workvivo that is currently unreachable.
  let transientUntil = 0;

  // Digital associates per store, from Digital Metrics' classification map
  // ("Digital" and "Exceptions" are both digital roles). Names there are the
  // scheduler's; the card's names come from Workvivo, so both sides are folded
  // through digitalmetrics' canonical() before comparing. A store whose map
  // could not be read (not signed in to the metrics backend, no map yet) is
  // remembered for a few minutes so the card does not re-ask on every repaint.
  let digitalByStore = new Map();   // store -> { at, names: Set<canonical>, firstLast: Set<"FIRST LAST"> }
  const DIGITAL_TTL_MS = 30 * 60 * 1000;
  const DIGITAL_MISS_TTL_MS = 3 * 60 * 1000;
  let legacySig;   // signature of Digital Metrics' legacy fallback map; see refreshDigital()

  let homeMarket = await getUserHomeMarket();
  // The user's own store, marked on its card so it is findable in a market of
  // 20+ rings without hunting for the number. Read once at mount rather than
  // subscribed to: unlike the market there is no onUserStoreChange, and
  // changing it means a trip to Settings, which unmounts this view anyway.
  const homeStore = await getUserHomeStore();

  // Restore saved sort/order before the first paint so cards never flash in
  // one order and then jump to another.
  await loadUiPrefs();

  // 4. Wire handlers.
  btnRefresh.addEventListener("click", () => activeTab === "today" ? runToday(false) : runRefresh(false));
  btnForce.addEventListener("click", () => activeTab === "today" ? runToday(true) : runRefresh(true));
  btnLoadToday.addEventListener("click", () => runToday(false));
  btnForceToday.addEventListener("click", () => runToday(true));
  container.querySelector('[data-action="dismiss-error"]')?.addEventListener("click", dismissError);
  container.querySelector('[data-action="copy-diagnostics"]')?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const was = btn.textContent;
    try {
      // The market matters: a capture that silently does nothing is usually a
      // market whose value doesn't match the roster, so send what the UI has.
      const diag = await host.messaging.send("diagnostics", { market: selectedMarket });
      await navigator.clipboard.writeText(JSON.stringify(diag, null, 2));
      btn.textContent = "Copied ✓";
    } catch (err) {
      btn.textContent = `Failed: ${String(err?.message ?? err).slice(0, 40)}`;
    }
    setTimeout(() => { btn.textContent = was; }, 2500);
  });
  btnCancel.addEventListener("click", () => host.messaging.send("cancel_today").catch(() => {}));
  container.querySelector('[data-action="toggle-all"]')?.addEventListener("click", async () => {
    const rows = rowsForActiveTab();
    const key = selectedMarket ?? "_";
    const anyOpen = rows.some((r) => isExpanded(r.store));
    expanded[key] = anyOpen ? [] : rows.map((r) => String(r.store));
    await saveUiPrefs();
    render();
  });

  btnResetOrder.addEventListener("click", async () => {
    if (selectedMarket) delete customOrder[selectedMarket];
    sortMode = DEFAULT_SORT;
    await saveUiPrefs();
    render();
  });

  sortSelect.addEventListener("change", async () => {
    sortMode = sortSelect.value;
    await saveUiPrefs();
    render();
  });

  marketSelect.addEventListener("change", async () => {
    selectedMarket = marketSelect.value || null;
    marketIsUserSet = true;
    await saveUiPrefs();
    render();
  });

  // Delegated: the strip is rebuilt on every paint as the history grows.
  container.querySelector("[data-tabs]")?.addEventListener("click", async (e) => {
    const btn = e.target?.closest?.("[data-tab]");
    if (!btn) return;
    activeTab = btn.dataset.tab;
    await saveUiPrefs();
    render();
  });

  function expandedSet() {
    const key = selectedMarket ?? "_";
    if (!Array.isArray(expanded[key])) expanded[key] = [];
    return expanded[key];
  }
  function isExpanded(store) { return expandedSet().includes(String(store)); }

  function detailPane(store) { return detailPanes[String(store)] === "assoc" ? "assoc" : "dept"; }
  function isAssocOpen(store, win) {
    return Array.isArray(assocOpen[String(store)]) && assocOpen[String(store)].includes(win);
  }

  /**
   * Resolve the WINs on screen to names/titles, once per paint.
   *
   * Read-only against the directory the suite already builds — this never
   * triggers a lookup of its own. An unresolved WIN renders as the WIN, which
   * is honest: better a bare id than a confidently wrong name against a list
   * of who left work behind.
   */
  /**
   * Read the mount-local directory with the same key associateDirectory uses.
   *
   * Every read of `directory` MUST go through here. The store normalises WINs
   * to lower case; Tableau's location-details export passes the scanner's WIN
   * through verbatim, and those arrive mixed-case. A raw-key read therefore
   * missed records that had resolved perfectly — the name was in hand and the
   * card printed the id — and, because the "is it resolved?" test used the same
   * raw key, the WIN also looked permanently unresolved to the retry logic.
   */
  function dirGet(win) {
    return directory.get(normalizeWin(win));
  }

  const firstLastOf = (canon) => { const t = String(canon || "").split(" ").filter(Boolean); return t.length >= 2 ? `${t[0]} ${t[t.length - 1]}` : null; };

  /** True when the resolved name is on the store's digital roster. */
  function isDigital(store, name) {
    if (!name) return false;
    const d = digitalByStore.get(String(store));
    if (!d?.names?.size) return false;
    const c = canonicalName(name);
    if (d.names.has(c)) return true;
    // Middle initials differ between the scheduler and Workvivo; fall back to
    // first + last when that pair is unambiguous on the roster.
    const fl = firstLastOf(c);
    return !!fl && d.firstLast.has(fl);
  }

  /** Load the digital roster for every store on screen; true when something new arrived. */
  async function refreshDigital() {
    const stores = [...new Set(rowsForActiveTab().filter((r) => (r.isToday || r.dayDetail) && topAssociatesFor(r).shown.length).map((r) => String(r.store)))];
    const now = Date.now();
    const due = stores.filter((s) => { const d = digitalByStore.get(s); return !d || now - d.at > (d.names ? DIGITAL_TTL_MS : DIGITAL_MISS_TTL_MS); });
    if (!due.length) return false;
    let changed = false;
    const ask = (store) => new Promise((resolve) => { try { chrome.runtime.sendMessage({ module: "digitalmetrics", type: "get_classifications", store }, (r) => resolve(chrome.runtime.lastError || !r?.ok ? null : (r.data || {}))); } catch { resolve(null); } });
    // Digital Metrics answers a store that has no classification map of its own
    // with a legacy, store-less document (one store's roster from before maps
    // were per store). Marking another store's associates against it would be
    // wrong, so the legacy map is fetched once under an impossible store number
    // and any store whose map is identical to it is treated as having none.
    if (legacySig === undefined) { const legacy = await ask("0"); legacySig = legacy ? Object.keys(legacy).sort().join("\n") : null; }
    await Promise.all(due.map(async (store) => {
      let map = await ask(store);
      if (map && legacySig !== null && Object.keys(map).sort().join("\n") === legacySig) map = null;
      if (!map) { digitalByStore.set(store, { at: Date.now(), names: null, firstLast: null }); return; }
      const names = new Set(), firstLast = new Set(), dup = new Set();
      for (const [name, cls] of Object.entries(map)) {
        if (cls !== "Digital" && cls !== "Exceptions") continue;
        const c = canonicalName(name); if (!c) continue;
        names.add(c);
        const fl = firstLastOf(c); if (fl) { if (firstLast.has(fl)) dup.add(fl); firstLast.add(fl); }
      }
      for (const fl of dup) firstLast.delete(fl);   // ambiguous first+last: exact match only
      digitalByStore.set(store, { at: Date.now(), names, firstLast });
      changed = true;
    }));
    return changed;
  }

  // Workday job titles for the associates on screen, so the "D" badge works
  // for EVERY store — not only stores Digital Metrics holds a roster for, which
  // in practice is the analyst's home store (analyst's call 2026-09-14; this
  // overrides the 2026-08-22 "no titles in this view" note in refreshDirectory).
  //
  // Cost is one Workday scrape per associate, ever: results are permanent in
  // associateDirectory and needsWorkdayLookup() skips anyone already visited,
  // titled or not. A first pass over a market is minutes (serial, one
  // background tab), so it runs detached from paint and repaints per batch.
  //
  // `titleAttempted` is per mount and is what keeps this from looping: a WIN
  // Workday could not answer stays "needs lookup" (only a 1 h miss key), and
  // every repaint would otherwise start another pass over it.
  let titleRun = null;
  let titlesStopped = false;
  const titleAttempted = new Set();
  const TITLE_BATCH = 4;
  // OFF (analyst's call 2026-09-14, "home store only for now"). Workday's URL
  // search (search.htmld?q=<WIN>) now renders only the home chrome, so every
  // lookup times out after 12 s and stores nothing — minutes of background
  // Workday navigation per market for zero titles. The badge's title fallback
  // below stays in place and still uses any title already in the directory.
  // Turn back on once associateLookup can reach a profile (e.g. by driving
  // Workday's search box) — see CURRENT_TASKS.md §6b.
  const FETCH_WORKDAY_TITLES = false;
  function refreshTitles() {
    if (!FETCH_WORKDAY_TITLES) return null;
    if (titleRun || titlesStopped) return titleRun;
    const wins = new Set();
    for (const r of rowsForActiveTab()) {
      for (const a of topAssociatesFor(r).shown) if (a.win) wins.add(normalizeWin(a.win));
    }
    const due = [...wins].filter((w) => w && !titleAttempted.has(w) && needsWorkdayLookup(dirGet(w)));
    if (!due.length) return null;
    for (const w of due) titleAttempted.add(w);
    titleRun = (async () => {
      for (let i = 0; i < due.length && !titlesStopped; i += TITLE_BATCH) {
        const batch = due.slice(i, i + TITLE_BATCH);
        try {
          await lookupTitles(batch);
          let changed = false;
          for (const [win, rec] of await associateDirectory.getMany(batch)) {
            if (rec?.title && dirGet(win)?.title !== rec.title) changed = true;
            directory.set(win, rec);
          }
          if (changed && !titlesStopped) render();
        } catch { break; }
      }
    })().finally(() => { titleRun = null; });
    return titleRun;
  }

  async function refreshDirectory() {
    // Only the associates actually on screen. Collecting every WIN in the
    // market meant resolving hundreds of people nobody would ever see.
    const wins = new Set();
    for (const r of rowsForActiveTab()) {
      for (const a of topAssociatesFor(r).shown) if (a.win) wins.add(normalizeWin(a.win));
    }
    if (!wins.size) return false;
    // "Missing" means MISSING A NAME — not missing a record. The two are not
    // the same thing and treating them as one is what made the home store
    // render a column of ids: digitallocks writes title/tenure from Workday
    // for associates a reviewer opened, and those records carry no name. Any
    // store the other tools had been used against therefore looked "known",
    // skipped the resolver entirely, and rendered the WIN — permanently, since
    // the nameless record survives a reload. Stores with no prior tool usage
    // resolved fine, which is why this looked store-specific.
    const missing = [...wins].filter((w) => !hasName(dirGet(w)) && !attempted.has(w));
    if (!missing.length) return false;
    // Backing off after a transient failure. Not `attempted`, because these
    // WINs are still owed a lookup — just not right now.
    if (transientUntil && Date.now() < transientUntil) return false;

    // 1. Whatever the suite already knows — free, one storage round trip, and
    //    covers every WIN any other module has resolved before.
    let changed = false;
    try {
      const found = await associateDirectory.getMany(missing);
      for (const [win, rec] of found) { directory.set(win, rec); changed = true; }
    } catch { /* fall through to the resolver */ }

    // 2. Resolve what is still unknown, rather than rendering a bare WIN and
    //    waiting for someone to open the claims tool. This is the whole point
    //    of the shared resolver: a list of who left picks behind is useless if
    //    it is a column of ids.
    //
    //    associateLookup dedupes concurrent calls, caches negatives short-term
    //    (a "no match" is usually a failure, not a fact), and writes results
    //    into the permanent store — so every other module gets them too.
    const stillMissing = missing.filter((w) => !hasName(dirGet(w)));
    if (stillMissing.length) {
      const before = lookupDiagnostics();
      let threw = null;
      try {
        await lookupNames(stillMissing);
        const found2 = await associateDirectory.getMany(stillMissing);
        for (const [win, rec] of found2) { directory.set(win, rec); changed = true; }
      } catch (e) { threw = String(e?.message ?? e); }

      // Why the bare WINs, if there are any. Rendering an id and saying
      // nothing is what made this look like a bug in the Associates view when
      // it is really Workvivo being unreachable or a standing miss — so record
      // the reason, both to the debug feed and to the card itself.
      const d = diffLookupDiagnostics(before);
      const unresolved = stillMissing.filter((w) => !hasName(dirGet(w))).length;
      nameResolve = { ...d, asked: stillMissing.length, unresolved, threw };
      if (unresolved) {
        log.emit("names_unresolved", {
          asked: stillMissing.length, unresolved,
          attempts: d.attempts, resolved: d.resolved,
          definitiveMiss: d.definitiveMiss, transient: d.transient,
          cachedMiss: d.cachedMiss, lastError: d.lastError, threw,
        });
      }
    }

    // NO title lookup here, deliberately (dropped 2026-08-22). Workday needs
    // its own background tab and a DOM scrape PER WIN, serial because they
    // would otherwise fight over that tab — roughly 4s each, against ten
    // associates per store across a whole market. That is minutes of
    // background scraping to decorate a list already readable from names.
    //
    // A title still RENDERS when the directory happens to hold one: digitallocks
    // resolves title and tenure for associates a reviewer opens, so titles
    // accumulate as a side effect of work someone actually asked for rather
    // than being swept up speculatively.
    //
    // shared/associateLookup.js::lookupTitle stays for that user-initiated
    // path. This view simply does not call it.

    // Bank "we tried this one" ONLY when the pass was conclusive.
    //
    // A transient failure — Workvivo not signed in, no tab open yet, the SW
    // torn down mid-executeScript — is not evidence about the WIN. Marking it
    // here is what made one bad pass permanent for the life of the mount:
    // nothing re-queried when a fresh capture landed, so a card that opened
    // before Workvivo had a session showed ids until the user navigated away
    // and back. `attempted` exists to stop a repaint re-querying a DEFINITIVE
    // miss, which is a different thing.
    //
    // Not re-queried on every render either — a transient pass sets a cooldown
    // so sorting or expanding a card can't hammer Workvivo while it's down.
    const passWasTransient = Boolean(nameResolve?.transient || nameResolve?.threw);
    if (passWasTransient) {
      transientUntil = Date.now() + TRANSIENT_RETRY_MS;
    } else {
      transientUntil = 0;
      for (const w of missing) attempted.add(w);
    }
    return changed;
  }

  // Compared NUMERICALLY on purpose. getUserHomeStore() strips leading zeros
  // ("...s01458" → "1458") while the Tableau Store column is passed through
  // verbatim, so a string compare would miss a store the export writes padded.
  function isHomeStore(store) {
    if (!homeStore) return false;
    const a = Number(store), b = Number(homeStore);
    return Number.isFinite(a) && Number.isFinite(b) && a === b;
  }
  async function toggleStore(store) {
    const list = expandedSet();
    const i = list.indexOf(String(store));
    if (i >= 0) list.splice(i, 1); else list.push(String(store));
    await saveUiPrefs();
    render();
  }

  // ── Drag to rearrange ────────────────────────────────────────────
  // Uses native HTML5 drag-and-drop on the cards. Dropping commits the new
  // order, switches the sort control to "custom", and persists it.
  const grid = container.querySelector("[data-store-cards]");

  // Toggle a single card's text rows. Registered before the drag handlers and
  // stops propagation so pressing the toggle never begins a drag.
  grid.addEventListener("click", (e) => {
    const btn = e.target?.closest?.("[data-toggle-store]");
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    toggleStore(btn.dataset.toggleStore);
  });

  // Print / Email one card. Delegated and stopPropagation for the same reason
  // as the toggle above: the card is draggable, and a mousedown that starts a
  // drag would otherwise swallow the click.
  grid.addEventListener("click", (e) => {
    const btn = e.target?.closest?.("[data-card-print], [data-card-picklist], [data-card-email]");
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const d = btn.dataset;
    const store = d.cardPrint ?? d.cardPicklist ?? d.cardEmail;
    const row = rowsForActiveTab().find((x) => String(x.store) === String(store));
    if (!row) return;
    if (d.cardEmail != null) { emailCard(row).catch(() => {}); return; }
    // Opened HERE, synchronously, while the click's user activation is still
    // live — printCard awaits name resolution and by then it would be blocked.
    const w = window.open("", "_blank", "width=820,height=900");
    try { w?.document.write(PRINT_PLACEHOLDER); } catch { /* about:blank is fine */ }
    printCard(row, d.cardPicklist != null ? "picklist" : "performance", w).catch(() => {});
  });

  // Department / Associates tab swap. Delegated because the grid is rebuilt on
  // every paint, and stopPropagation so a tab click never starts a card drag.
  grid.addEventListener("click", async (e) => {
    const tab = e.target?.closest?.("[data-detail-tab]");
    if (!tab) return;
    e.preventDefault();
    e.stopPropagation();
    detailPanes[String(tab.dataset.detailStore)] = tab.dataset.detailTab;
    await saveUiPrefs();
    render();
  });

  // Expand / collapse one associate's bins.
  grid.addEventListener("click", async (e) => {
    const btn = e.target?.closest?.("[data-assoc-win]");
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const store = String(btn.dataset.assocStore);
    const win = btn.dataset.assocWin;
    const list = (assocOpen[store] ??= []);
    const i = list.indexOf(win);
    if (i >= 0) list.splice(i, 1); else list.push(win);
    await saveUiPrefs();
    render();
  });

  grid.addEventListener("dragstart", (e) => {
    const card = e.target?.closest?.(".vizpick-store-card");
    if (!card) return;
    dragStore = card.dataset.store;
    card.classList.add("is-dragging");
    e.dataTransfer.effectAllowed = "move";
    // Firefox refuses to start a drag without payload.
    try { e.dataTransfer.setData("text/plain", dragStore); } catch {}
  });

  grid.addEventListener("dragend", () => {
    dragStore = null;
    grid.querySelectorAll(".is-dragging,.is-drop-target")
        .forEach((el) => el.classList.remove("is-dragging", "is-drop-target"));
  });

  grid.addEventListener("dragover", (e) => {
    if (dragStore == null) return;
    e.preventDefault();               // required to allow a drop
    e.dataTransfer.dropEffect = "move";
    const over = e.target?.closest?.(".vizpick-store-card");
    grid.querySelectorAll(".is-drop-target").forEach((el) => el.classList.remove("is-drop-target"));
    if (over && over.dataset.store !== dragStore) over.classList.add("is-drop-target");
  });

  grid.addEventListener("drop", async (e) => {
    if (dragStore == null) return;
    e.preventDefault();
    const over = e.target?.closest?.(".vizpick-store-card");
    if (!over || over.dataset.store === dragStore) return;

    // Start from whatever order is currently on screen, then move the dragged
    // card to the target's slot.
    const order = [...grid.querySelectorAll(".vizpick-store-card")].map((el) => el.dataset.store);
    const from = order.indexOf(dragStore);
    const to   = order.indexOf(over.dataset.store);
    if (from < 0 || to < 0) return;
    order.splice(to, 0, ...order.splice(from, 1));

    if (selectedMarket) customOrder[selectedMarket] = order;
    sortMode = "custom";
    dragStore = null;
    await saveUiPrefs();
    render();
  });

  // 5. Initial paint from persisted state.
  await paint();

  // 6. Re-paint when a background/other-tab refresh completes.
  //
  // A completed capture is the one moment worth re-asking about names: the rows
  // are new (so there are WINs nobody has looked up), and time has passed (so a
  // Workvivo session that was missing may now exist). Without clearing
  // `attempted`, a mount that resolved nothing on its first pass stayed that way
  // for as long as the module was open, however many refreshes landed behind it
  // — the ids never filled in and nothing said why. Definitive misses are still
  // cheap to re-ask: associateDirectory holds them for an hour and answers from
  // storage without touching the network.
  const unsub = host.messaging.on("source_complete", () => {
    attempted.clear();
    transientUntil = 0;
    paint();
  });
  const unsubProgress = host.messaging.on("today_progress", (p) => { renderTodayBar(p); });
  const unsubPhase = host.messaging.on("capture_phase", (p) => {
    if (p?.phase) { lastRunNote = p.phase; paintRunNote(); }
  });
  // Each store of the Today crawl is persisted as it lands, so repaint to show
  // its card rather than leaving the tab empty until the whole crawl ends.
  //
  // COALESCED, and that is not an optimisation. paint() rebuilds the whole
  // card grid via innerHTML, which resets scroll position — perfectly fine
  // when the user just pressed "Load today's data" and is watching a progress
  // bar, and awful once the crawl also runs unprompted in the background. A
  // 3-lane crawl lands a store every ~6s, so an idle reader watching the page
  // had it yank itself out from under them every few seconds for two minutes,
  // every time the auto-refresh fired. Batch the arrivals instead: one repaint
  // shortly after the last row lands, plus the final one from source_complete.
  let rowsRepaintTimer = null;
  const unsubRows = host.messaging.on("today_rows", () => {
    if (rowsRepaintTimer) clearTimeout(rowsRepaintTimer);
    rowsRepaintTimer = setTimeout(() => { rowsRepaintTimer = null; paint(); }, ROWS_REPAINT_DEBOUNCE_MS);
  });

  // 7. Follow the Settings → Defaults home market unless the user picked one.
  const unsubMarket = onUserMarketChange((m) => {
    homeMarket = m;
    if (!marketIsUserSet) {
      selectedMarket = null;
      render();
    }
  });

  // ── Actions ─────────────────────────────────────────────────────
  // A capture can legitimately run for minutes, but it must never be able to
  // spin forever — if the service worker is torn down mid-flight the reply
  // never arrives and the promise simply never settles. Race every long call
  // against a client-side deadline so the UI always recovers.
  function withWatchdog(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, timedOut: true, label }), ms)),
    ]);
  }

  // `force` re-exports even when Tableau's stamp is unchanged. The default is
  // to skip: an unchanged stamp means the data on screen is already the data
  // upstream has, so re-downloading ~4,600 rows would change nothing.
  async function runRefresh(force) {
    // Only the button reaches here. The 30-minute autocheck runs in the
    // service worker and never touches this view, so this is unambiguously
    // a person asking for a pull.
    host.usage.record(force ? "refresh_yesterday_forced" : "refresh_yesterday");
    setBusy(btnRefresh, true);
    btnForce.hidden = true;
    let res = null;
    try {
      res = await withWatchdog(host.messaging.send("pull_stores", { force: !!force }), 330_000, "refresh");
    } catch (e) {
      console.warn("[vizpick] pull_stores failed:", e?.message ?? e);
    } finally {
      setBusy(btnRefresh, false);
      await paint();
      lastRunNote = noteFor(res, "yesterday");
      btnForce.hidden = !res?.unchanged;
      paintRunNote();
    }
  }

  async function runToday(force) {
    if (btnLoadToday.disabled || state?.todayProgress) return;
    host.usage.record(force ? "refresh_today_forced" : "refresh_today");
    const stores = rosterRows().map((r) => r.store);
    if (!stores.length) {
      renderTodayBar(null, "Refresh the Yesterday tab first — it supplies the store list for this market.");
      return;
    }
    btnLoadToday.disabled = true;
    setBusy(btnRefresh, true);
    btnCancel.hidden = false;
    btnForceToday.hidden = true;
    let res = null;
    try {
      res = await withWatchdog(
        host.messaging.send("pull_today", { stores, market: selectedMarket, force: !!force }),
        45 * 60_000, "today capture");
    } catch (e) {
      console.warn("[vizpick] pull_today failed:", e?.message ?? e);
    } finally {
      btnLoadToday.disabled = false;
      setBusy(btnRefresh, false);
      btnCancel.hidden = true;
      await paint();
      lastRunNote = noteFor(res, "today");
      btnForceToday.hidden = !res?.unchanged;
      paintRunNote();
    }
  }

  // Human-readable outcome of the last capture, so a skipped run doesn't look
  // like a no-op or a failure.
  function noteFor(res, which) {
    if (!res) return null;
    if (res.timedOut) {
      return `The ${res.label} is taking longer than expected and the page stopped waiting for it. ` +
             `It may still finish in the background — reopen this module in a minute to see. ` +
             `If a Tableau tab was left open, check whether it is actually rendering.`;
    }
    if (!res.ok) return null;
    if (res.unchanged) {
      const raw = res.sourceUpdate?.raw;
      return `Already up to date — Tableau hasn't republished${raw ? ` since ${raw}` : ""}. Nothing was re-downloaded.`;
    }
    if (which === "today") return `Captured ${res.storeCount} of ${res.requested} stores.`;
    return res.rolled
      ? `New data captured — the previous day's snapshot was kept for comparison.`
      : `Captured ${res.storeCount} stores.`;
  }

  function paintRunNote() {
    const el = container.querySelector("[data-run-note]");
    if (!el) return;
    el.textContent = lastRunNote || "";
    el.hidden = !lastRunNote;
  }

  function setBusy(btn, busy) {
    btn.disabled = busy;
    const spinner = btn.querySelector(".btn-spinner");
    if (spinner) spinner.hidden = !busy;
  }

  // ── Rendering ───────────────────────────────────────────────────
  async function paint() {
    try {
      state = await host.messaging.send("get_state");
    } catch (e) {
      console.warn("[vizpick] get_state failed:", e?.message ?? e);
      return;
    }
    render();
  }

  function dayList() { return state?.days || []; }
  function activeDayKey() {
    return typeof activeTab === "string" && activeTab.startsWith("day:") ? activeTab.slice(4) : null;
  }
  function activeDay() {
    const k = activeDayKey();
    return k ? dayList().find((d) => d.dataDate === k) || null : null;
  }
  /** Newest closed day — the roster every other view is keyed against. */
  function rosterRows() {
    const all = dayList()[0]?.rows || state?.rows || [];
    return selectedMarket ? all.filter((r) => r.market === selectedMarket) : [];
  }
  /** Rows of whichever closed day is selected. */
  function dayRows() {
    const all = activeDay()?.rows || [];
    const rows = selectedMarket ? all.filter((r) => r.market === selectedMarket) : [];
    // The summary export has no department or location dimension; those come
    // from the day's LAST current-day capture (lib/day_details.js), joined by
    // store. The headline numbers stay the summary's — it is the closed day.
    const details = state?.dayDetails?.[activeDayKey()];
    if (!details) return rows;
    const safe = new Map(withholdDuplicateLocations(Object.values(details)).map((d) => [String(d.store), d]));
    return rows.map((r) => {
      const d = safe.get(String(r.store));
      return d ? {
        ...r,
        depts: d.depts, deptCount: d.deptCount, deptGroups: d.deptGroups,
        locations: d.locations, locationsWithheld: d.locationsWithheld || null,
        dayDetail: { sourceUpdate: d.sourceUpdate, capturedAt: d.capturedAt, fromHistory: !!d.fromHistory },
      } : r;
    });
  }

  /** "As of the last update that day" line for a closed-day card's detail. */
  function dayDetailNote(r) {
    const d = r.dayDetail;
    if (!d) return "";
    const iso = d.sourceUpdate?.iso || d.capturedAt;
    const at = iso ? new Date(iso) : null;
    const when = at && !Number.isNaN(at.getTime())
      ? at.toLocaleString(undefined, { weekday: "short", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" })
      : "time unknown";
    const label = d.sourceUpdate?.iso ? "Tableau update" : "read";
    const title = "Department and associate detail is the last current-day reading kept for this day; "
      + "the rings above are the closed-day summary, so the two can differ."
      + (d.fromHistory ? " Rebuilt from the home-store pick history; percentages are computed." : "");
    return `<p class="vizpick-dept-none vizpick-daydetail-note" title="${escapeHtml(title)}">As of the day's last ${label}: ${escapeHtml(when)}</p>`;
  }

  function todayRows() {
    // Today rows carry no market/BU/region of their own (the Details export
    // has no such columns), so they're joined back onto the yesterday roster
    // by store number — which is also what scoped the capture.
    // Safety net for what is already stored: two stores with identical
    // location detail means a capture landed on the wrong store, and the
    // data cannot say which — withhold it from both rather than show one
    // store's associates under another (lib/today_coverage.js).
    const today = withholdDuplicateLocations(state?.today?.rows || []);
    if (!today.length) return [];
    const roster = new Map(rosterRows().map((r) => [r.store, r]));
    return today
      .filter((t) => roster.has(t.store))
      .map((t) => {
        // Take ONLY identity from the yesterday roster. Spreading the whole
        // row used to leak yesterday's metrics (Pallets % in particular) onto
        // Today cards, where they read as current-day figures.
        const { bu, region, market } = roster.get(t.store);
        return { bu, region, market, ...projectTodayRow(t) };
      });
  }

  /**
   * Roster stores the last Today run recorded a real per-store failure for
   * (lane and budget notes are soft and excluded). Only the most recent
   * result counts: an older saved envelope describes a different run.
   */
  function lastRunFailedStores() {
    const dbg = state?.debugToday;
    const fails = dbg?.debug?.failures;
    if (!dbg?.ok || !Array.isArray(fails)) return [];
    const todayAt = state?.today?.capturedAt ? new Date(state.today.capturedAt).getTime() : 0;
    const dbgAt = dbg.capturedAt ? new Date(dbg.capturedAt).getTime() : 0;
    if (todayAt && dbgAt && dbgAt < todayAt - 60_000) return [];
    const roster = new Set(rosterRows().map((r) => String(r.store)));
    return [...new Set(fails.filter((f) => !f.soft && roster.has(String(f.store))).map((f) => String(f.store)))];
  }

  // Map the Details/current-day fields onto the same shape the cards render.
  // Location % and the VizPick composite have no current-day equivalent in
  // the Details export, so they are explicitly absent rather than faked.
  function projectTodayRow(t) {
    // Location %, Overstock % and the VizPick composite come from the
    // donut-health sheet (t.locationPct / t.overstockPct / t.vizpick). If that
    // second export failed for this store they stay undefined, and the card
    // simply omits those rows rather than showing a fake 0.
    return {
      store:           t.store,
      vizpick:         t.vizpick,
      casesSeenPct:    t.casesSeenPct,
      locationPct:     t.locationPct,
      overstockPct:    t.overstockPct,
      pickPct:         t.pickPct,
      totalPicked:     t.totalPicked,
      casesSeen:       t.casesSeen,
      casesExpected:   t.casesExpected,
      picksCompleted:  t.suggestedPicksCompleted,
      picksSuggested:  t.suggestedPicks,
      overstockExceptions: t.overstockExceptions,
      // Per-department rows, current day only — the Yesterday summary export
      // has no department dimension at all.
      depts:           t.depts,
      deptGroups:      t.deptGroups,
      locations:       t.locations,
      locationsWithheld: t.locationsWithheld || null,
      deptCount:       t.deptCount,
      // This store's own Tableau stamp and capture time. Stores publish on
      // their own clocks, so each card shows its own rather than the
      // snapshot's; rows captured before 2026-09-15 have none.
      sourceUpdate:    t.sourceUpdate ?? null,
      capturedAt:      t.capturedAt ?? null,
      confirmedAt:     t.confirmedAt ?? null,
      isToday:         true,
    };
  }

  function rowsForActiveTab() {
    return activeTab === "today" ? todayRows() : dayRows();
  }

  function activeSnapshot() {
    return activeTab === "today" ? state?.today : activeDay();
  }
  function activeNote() { return activeTab === "today" ? TODAY_NOTE : DAY_NOTE; }
  function activeTabLabel() {
    if (activeTab === "today") return "Today — Live";
    const { name, date } = dayTabLabel(activeDayKey());
    return `${name} ${date}`.trim();
  }

  function render() {
    if (!state) return;
    paintMarketOptions();
    paintTabs();
    paintUpdatedBar();
    paintTodayBar();
    paintRunNote();

    const rows = rowsForActiveTab();
    const meta = container.querySelector("[data-picker-meta]");
    if (meta) meta.textContent = rows.length ? `${rows.length} store${rows.length === 1 ? "" : "s"}` : "";

    renderGauges(rows);
    renderStoreCards(rows);
    paintDebug();
    // Names arrive asynchronously; repaint only if this pass resolved
    // something new, so it cannot loop.
    Promise.all([refreshDirectory(), refreshDigital().catch(() => false)])
      .then(([names, roster]) => { if (names || roster) render(); })
      .catch(() => {});
    // Detached: a first pass is minutes, and it repaints per batch itself.
    refreshTitles();
  }

  function paintMarketOptions() {
    const all = dayList()[0]?.rows || state?.rows || [];
    const markets = [...new Set(all.map((r) => r.market))].sort(
      (a, b) => Number(a) - Number(b) || a.localeCompare(b)
    );

    if (!markets.length) {
      marketSelect.innerHTML = `<option value="">No data yet — click Refresh</option>`;
      marketSelect.disabled = true;
      selectedMarket = null;
      return;
    }

    if (!selectedMarket || !markets.includes(selectedMarket)) {
      selectedMarket = (homeMarket && markets.includes(homeMarket)) ? homeMarket : markets[0];
      // Persist the resolved default too, not just explicit picks — otherwise
      // the very first visit re-resolves from scratch on every mount. Only
      // reached when the value actually changed, so this is not a per-render
      // write. Fire-and-forget: render() is sync and prefs are best-effort.
      saveUiPrefs().catch(() => {});
    }

    marketSelect.innerHTML = markets
      .map((m) => `<option value="${escapeHtml(m)}"${m === selectedMarket ? " selected" : ""}>Market ${escapeHtml(m)}</option>`)
      .join("");
    marketSelect.disabled = false;
  }

  function paintTabs() {
    const strip = container.querySelector("[data-tabs]");
    if (!strip) return;
    const days = dayList();

    // Today first and leftmost, then the closed days newest -> oldest.
    const tabs = [{
      id: "today",
      name: "Today — Live",
      date: state?.today?.sourceUpdate?.iso
        ? new Date(state.today.sourceUpdate.iso).toLocaleDateString(undefined, { weekday: "short", month: "numeric", day: "numeric" })
        : (state?.today?.rows?.length ? "loaded" : "not loaded"),
    }];
    for (const d of days) {
      const { name, date } = dayTabLabel(d.dataDate);
      tabs.push({ id: `day:${d.dataDate}`, name, date });
    }

    // Resolve the default once the history is known: Today when it has data,
    // otherwise the newest closed day.
    if (!activeTab || !tabs.some((t) => t.id === activeTab)) {
      activeTab = state?.today?.rows?.length ? "today" : (tabs[1]?.id ?? "today");
      saveUiPrefs().catch(() => {});
    }

    strip.innerHTML = tabs.map((t) => `
      <button class="vizpick-tab" role="tab" data-tab="${escapeHtml(t.id)}"
              aria-selected="${t.id === activeTab}">
        <span class="vizpick-tab-name">${escapeHtml(t.name)}</span>
        <span class="vizpick-tab-date">${escapeHtml(t.date)}</span>
      </button>`).join("");
  }

  function paintUpdatedBar() {
    const absEl   = container.querySelector("[data-updated-abs]");
    const freshEl = container.querySelector('[data-freshness="stores"]');
    if (absEl) {
      const snap = activeSnapshot();
      // Today: stores publish on their own clocks, so the header can only
      // honestly show the NEWEST store's stamp and say so when they differ —
      // each card carries its own.
      const spread = activeTab === "today" ? stampSpread(snap?.rows) : null;
      const su = spread?.newest ?? snap?.sourceUpdate;
      const note = activeNote();

      if (!snap) {
        absEl.textContent = "—";
        absEl.title = note;
      } else if (su?.iso) {
        const d = new Date(su.iso);
        const day = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
        if (su.hasTime) {
          const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
          if (spread?.differ) {
            const o = new Date(spread.oldest.iso);
            absEl.textContent = `${day} — ${time} (newest store)`;
            absEl.title = `Stores update at different times. Newest store stamp ${d.toLocaleString()} (${humanAge(Date.now() - d.getTime())} ago), oldest ${o.toLocaleString()} (${humanAge(Date.now() - o.getTime())} ago). Each card shows its own. ${note}`;
          } else {
            absEl.textContent = `${day} — ${time}`;
            absEl.title = `Tableau last updated ${d.toLocaleString()} (${humanAge(Date.now() - d.getTime())} ago). ${note}`;
          }
        } else {
          absEl.textContent = day;
          absEl.title = `Tableau last updated ${day}. This view publishes a date with no clock time. ${note}`;
        }
      } else {
        absEl.textContent = "date unknown";
        absEl.title = snap.capturedAt
          ? `Tableau's update stamp could not be read. Captured ${humanAge(Date.now() - new Date(snap.capturedAt).getTime())} ago. ${note}`
          : note;
      }
    }

    if (freshEl) {
      const f = activeTab === "today" ? state?.todayFreshness : state?.freshness;
      const { text, state: fstate } = renderFreshness(f);
      freshEl.textContent = text;
      freshEl.dataset.state = fstate;
    }
  }

  function paintTodayBar() {
    const bar = container.querySelector("[data-today-bar]");
    if (!bar) return;
    if (activeTab !== "today") { bar.hidden = true; return; }
    bar.hidden = false;

    // A crawl may have been started from another window, or before this page
    // was opened — the service worker holds the progress, so reopening the
    // module picks it up mid-flight rather than showing "not loaded".
    const inFlight = state?.todayProgress;
    if (inFlight && (inFlight.total || inFlight.stage)) { renderTodayBar(inFlight); return; }

    const n = todayRows().length;
    const roster = rosterRows().length;

    // Derived from what is ON SCREEN, not from the stored `partial` flag.
    //
    // That flag is a property of the last RUN, and a later top-up that filled
    // every gap did not clear it — so a complete 10-of-10 capture kept
    // announcing "Some stores could not be captured", sending the reader
    // hunting for a store sitting right in front of them. Counting rows cannot
    // disagree with the cards beside it.
    const missing = Math.max(0, roster - n);
    // Captured but thin is a DIFFERENT problem and deserves different words:
    // the store is there, some of its rings are not.
    const thin = todayRows().filter((r) => !isTodayRowComplete(r)).length;
    // A store the last run could not read KEEPS its previous row (the crawl
    // merges, never replaces — 2026-09-15), so it is on screen under an older
    // "Updated" time rather than missing. Say so; a quiet stale card is the
    // wrong-store bug's cousin.
    const shown = new Set(todayRows().map((r) => String(r.store)));
    const kept = lastRunFailedStores().filter((s) => shown.has(s));
    const keptNote = kept.length
      ? ` ${kept.length} store${kept.length === 1 ? "" : "s"} (${kept.join(", ")}) did not answer on the last run and ${kept.length === 1 ? "shows its" : "show their"} previous numbers — see each card's Updated time and the capture details below.`
      : "";
    const coverageNote = (missing
      ? ` ${missing} store${missing === 1 ? "" : "s"} could not be captured — see the capture details below.`
      : thin
        ? ` ${thin} store${thin === 1 ? " needs" : "s need"} a data repair — Refresh retries incomplete stores.`
        : "") + keptNote;

    renderTodayBar(
      null,
      (n
        ? `Showing ${n} of ${roster} stores in this market.` + coverageNote +
          " Today is captured one store at a time, so reloading takes a couple of minutes."
        : `Today's numbers come from Tableau's VizPick Details view, which reports one store at a time. ` +
          `Loading this market means ${roster} exports, spread across 3 background tabs — about two minutes.`)
      + " " + todayHealthNote() + " " + autoTodayNote()
    );
  }

  // Is what is on screen actually CURRENT?
  //
  // A failed capture deliberately leaves the stored snapshot alone — losing
  // good rows to a bad run would be worse. The cost is that a frozen tab looks
  // completely normal: on 2026-08-22 Tableau renamed two columns, every
  // capture had failed for two days, and the cards still showed a confident
  // "10 of 10 stores" from the last good pull. The stamp above was honest the
  // whole time; nothing connected it to "and every attempt since has failed".
  //
  // freshness.today already knows all of this and was simply never rendered —
  // the header only ever showed the `stores` source.
  function todayHealthNote() {
    const f = state?.todayFreshness;
    if (!f || !state?.today?.rows?.length) return "";
    if (f.inFlight) return "";
    if (f.lastError) {
      const since = f.lastSuccess ? humanAge(Date.now() - new Date(f.lastSuccess).getTime()) : null;
      return `⚠ These numbers are from the last successful capture${since ? ` ${since} ago` : ""} — ` +
             `every attempt since has failed. See the capture details below.`;
    }
    if (f.isStale && f.lastSuccess) {
      return `⚠ Last captured ${humanAge(Date.now() - new Date(f.lastSuccess).getTime())} ago.`;
    }
    return "";
  }

  // Whether the background refresh is actually going to do anything, in words.
  //
  // This exists because the first version of the auto-refresh skipped silently
  // when no home market was set: the feature did nothing, said nothing, and was
  // reported as broken — correctly, since from the outside it was. The text is
  // built from state.autoToday, which the service worker fills using the same
  // function autoCheck() calls, so the UI cannot claim something the background
  // job won't do.
  function autoTodayNote() {
    const a = state?.autoToday;
    if (!a) return "";
    if (a.enabled === false) return "Auto-refresh for Today is switched off.";
    if (!a.market) return `Auto-refresh is idle — ${a.reason}.`;
    const mine = a.source === "home-market" ? "your home market" : "the market you last loaded";
    // Deliberately "checks", not "refreshes". It reads Tableau's own Updated
    // stamp — now straight off the dashboard rather than by exporting a sheet
    // — and only reloads when that stamp has moved. The current-day data
    // republishes every few hours, so the check almost always finds nothing to
    // do and costs nothing. Saying "auto-refreshing every 30 minutes" implied a
    // two-minute crawl on the half hour, which is not what happens.
    return `Checks ${mine} (${a.market}) every ${a.periodMin} min and re-reads only the stores whose own Updated stamp has moved.`;
  }

  function renderTodayBar(progress, message) {
    const statusEl = container.querySelector("[data-today-status]");
    if (!statusEl) return;

    if (progress && (progress.total || progress.stage)) {
      const { done = 0, total = 0, store, etaMs, stage, lanes } = progress;

      // Before the first store lands there is over a minute of setup — cold
      // viz render, the source-stamp export, opening the lanes. Naming the
      // step keeps the bar honest instead of sitting on "0 of 10".
      const headline = done === 0 && stage
        ? `${escapeHtml(stage)}…`
        : `Capturing today — store ${Math.min(done + 1, total)} of ${total}`;

      // Today is captured one store at a time and a full market runs for
      // minutes. Without an ETA the progress bar reads as a hang.
      const eta = Number.isFinite(etaMs) && etaMs > 0 ? ` · about ${humanAge(etaMs)} left` : "";
      const detail = store
        ? ` <span class="vizpick-muted">(store ${escapeHtml(store)}${escapeHtml(eta)})</span>`
        : (lanes > 1 ? ` <span class="vizpick-muted">(${lanes} tabs)</span>` : "");

      // An indeterminate bar during setup — a 0%-wide bar looks stalled.
      const pct = total ? Math.round((done / total) * 100) : 0;
      const fill = done === 0 && stage
        ? `<div class="vizpick-progress-fill vizpick-progress-indeterminate"></div>`
        : `<div class="vizpick-progress-fill" style="width:${pct}%"></div>`;

      statusEl.innerHTML =
        `<strong>${headline}</strong>${detail}<div class="vizpick-progress">${fill}</div>`;
      btnLoadToday.disabled = true;
      btnCancel.hidden = false;
    } else {
      statusEl.textContent = message || "";
      btnLoadToday.disabled = false;
      btnCancel.hidden = true;
    }
  }

  function renderGauges(rows) {
    const wrap = container.querySelector("[data-gauges]");
    const sub  = container.querySelector("[data-gauges-sub]");
    if (sub) {
      sub.textContent = rows.length
        ? `${activeTabLabel()} · Market ${selectedMarket ?? "—"} · mean of ${rows.length} store${rows.length === 1 ? "" : "s"}`
        : "";
    }
    if (!wrap) return;
    if (!rows.length) {
      wrap.innerHTML = `<p class="vizpick-empty">${
        activeTab === "today"
          ? "No today data loaded yet for this market."
          : "Click Refresh, then pick a market above to see its gauges."
      }</p>`;
      return;
    }

    // Average only over stores that actually reported the metric, so a
    // metric absent from the current-day export doesn't drag an average to 0.
    const avg = (key) => {
      const vals = rows.map((r) => r[key]).filter((v) => Number.isFinite(v));
      return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : NaN;
    };

    const gauges = [
      // Judged on the same goals as the four beside it — the composite IS
      // their mean attainment, so 100 means all four at target.
      { key: "vizpick",      label: "VizPick Health", goal: GOALS.vizpick },
      { key: "casesSeenPct", label: "Cases Seen %",   goal: GOALS.casesSeenPct },
      { key: "locationPct",  label: "Location %",     goal: GOALS.locationPct },
      { key: "pickPct",      label: "Pick %",         goal: GOALS.pickPct },
      { key: "overstockPct", label: "Overstock %",    goal: GOALS.overstockPct },
    ];

    wrap.innerHTML = gauges
      .map((g) => {
        const v = avg(g.key);
        if (!Number.isFinite(v)) {
          return `<div class="vizpick-gauge vizpick-gauge-na">
              <div class="vizpick-gauge-na-box">n/a</div>
              <div class="vizpick-gauge-label">${escapeHtml(g.label)}<span class="vizpick-gauge-goal">not in this view</span></div>
            </div>`;
        }
        return gaugeSvg(v, { goal: g.goal, label: g.label, fmt: (x) => Math.round(x).toString() });
      })
      .join("");
  }

  function renderStoreCards(rows) {
    const wrap  = container.querySelector("[data-store-cards]");
    const count = container.querySelector("[data-store-count]");
    const hint  = container.querySelector(".vizpick-draghint");
    if (!wrap) return;

    if (count) count.textContent = rows.length ? `${rows.length} stores` : "";
    if (hint) hint.hidden = !rows.length;

    const btnAll = container.querySelector('[data-action="toggle-all"]');
    if (btnAll) {
      btnAll.hidden = !rows.length;
      btnAll.textContent = rows.some((r) => isExpanded(r.store)) ? "Hide all details" : "Show all details";
    }

    sortSelect.value = sortMode;
    // "Custom" is only meaningful once an arrangement exists for this market.
    const hasCustom = !!(selectedMarket && customOrder[selectedMarket]?.length);
    sortSelect.querySelector('option[value="custom"]').disabled = !hasCustom;
    btnResetOrder.hidden = !hasCustom;

    if (!rows.length) {
      wrap.innerHTML = `<p class="vizpick-empty">${
        activeTab === "today"
          ? "Use “Load today's data” above to capture the current business day."
          : "Click Refresh to capture VizPick store data."
      }</p>`;
      return;
    }

    wrap.innerHTML = sortRows(rows).map((r) => storeCardHtml(r)).join("");
  }

  // Per-department breakdown, worst Pick % first — the point of the panel is
  // "which department is dragging this store down", so the answer must be the
  // top row, not something to scan for.
  //
  // CURRENT DAY ONLY. The Yesterday capture is the "Download Summary by Store"
  // crosstab, which has no department dimension at all — so day tabs say so
  // rather than rendering an empty table that looks like missing data.
  function deptBreakdownHtml(r) {
    if (!r.isToday && !r.dayDetail) {
      return `<p class="vizpick-dept-none">No current-day capture was kept for this store on this day, and the daily summary export has no department detail.</p>`;
    }
    const depts = Array.isArray(r.depts) ? r.depts : [];
    // A kept day with location detail but no department breakout still has its
    // associates to show, so it keeps the tabs.
    const keptAssociatesOnly = !!r.dayDetail && Array.isArray(r.locations?.gaps);
    if (!depts.length && !keptAssociatesOnly) {
      return `<p class="vizpick-dept-none">No department detail captured for this store.</p>`;
    }

    // Sort on the ratio we hold, not on Tableau's rounded Pick %: two
    // departments both displaying 50% can be 1/2 and 97/194, and only the
    // second is worth walking to. Departments with nothing suggested have no
    // pick ratio to rank at all, so they sort after everything that does
    // rather than being dropped — their cases numbers still matter.
    const rank = (d) => (d.suggestedPicks > 0 ? d.suggestedPicksCompleted / d.suggestedPicks : Infinity);
    const sorted = [...depts].sort((a, b) => rank(a) - rank(b) || Number(a.dept) - Number(b.dept));

    const omitted = Math.max(0, (r.deptCount ?? depts.length) - depts.length);
    const rows = sorted.map((d) => {
      const pick = d.suggestedPicks > 0
        ? `<span class="vizpick-ratio">${escapeHtml(ratio(d.suggestedPicksCompleted, d.suggestedPicks))}</span>
           <strong class="${pctClass(d.pickPct, GOALS.pickPct)}">${escapeHtml(fmtPct(d.pickPct))}</strong>`
        : `<span class="vizpick-dept-na" title="No suggested picks in this department today">—</span>`;
      const cases = d.casesExpected > 0
        ? `<span class="vizpick-ratio">${escapeHtml(ratio(d.casesSeen, d.casesExpected))}</span>
           <strong class="${pctClass(d.casesSeenPct, GOALS.casesSeenPct)}">${escapeHtml(fmtPct(d.casesSeenPct))}</strong>`
        : `<span class="vizpick-dept-na" title="No cases expected in this department today">—</span>`;
      return `
        <tr>
          <td class="vizpick-dept-num">${escapeHtml(d.dept)}</td>
          <td class="vizpick-dept-cell">${pick}</td>
          <td class="vizpick-dept-cell">${cases}</td>
        </tr>`;
    }).join("");

    const store = String(r.store);
    const pane = detailPane(store);
    const assoc = associatesHtml(r);
    return `
      <div class="vizpick-dept-wrap">
        <div class="vizpick-detail-tabs" role="tablist" aria-label="Store detail">
          <button class="vizpick-detail-tab${pane === "dept" ? " is-active" : ""}"
                  role="tab" aria-selected="${pane === "dept"}"
                  data-detail-tab="dept" data-detail-store="${escapeHtml(store)}">Department</button>
          <button class="vizpick-detail-tab${pane === "assoc" ? " is-active" : ""}"
                  role="tab" aria-selected="${pane === "assoc"}"
                  data-detail-tab="assoc" data-detail-store="${escapeHtml(store)}">Associates</button>
          ${omitted && pane === "dept"
            ? `<span class="vizpick-dept-omitted" title="Departments with no suggested picks and no expected cases today">${omitted} idle hidden</span>`
            : ""}
        </div>
        ${dayDetailNote(r)}
        ${pane === "assoc" ? assoc : !depts.length ? `<p class="vizpick-dept-none">No department detail was kept for this day.</p>` : `
        <table class="vizpick-dept-table">
          <thead><tr><th>Dept</th><th>Picks</th><th>Cases Seen</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`}
      </div>`;
  }

  /**
   * Associates leaving suggested picks behind, worst first.
   *
   * The attribution is an INFERENCE, not something the pick system records:
   * suggested picks are assigned to locations at 9am (Tableau's own Metric
   * Definitions sheet), never to people, and `win` is whoever last scanned the
   * bin. On a floor where scanning a bin means picking it that holds up, but
   * the scan time is shown for every bin so it can be checked rather than
   * taken on trust — a late-evening scan is exactly the case where the
   * inference breaks, and it should be visible on the row.
   *
   * Bins nobody scanned are listed separately. They are work not started, a
   * different problem from work left behind, and folding them into a person
   * would put someone at the top of this list for something they never touched.
   */
  /**
   * The associates a store card shows: worst-first, capped at TOP_ASSOCIATES.
   *
   * Shared by the renderer and the title resolver on purpose — if those two
   * disagreed we would look up titles for people who are never displayed, or
   * display people whose titles were never requested.
   */
  function topAssociatesFor(r) {
    const gaps = r?.locations?.gaps;
    if (!Array.isArray(gaps) || !gaps.length) return { shown: [], hidden: 0, unattributed: [], unattributedSkipped: 0 };
    const { associates, unattributed, unattributedSkipped } = rollUpSkippedByAssociate(gaps);
    return {
      shown: associates.slice(0, TOP_ASSOCIATES),
      hidden: Math.max(0, associates.length - TOP_ASSOCIATES),
      unattributed, unattributedSkipped,
    };
  }

  /**
   * Why some rows are a WIN and not a name.
   *
   * A bare id is the correct thing to render — better an id than a confidently
   * wrong name on a list about who is not doing their picks — but rendering it
   * silently made the view look broken. The three causes need different
   * actions from the user, so name the one that applies:
   *
   *   transient   → Workvivo could not be reached (no tab, session expired,
   *                 executeScript refused). Retrying works; opening Workvivo
   *                 and signing in works better.
   *   cachedMiss  → we failed on these WINs within the last hour and are
   *                 backing off (MISS_TTL_MS in shared/associateDirectory.js).
   *                 Nothing to do but wait, or clear the directory.
   *   definitive  → Workvivo has no unique match. Contractors, brand-new
   *                 hires, and anyone whose profile is not searchable land
   *                 here, and no amount of retrying will help.
   */
  function nameResolveNote(shown) {
    const bare = shown.filter((a) => a.win && !hasName(dirGet(a.win))).length;
    if (!bare) return "";
    const d = nameResolve;
    if (!d) return "";
    if (d.transient || d.threw) {
      return `⚠ ${bare} shown as ID — Workvivo could not be reached` +
             `${d.lastError ? ` (${escapeHtml(d.lastError)})` : ""}. ` +
             `Open Workvivo in a tab and refresh to resolve names.`;
    }
    if (d.cachedMiss && !d.attempts) {
      return `⚠ ${bare} shown as ID — a lookup for these failed within the last hour, ` +
             `so it is backing off before trying again.`;
    }
    if (d.definitiveMiss) {
      return `${bare} shown as ID — Workvivo has no unique match for them.`;
    }
    return "";
  }

  function associatesHtml(r) {
    if (!r.isToday && !r.dayDetail) {
      return `<p class="vizpick-dept-none">No current-day capture was kept for this store on this day, and the daily summary export has no per-location data.</p>`;
    }
    const gaps = r.locations?.gaps;
    if (r.locationsWithheld) {
      return `<p class="vizpick-dept-none">⚠ Location detail for this store was identical to store ${escapeHtml(String(r.locationsWithheld.store))}'s — a capture landed on the wrong store, so the associate list has been withheld for both. Refresh to re-capture.</p>`;
    }
    if (!Array.isArray(gaps)) {
      return `<p class="vizpick-dept-none">No location detail captured for this store.</p>`;
    }
    if (!gaps.length) {
      return `<p class="vizpick-dept-none">No suggested picks outstanding — every located pick was pulled.</p>`;
    }

    const { shown, hidden, unattributed, unattributedSkipped } = topAssociatesFor(r);
    const store = String(r.store);
    const idsNote = nameResolveNote(shown);

    const rowsHtml = shown.map((a) => {
      const who = dirGet(a.win) || null;
      const open = isAssocOpen(store, a.win);
      const label = who?.name ? escapeHtml(who.name) : escapeHtml(a.win);
      const title = who?.title ? `<span class="vizpick-assoc-title">${escapeHtml(who.title)}</span>` : "";
      // Digital Metrics' roster first (home store); otherwise the Workday job
      // title, which refreshTitles() fetches for every store on screen.
      const digitalSrc = who?.name && isDigital(store, who.name) ? "roster"
        : who?.title && isDigitalJob(who.title) ? "title" : null;
      const digital = digitalSrc
        ? `<span class="vizpick-assoc-digital" title="${digitalSrc === "roster" ? "Digital associate (Digital Metrics classification)" : `Digital associate (Workday title: ${escapeHtml(who.title)})`}">D</span>`
        : "";
      // Bin rows sit UNDER the associate they belong to and carry their own
      // inline labels. They deliberately do not reuse the table header: the
      // header describes associates, and a bin's "3 of 5" landing under a
      // column headed "Last scan" is how the first version read — the numbers
      // were right and the alignment made them look wrong.
      const bins = a.bins.map((b) => `
        <tr class="vizpick-assoc-bin">
          <td class="vizpick-assoc-bin-id">${escapeHtml(b.location)}</td>
          <td class="vizpick-assoc-bin-meta">
            <span class="vizpick-assoc-bin-left">${escapeHtml(String(b.skipped))} of ${escapeHtml(String(b.picksSeen))} left</span>
            <span class="vizpick-assoc-when" title="${escapeHtml(b.lastSeenAt || "no scan recorded")}">${escapeHtml(shortWhen(b.lastSeenAt))}</span>
          </td>
        </tr>`).join("");
      return `
        <tbody class="vizpick-assoc-group">
          <tr class="vizpick-assoc-row">
            <td colspan="2">
              <button class="vizpick-assoc-toggle" data-assoc-win="${escapeHtml(a.win)}"
                      data-assoc-store="${escapeHtml(store)}" aria-expanded="${open}">
                <span class="vizpick-assoc-caret">${open ? "▾" : "▸"}</span>
                ${digital}<span class="vizpick-assoc-name">${label}</span>
                ${title}
                <span class="vizpick-assoc-count">${a.skipped} left · ${a.bins.length} bin${a.bins.length === 1 ? "" : "s"}</span>
              </button>
            </td>
          </tr>
          ${open ? bins : ""}
        </tbody>`;
    }).join("");

    const more = hidden
      ? `<p class="vizpick-dept-none">${hidden} more associate${hidden === 1 ? "" : "s"} with fewer picks left, not shown.</p>`
      : "";
    const orphan = unattributed.length
      ? `<p class="vizpick-dept-none">${unattributedSkipped} pick${unattributedSkipped === 1 ? "" : "s"} in ${unattributed.length} bin${unattributed.length === 1 ? "" : "s"} nobody scanned — not started, rather than left behind.</p>`
      : "";

    return `
      <table class="vizpick-dept-table vizpick-assoc-table">
        <thead><tr><th>Associate</th><th>Picks left</th></tr></thead>
        ${rowsHtml}
      </table>
      ${idsNote ? `<p class="vizpick-dept-none">${idsNote}</p>` : ""}
      ${more}
      ${orphan}`;
  }

  /** "8/22/2026 6:12:55 AM" -> "6:12 AM". Full value stays in the title. */
  function shortWhen(ts) {
    if (!ts) return "—";
    const m = String(ts).match(/(\d{1,2}:\d{2})(?::\d{2})?\s*(AM|PM)?/i);
    return m ? `${m[1]}${m[2] ? " " + m[2].toUpperCase() : ""}` : String(ts);
  }

  // ── Print / Email one card ────────────────────────────────────────────
  //
  // Both go through lib/card_report.js, which is pure. The only things that
  // live here are the two browser calls that cannot be: opening a window and
  // handing a mailto: to the OS.

  /**
   * Provenance for the report. Prefers the ROW's own capture time over the
   * snapshot's: metricshot can refresh a single store on its own schedule
   * (see vizpick/lib/ensure_today_store.js), so the snapshot-level stamp may
   * be older than the row in front of you. A printed page that outlives the
   * screen has to say which moment it is describing.
   */
  function cardMeta(r) {
    const snap = activeSnapshot();
    return {
      // The row's own stamp on Today — stores update at different times.
      sourceUpdate: activeTab === "today" ? rowSourceUpdate(r, snap) : (snap?.sourceUpdate ?? null),
      capturedAt: r?.capturedAt ?? snap?.capturedAt ?? null,
      isToday: activeTab === "today",
      detailAsOf: r?.dayDetail ? (r.dayDetail.sourceUpdate?.iso || r.dayDetail.capturedAt || null) : null,
      market: r?.market ?? selectedMarket ?? null,
    };
  }

  /**
   * The "Updated" line on a Today card: this store's own Tableau stamp. Time
   * only when the stamp is today, else day + time. The stamp is when Tableau
   * published this store's numbers; the tooltip adds when the row was read
   * (and last confirmed unchanged), which is a different moment.
   */
  function cardStampHtml(r) {
    if (activeTab !== "today") return "";
    const su = rowSourceUpdate(r, state?.today);
    const now = Date.now();
    if (su?.iso) {
      const d = new Date(su.iso);
      const sameDay = d.toDateString() === new Date(now).toDateString();
      const time = su.hasTime ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "";
      const text = sameDay && time ? time
        : `${d.toLocaleDateString(undefined, { weekday: "short", month: "numeric", day: "numeric" })}${time ? ` ${time}` : ""}`;
      const read = r?.capturedAt ? ` Read ${humanAge(now - new Date(r.capturedAt).getTime())} ago` : "";
      const confirmed = r?.confirmedAt ? `, still current ${humanAge(now - new Date(r.confirmedAt).getTime())} ago` : "";
      const title = `Tableau last updated store ${r.store} ${d.toLocaleString()} (${humanAge(now - d.getTime())} ago).${read}${confirmed}${read ? "." : ""} Stores update at different times.`;
      return `<div class="vizpick-store-card-stamp" title="${escapeHtml(title)}">Updated ${escapeHtml(text)}</div>`;
    }
    if (r?.capturedAt) {
      const age = humanAge(now - new Date(r.capturedAt).getTime());
      return `<div class="vizpick-store-card-stamp" title="Tableau's Updated stamp could not be read for store ${escapeHtml(r.store)}. Read ${escapeHtml(age)} ago.">Read ${escapeHtml(age)} ago</div>`;
    }
    return "";
  }

  // How long a report will wait for names before printing what it has.
  //
  // Not a performance tweak — a correctness one. refreshDirectory() ultimately
  // awaits chrome.scripting.executeScript into a Workvivo tab, and the function
  // it injects does a plain fetch with no timeout of its own. One stalled
  // request and that promise never settles, so the print window sat on
  // "Preparing the report…" indefinitely. A report is a user-initiated action;
  // it must ALWAYS produce a page. Unresolved names print as WINs, which is the
  // documented fallback anyway.
  const REPORT_NAME_WAIT_MS = 6_000;

  /** Resolve with the promise's value, or with `fallback` once ms elapse. */
  function withDeadline(promise, ms, fallback = null) {
    return Promise.race([
      Promise.resolve(promise).catch(() => fallback),
      new Promise((res) => setTimeout(() => res(fallback), ms)),
    ]);
  }

  /**
   * WIN → display name, for the report builders.
   *
   * They cannot resolve names themselves: the location export carries only a
   * WIN, and the name lives in this view's `directory`, filled asynchronously
   * by refreshDirectory(). Handing them the row alone is exactly why the first
   * printouts were a column of ids.
   */
  function nameResolver() {
    return (win) => dirGet(win)?.name ?? null;
  }

  /**
   * @param {Window|null} w  Pre-opened window. MUST be opened synchronously by
   *   the click handler: this function awaits name resolution before it can
   *   build the page, and a window.open() after an await has lost the user
   *   gesture and gets blocked as a popup.
   */
  async function printCard(r, kind, w) {
    if (!w) {
      renderTodayBar(null, "Print window was blocked — allow pop-ups for this extension, then try again.");
      return;
    }
    try {
      // Resolve names BEFORE building the page. A print fired within a second
      // of the card appearing would otherwise catch the directory mid-flight
      // and commit the ids to paper, where — unlike the screen — they never
      // repaint. Cheap when everything is already known: refreshDirectory()
      // returns immediately once every shown WIN has a name. The pick list
      // carries no names, so it never waits.
      if (kind !== "picklist") {
        const changed = await withDeadline(refreshDirectory(), REPORT_NAME_WAIT_MS);
        if (changed) render();
      }
      const meta = cardMeta(r);
      const html = kind === "picklist"
        ? buildPickListHtml(r, meta)
        : buildPerformanceHtml(r, meta, { names: nameResolver() });
      // open() resets the stream. The placeholder was written without a
      // close(), so the document is still open and a bare write() would
      // APPEND the report to "Preparing…" rather than replace it.
      w.document.open();
      w.document.write(html);
      w.document.close();
      // Print from HERE, not from a script inside the page. That window
      // inherits this extension page's CSP (MV3 default: script-src 'self'),
      // so an inline <script> in the report is blocked and the dialog never
      // opens — which is how printing "worked" while producing nothing. The
      // short delay lets the gauges lay out before the print snapshot.
      setTimeout(() => { try { w.focus(); w.print(); } catch { /* user closed it */ } }, 350);
      log.emit("card_printed", { store: String(r?.store ?? ""), tab: activeTab, kind });
    } catch (e) {
      // Never leave the placeholder window sitting there saying "Preparing".
      try { w.close(); } catch { /* already gone */ }
      renderTodayBar(null, `Could not build the printout: ${e?.message ?? e}`);
    }
  }

  /** Placeholder for the window opened before its contents exist. */
  const PRINT_PLACEHOLDER =
    `<!doctype html><meta charset="utf-8"><title>Preparing…</title>` +
    `<body style="font:14px -apple-system,'Segoe UI',sans-serif;color:#555;margin:2rem">` +
    `Preparing the report…</body>`;

  async function emailCard(r) {
    if (await withDeadline(refreshDirectory(), REPORT_NAME_WAIT_MS)) render();
    const { subject, body, truncated } = buildCardEmail(r, cardMeta(r), { names: nameResolver() });
    // Opens the user's mail client with a DRAFT. Nothing is sent from here —
    // the recipient list and the send are theirs.
    window.open(
      `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`,
      "_self",
    );
    log.emit("card_emailed", { store: String(r?.store ?? ""), tab: activeTab, truncated });
  }

  function storeCardHtml(r) {
    // `ratio` is a REAL numerator/denominator pair from the export — never a
    // figure derived by dividing a rounded percentage. See the note at the top
    // of lib/parse_vizpick_stores_csv.js.

    // The composite is judged on the same scale as the rings around it: it is
    // the mean attainment against those very goals, so 100 is "every component
    // at or above target". See the note on GOALS.vizpick.
    const gauge = Number.isFinite(r.vizpick)
      ? gaugeSvg(r.vizpick, {
          // No caption under this one — the store number already labels the
          // card — but the tooltip still names it.
          size: 96, thickness: 10, label: "", title: "VizPick Health",
          goal: GOALS.vizpick,
          fmt: (v) => Math.round(v).toString(),
        })
      : `<div class="vizpick-card-nohealth" title="No VizPick composite score for this store">—</div>`;

    // The four goal metrics as small rings beside the composite, mirroring the
    // VizPick dashboard's own layout.
    //
    // Cases and Picks carry their raw numerator/denominator directly under the
    // ring. Only those two have one — the export publishes Cases Seen / Cases
    // Expected and Suggested Picks Completed / Suggested Picks, but nothing
    // behind Location % or Overstock %. These are REAL pairs from the export,
    // never a percentage divided back out; see the note at the top of
    // lib/parse_vizpick_stores_csv.js for why that distinction matters.
    const rings = [
      { label: "Cases Seen", value: r.casesSeenPct, goal: GOALS.casesSeenPct, ratio: ratio(r.casesSeen, r.casesExpected) },
      { label: "Locations", value: r.locationPct,  goal: GOALS.locationPct },
      { label: "Picks",     value: r.pickPct,      goal: GOALS.pickPct,      ratio: ratio(r.picksCompleted, r.picksSuggested) },
      { label: "Overstock", value: r.overstockPct, goal: GOALS.overstockPct },
    ];
    const ringsHtml = rings
      .map((g) => {
        const sub = g.ratio ? `<div class="vizpick-gauge-ratio">${escapeHtml(g.ratio)}</div>` : "";
        return Number.isFinite(g.value)
          ? `<div class="vizpick-gauge-cell">${gaugeSvg(g.value, {
               size: 62, thickness: 8, goal: g.goal, label: g.label,
               fmt: (v) => `${Math.round(v)}%`,
             })}${sub}</div>`
          : `<div class="vizpick-gauge-cell">
               <div class="vizpick-gauge">
                 <div class="vizpick-minigauge-na">—</div>
                 <div class="vizpick-gauge-label">${escapeHtml(g.label)}</div>
               </div>${sub}
             </div>`;
      })
      .join("");

    // Rows that are NOT already answered by a ring above. Cases and Picks now
    // carry their own numbers under their rings, and Locations/Overstock have
    // no ratio to show, so repeating all four here was pure duplication.
    // Pallets % has no ring of its own, so this is its only home.
    //
    // `Total Picked` is deliberately absent. It counts a wider set of picks
    // than Pick % does — the VizPickDetails Picks-ring hover itemises "Pick
    // Anyway", "Clearance" and "Modular Deleted" picks alongside the On Hand
    // picks Pick % is computed from — so the two sat adjacent showing 173/568
    // and 278 and read as a contradiction. Dropped on the analyst's call
    // 2026-08-20: completed / suggested is the number that matters. The field
    // stays in the parsed model; it simply has no row. Do not re-add one
    // without a definition — see CURRENT_TASKS.md.
    const metrics = [
      // No published goal for Pallets %, so it is shown but never judged.
      { label: "Pallets %", value: r.palletsPct, goal: null, fmt: fmtPct, ratio: ratio(r.palletsSeen, r.palletsExpected) },
    ];

    const metricsHtml = metrics
      .filter((m) => Number.isFinite(m.value) || m.ratio)
      .map((m) => `
        <div class="vizpick-store-card-metric">
          <span class="vizpick-store-card-metric-label"${m.labelTitle ? ` title="${escapeHtml(m.labelTitle)}"` : ""}>${escapeHtml(m.label)}</span>
          <span class="vizpick-store-card-metric-value">
            ${m.ratio ? `<span class="vizpick-ratio"${m.ratioTitle ? ` title="${escapeHtml(m.ratioTitle)}"` : ""}>${escapeHtml(m.ratio)}</span>` : ""}
            <strong class="${m.goal != null ? pctClass(m.value, m.goal) : ""}"
                    title="${m.goal != null ? `Goal ${m.goal}%` : ""}">${escapeHtml(m.fmt(m.value))}</strong>
          </span>
        </div>`)
      .join("");

    const deptsHtml = deptBreakdownHtml(r);

    const sub = `${escapeHtml(r.bu ?? "")}${r.bu ? " · " : ""}${r.region != null && r.region !== "" ? `Region ${escapeHtml(r.region)}` : ""}`;
    const open = isExpanded(r.store);
    const isHome = isHomeStore(r.store);

    // Store number leads at the top LEFT, with the overall score ring to its
    // right. Only the graphs show by default — the numeric rows are behind a
    // per-card toggle, so a market reads as a wall of rings at a glance.
    return `
      <article class="vizpick-store-card${isHome ? " is-home" : ""}" data-store="${escapeHtml(r.store)}" draggable="true"
               aria-label="Store ${escapeHtml(r.store)}${isHome ? " — your store" : ""} — drag to rearrange">
        <header class="vizpick-store-card-summary">
          <div class="vizpick-store-card-id">
            <div class="vizpick-store-card-num">#${escapeHtml(r.store)}</div>
            <div class="vizpick-store-card-sub">${
              isHome ? `<span class="vizpick-home-chip" title="Your home store, from Settings > Defaults">yours</span>` : ""
            }${sub}</div>
            ${cardStampHtml(r)}
          </div>
          <div class="vizpick-store-card-gauge">${gauge}</div>
          <div class="vizpick-card-actions">
            <button class="vizpick-card-action" data-card-print="${escapeHtml(r.store)}"
                    title="Print performance — what is below goal, and whose picks are being left"
                    aria-label="Print performance report for store ${escapeHtml(r.store)}">🖨</button>
            <button class="vizpick-card-action" data-card-picklist="${escapeHtml(r.store)}"
                    title="Print pick list — the bins that still need pulling, in walk order"
                    aria-label="Print pick list for store ${escapeHtml(r.store)}">📋</button>
            <button class="vizpick-card-action" data-card-email="${escapeHtml(r.store)}"
                    title="Email this card as a summary"
                    aria-label="Email store ${escapeHtml(r.store)}">✉</button>
          </div>
          <span class="vizpick-store-card-grip" aria-hidden="true" title="Drag to rearrange">⠿</span>
        </header>
        <div class="vizpick-store-card-rings">${ringsHtml}</div>
        <button class="vizpick-card-toggle" data-toggle-store="${escapeHtml(r.store)}"
                aria-expanded="${open}">${open ? "Hide details" : "Show details"}</button>
        <div class="vizpick-store-card-details"${open ? "" : " hidden"}>${metricsHtml}${deptsHtml}</div>
      </article>`;
  }

  function paintDebug() {
    const section = container.querySelector("[data-debug-section]");
    const body    = container.querySelector("[data-debug-body]");
    if (!section || !body) return;
    const dbg = activeTab === "today" ? state?.debugToday : state?.debug;
    // An ok run that still lost stores has something to show: the per-store
    // reasons. Without this the Today bar pointed at "the capture details
    // below" and the section was empty.
    const lostStores = !!dbg?.ok && (dbg.debug?.failures || []).some((f) => !f.soft);
    const clean = !dbg || (dbg.ok && !lostStores);

    // Always reachable, even with nothing wrong on record. The failure that
    // most needs diagnosing is a capture that does nothing and stores no
    // error — which, when this section only appeared on error, left no way to
    // get at the state at all.
    section.hidden = false;
    body.innerHTML = clean ? "" : renderDebug(dbg);

    const heading = section.querySelector(".vizpick-section-heading");
    if (heading) heading.textContent = clean ? "Diagnostics" : "Last capture details";
    const dismiss = section.querySelector('[data-action="dismiss-error"]');
    if (dismiss) dismiss.hidden = clean;
  }

  async function dismissError() {
    try { await host.messaging.send("dismiss_error", { sourceId: activeTab === "today" ? "today" : "stores" }); }
    catch (e) { console.warn("[vizpick] dismiss_error failed:", e?.message ?? e); }
    await paint();
  }

  function renderDebug(dbg) {
    const parts = [];

    // When did this happen, and did the CURRENT build produce it? A stored
    // envelope survives an extension reload, so without this an error from
    // hours ago reads as if the module just failed.
    const age = dbg.capturedAt ? Date.now() - new Date(dbg.capturedAt).getTime() : null;
    const stale = age == null || age > 5 * 60_000;
    const fromOldBuild = state?.captureBuild && dbg.build && dbg.build !== state.captureBuild;
    const noBuild = !dbg.build;
    if (stale || fromOldBuild || noBuild) {
      parts.push(
        `<p class="vizpick-debug-stale"><strong>This is a saved result from an earlier capture` +
        (dbg.capturedAt ? ` (${humanAge(age)} ago)` : "") +
        `, not something that just happened.</strong>` +
        ((fromOldBuild || noBuild)
          ? ` It was written by an older build of the extension, so its wording may not match the current code.`
          : "") +
        ` Dismiss it, or click Refresh to run a fresh capture.</p>`
      );
    }

    if (dbg.errorClass) parts.push(`<code>${escapeHtml(dbg.errorClass)}</code>`);
    if (dbg.error) parts.push(`<br><span class="vizpick-debug-error">${escapeHtml(String(dbg.error))}</span>`);
    const fix = FIXES[dbg.errorClass];
    if (fix) parts.push(`<p class="vizpick-debug-fix"><strong>What to do:</strong> ${escapeHtml(fix)}</p>`);
    // Per-store reasons in plain sight — an ok run that lost stores has no
    // errorClass, and the reasons used to be reachable only inside the JSON.
    const perStore = (dbg.debug?.failures || []).filter((f) => !f.soft);
    if (perStore.length) {
      parts.push(`<p class="vizpick-debug-fix"><strong>Stores this run could not read</strong> (they keep their previous numbers):</p><ul>` +
        perStore.map((f) => `<li><strong>${escapeHtml(String(f.store))}</strong> — ${escapeHtml(String(f.reason))}</li>`).join("") + `</ul>`);
    }
    if (dbg.debug) {
      parts.push(`<details><summary>Capture debug</summary><pre>${escapeHtml(JSON.stringify(dbg.debug, null, 2))}</pre></details>`);
    }
    return parts.join("");
  }

  // ── UI preference persistence ──────────────────────────────
  // Read/written straight from the view: this is presentation state, not
  // captured data, so it does not belong in the service's snapshot store.
  async function loadUiPrefs() {
    try {
      const got = await chrome.storage.local.get(UI_PREFS_KEY);
      const p = got[UI_PREFS_KEY];
      if (!p || p.v !== 2) return;
      if (typeof p.sortMode === "string" && (SORTS[p.sortMode] || p.sortMode === "custom")) sortMode = p.sortMode;
      if (p.customOrder && typeof p.customOrder === "object") customOrder = p.customOrder;
      if (p.expanded && typeof p.expanded === "object") expanded = p.expanded;
      if (p.detailPanes && typeof p.detailPanes === "object") detailPanes = p.detailPanes;
      if (p.assocOpen && typeof p.assocOpen === "object") assocOpen = p.assocOpen;
      // Which market and tab were on screen last time. Without these the view
      // reset to markets[0] on every mount — and since todayRows() inner-joins
      // the stored Today rows against the SELECTED market's roster, landing on
      // the wrong market rendered an empty Today tab. The data was in storage
      // the whole time; the view was looking at a different market.
      if (typeof p.selectedMarket === "string" && p.selectedMarket) selectedMarket = p.selectedMarket;
      // Restored as a user pick, because that is what it was. Keeps
      // onUserMarketChange from yanking the view off it later.
      if (p.marketIsUserSet === true && selectedMarket) marketIsUserSet = true;
      // Validated in paintTabs() against the tabs that actually exist, so a
      // stored "day:2026-08-13" that has since aged out just falls back.
      if (typeof p.activeTab === "string" && p.activeTab) activeTab = p.activeTab;
    } catch { /* prefs are best-effort */ }
  }

  async function saveUiPrefs() {
    try {
      await chrome.storage.local.set({
        [UI_PREFS_KEY]: {
          v: 2, sortMode, customOrder, expanded, selectedMarket, marketIsUserSet, activeTab,
          detailPanes, assocOpen,
        },
      });
    } catch { /* best-effort */ }
  }

  // Apply the active sort. "custom" falls back to store order for any store
  // the saved arrangement doesn't mention (e.g. a store added since), which
  // keeps a stale arrangement from hiding or duplicating cards.
  function sortRows(rows) {
    const list = [...rows];
    if (sortMode === "custom") {
      const order = customOrder[selectedMarket];
      if (Array.isArray(order) && order.length) {
        const rank = new Map(order.map((sNum, i) => [sNum, i]));
        return list.sort((a, b) => {
          const ra = rank.has(a.store) ? rank.get(a.store) : Number.MAX_SAFE_INTEGER;
          const rb = rank.has(b.store) ? rank.get(b.store) : Number.MAX_SAFE_INTEGER;
          return ra - rb || storeNum(a) - storeNum(b);
        });
      }
      return list.sort(SORTS[DEFAULT_SORT].cmp);
    }
    return list.sort((SORTS[sortMode] || SORTS[DEFAULT_SORT]).cmp);
  }

  // ── Formatting helpers ─────────────────────────────────
  function fmtPct(n) { return Number.isFinite(n) ? `${Math.round(n)}%` : "—"; }
  function fmtInt(n) { return Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "—"; }

  // "x / y" from two real measures. Returns null unless both are finite and
  // the denominator is non-zero, so a missing column renders nothing rather
  // than "0 / 0" or "NaN".
  function ratio(num, den) {
    if (!Number.isFinite(num) || !Number.isFinite(den)) return null;
    if (den <= 0) return null;
    return `${Math.round(num).toLocaleString("en-US")} / ${Math.round(den).toLocaleString("en-US")}`;
  }

  // Colour band for a percentage, shared with the gauge rings
  // (lib/charts.js::bandFor) so text and rings can never disagree.
  function pctClass(value, goal) {
    return bandFor(value, goal)?.cls ?? "";
  }

  function renderFreshness(f) {
    if (!f) return { text: "no capture yet", state: "" };
    if (f.inFlight) return { text: "refreshing…", state: "pending" };
    if (f.lastError) return { text: "error — see below", state: "error" };
    if (f.lastSuccess) {
      const age = Date.now() - new Date(f.lastSuccess).getTime();
      return { text: `captured ${humanAge(age)} ago`, state: f.isStale ? "stale" : "ok" };
    }
    return { text: "no capture yet", state: "" };
  }

  function humanAge(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h}h`;
    return `${Math.round(h / 24)}d`;
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // 7b. Home store pick progression — every kept Tableau update for the user's
  // own store (lib/home_history.js), opened from the header's "Pick
  // progression" button into a <dialog>. Built to answer two questions: do
  // picks keep being added after the stocking team leaves, and is the late
  // scanner the Associates view blames the one who left the work behind.
  //
  // Nothing here runs until the dialog is opened: resolving names and pulling
  // the schedule are network work nobody asked for on a plain visit.
  const histDialog = container.querySelector("[data-hist-dialog]");
  const histEl = container.querySelector("[data-home-history]");
  let histDay = null;
  let histCutoff = "15:00";     // when the stocking team is gone
  let histData = null;
  let histTimer = null;
  let histBusy = false;
  // Which view of the dialog is showing, and the Bin-by-bin filters. The
  // business case opens first: it is what the dialog is now mostly for.
  let histView = "case";
  let histLedgerQuery = "";
  let histLedgerFilter = "all";
  let histCaseText = "";          // plain-text summary for "Copy summary"
  let histFileNote = "";          // result of the last Save / Load history file
  let histOtherOpen = false;      // Business case: "Other jobs" broken out by job title
  let histCaseModel = null;       // what the Business case shows, for the PDF (lib/case_report.js)
  // WIN → directory record ({ name, title }). Shared across days.
  const histPeople = new Map();
  // day → schedule index (lib/home_history.js::indexSchedule), or null when
  // Digital Metrics has no schedule for that day / is not signed in.
  const histSchedules = new Map();

  const histOpen = () => !!histDialog?.open;
  const minutesOfDay = (s) => {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.getHours() * 60 + d.getMinutes();
  };
  const cutoffMin = () => {
    const [h, m] = histCutoff.split(":").map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const clock = (s) => {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? (s || "—") : d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  };
  const signed = (n) => (n > 0 ? `+${n}` : String(n));
  // Tableau's current-day view runs 1-2 h behind, so an update is placed by
  // the time Tableau says the data is FROM, not when we happened to capture
  // it — a 3:45 PM capture of 2:03 PM data is not "after the cutoff".
  const dataTime = (e) => e.sourceIso || e.capturedAt;

  /** { name, job, shiftStart, shiftEnd } for a WIN — whatever is known. */
  function histPerson(win) {
    if (!win) return null;
    const rec = histPeople.get(normalizeWin(win)) || histPeople.get(win) || null;
    const name = rec?.name || null;
    const sched = matchPerson(histSchedules.get(histDay), name, canonicalName);
    return {
      name,
      // The schedule's job is the one worked that day; the directory title
      // (Workday) is a fallback for someone not on the schedule.
      job: sched?.job || rec?.title || null,
      jobSource: sched?.job ? "schedule" : rec?.title ? "workday" : null,
      shiftStart: sched?.shiftStart || null,
      shiftEnd: sched?.shiftEnd || null,
    };
  }

  /** Bucket a job title for the summary: the two groups this report is about. */
  function jobGroup(p) {
    if (!p?.job) return p?.name ? "Not on today's schedule" : "Name not resolved";
    if (isDigitalJob(p.job)) return "Digital";
    if (/\bstocking\s*1\b/i.test(p.job)) return "Stocking 1";
    return p.job;
  }

  /** Scan outside the scanner's scheduled shift (both ends known). */
  function offShift(p, scanAt) {
    if (!p?.shiftStart || !p?.shiftEnd || !scanAt) return false;
    const t = new Date(scanAt).getTime(), s = new Date(p.shiftStart).getTime(), e = new Date(p.shiftEnd).getTime();
    if (![t, s, e].every(Number.isFinite)) return false;
    return t < s || t > e;
  }

  async function resolveHistPeople(entries) {
    const wins = new Set();
    for (const e of entries) for (const b of e.bins) if (b.win) wins.add(normalizeWin(b.win) || b.win);
    const missing = [...wins].filter((w) => !hasName(histPeople.get(w)));
    if (!missing.length) return false;
    let changed = false;
    try {
      for (const [win, rec] of await associateDirectory.getMany(missing)) { histPeople.set(win, rec); changed = true; }
      const still = missing.filter((w) => !hasName(histPeople.get(w)));
      if (still.length) {
        await lookupNames(still);
        for (const [win, rec] of await associateDirectory.getMany(still)) { histPeople.set(win, rec); changed = true; }
      }
    } catch { /* names stay as WINs; the table says so */ }
    return changed;
  }

  async function loadHistSchedule(store, day) {
    if (!store || !day || histSchedules.has(day)) return false;
    const doc = await new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ module: "digitalmetrics", type: "get_schedule", store: String(store), date: day },
          (r) => resolve(chrome.runtime.lastError || !r?.ok ? null : (r.data ?? null)));
      } catch { resolve(null); }
    });
    const idx = doc ? indexSchedule(doc, canonicalName) : null;
    histSchedules.set(day, idx?.size ? idx : null);
    return !!idx?.size;
  }

  async function loadHomeHistory() {
    if (!histOpen()) return;
    try {
      histData = await host.messaging.send("home_history", { day: histDay });
    } catch { histData = null; }
    if (histData?.day) histDay = histData.day;
    paintHomeHistory();
    const entries = histData?.entries || [];
    if (!entries.length) return;
    const [names, sched] = await Promise.all([
      resolveHistPeople(entries).catch(() => false),
      loadHistSchedule(entries[0].store, histDay).catch(() => false),
    ]);
    if ((names || sched) && histOpen()) paintHomeHistory();
  }

  const personCell = (win, scanAt, cut) => {
    if (!win) return `<td>—</td><td></td>`;
    const p = histPerson(win);
    const m = minutesOfDay(scanAt);
    const flags = [
      m != null && m >= cut ? `<span class="vizpick-hist-flag" title="Scanned after the stocking cutoff">after ${escapeHtml(histCutoff)}</span>` : "",
      offShift(p, scanAt) ? `<span class="vizpick-hist-flag is-off" title="Scan time is outside this associate's scheduled shift">off shift</span>` : "",
    ].join("");
    const shift = p?.shiftStart && p?.shiftEnd ? ` <span class="vizpick-hist-muted">(${escapeHtml(clock(p.shiftStart))}–${escapeHtml(clock(p.shiftEnd))})</span>` : "";
    return `<td>${escapeHtml(p?.name || win)}${p?.name ? ` <span class="vizpick-hist-muted">${escapeHtml(win)}</span>` : ""}${flags}</td>
      <td>${escapeHtml(p?.job || "—")}${shift}</td>`;
  };

  function paintHomeHistory() {
    if (!histEl) return;
    const entries = histData?.entries || [];
    const head = (title, extra = "") => `
      <div class="vizpick-panel-head">
        <h2>${title}</h2>
        ${extra}
        <button class="vizpick-linkbtn" data-hist-save title="Save every kept day to a file, to load into another Edge">Save history file</button>
        <button class="vizpick-linkbtn" data-hist-load title="Add days from a saved history file">Load history file</button>
        <input type="file" id="vizpick-hist-file" accept=".json,application/json" data-hist-file hidden>
        ${histFileNote ? `<span class="vizpick-hist-muted" role="status">${escapeHtml(histFileNote)}</span>` : ""}
        <button class="btn" data-hist-capture ${histBusy ? "disabled" : ""}>${histBusy ? "Capturing…" : "Capture now"}</button>
        <button class="vizpick-linkbtn vizpick-hist-close" data-hist-close aria-label="Close">Close</button>
      </div>`;

    if (!histData?.ok || !entries.length) {
      histEl.innerHTML = `${head("Home store — pick progression")}
        <p class="vizpick-hist-empty">No updates kept yet. The home store is captured every 30 minutes
        from 5 AM to 11 PM, or click <strong>Capture now</strong>.</p>`;
      return;
    }

    const cut = cutoffMin();
    const rows = historyTimeline(entries);
    const first = entries[0], last = entries[entries.length - 1];
    let addedAfter = 0, doneAfter = 0;
    for (const { entry, diff } of rows) {
      const m = minutesOfDay(dataTime(entry));
      if (diff && m != null && m >= cut) { addedAfter += diff.added; doneAfter += diff.completed; }
    }

    // Every bin still holding picks, worst first — the pick list itself.
    const openBins = last.bins.filter((b) => b.seen > b.done)
      .sort((a, b) => (b.seen - b.done) - (a.seen - a.done) || a.location.localeCompare(b.location));
    let unscannedOpen = 0;
    const byGroup = new Map();
    for (const b of openBins) {
      const open = b.seen - b.done;
      if (!b.win) { unscannedOpen += open; continue; }
      const p = histPerson(b.win);
      const g = jobGroup(p);
      const m = minutesOfDay(b.lastSeenAt);
      const cur = byGroup.get(g) || { group: g, before: 0, after: 0, bins: 0, people: new Set() };
      if (m != null && m >= cut) cur.after += open; else cur.before += open;
      cur.bins++;
      cur.people.add(b.win);
      byGroup.set(g, cur);
    }
    const groups = [...byGroup.values()].sort((a, b) => (b.before + b.after) - (a.before + a.after));

    // ── Not-yet-seen watch ────────────────────────────────────────────────
    // Hypothesis under test (analyst, 2026-09-14): suggested picks only count
    // for a bin once it has been SEEN that day, so an associate who is first
    // to scan a bin nobody touched earlier "adds" its picks to the list — and,
    // as last scanner, owns them. If so, bins not scanned today hold no picks,
    // and picks jump on the update where a bin is first scanned.
    const unseen = unseenBins(last);
    const unseenPicks = unseen.reduce((n, b) => n + b.seen, 0);
    const firsts = firstSeenEvents(entries);
    const firstPicks = firsts.reduce((n, f) => n + Math.max(0, f.dSeen), 0);
    const totalAdded = rows.reduce((n, r) => n + (r.diff?.added || 0), 0);
    const firstByLoc = new Map(firsts.map((f) => [f.location, f]));
    // Departments: first update vs latest, and what moved after the cutoff,
    // measured from the last update whose data predates it.
    const baseline = [...entries].reverse().find((e) => (minutesOfDay(dataTime(e)) ?? 0) < cut && e.depts?.length) || null;
    const bl = baseline && baseline !== last ? baseline : null;
    const deptRows = diffDepts(entries.find((e) => e.depts?.length) || first, last).map((d) => {
      const b = bl ? bl.depts.find((x) => x.dept === d.dept) : null;
      return {
        ...d,
        addedAfter: bl ? d.suggested - (b?.suggested || 0) : null,
        casesAfter: bl ? d.casesSeen - (b?.casesSeen || 0) : null,
      };
    }).sort((a, b) => (b.suggested - b.done) - (a.suggested - a.done) || String(a.dept).localeCompare(String(b.dept), undefined, { numeric: true }));

    const dayOpts = (histData.days || []).map((d) =>
      `<option value="${escapeHtml(d)}"${d === histDay ? " selected" : ""}>${escapeHtml(d)}</option>`).join("");
    const schedNote = histSchedules.has(histDay)
      ? (histSchedules.get(histDay) ? "" : ` Job titles: Digital Metrics has no schedule for ${escapeHtml(histDay)} (or is not signed in), so only Workday titles already on file are shown.`)
      : " Loading names and job titles…";

    // A long stretch of Tableau data time between two kept updates gets its own
    // row, so a missing hour reads as a gap rather than silently absent.
    const gapAt = new Map(updateGaps(entries).map((g) => [g.index, g]));
    const tl = rows.map(({ entry: e, diff: d }, i) => {
      const late = (minutesOfDay(dataTime(e)) ?? 0) >= cut;
      const binRows = (d?.bins || []).filter((b) => b.dSeen || b.dDone).map((b) => `<tr>
          <td>${escapeHtml(b.location)}${b.isNew ? " <em>new</em>" : ""}${b.gone ? " <em>gone</em>" : ""}</td>
          <td class="num">${b.dSeen ? signed(b.dSeen) : ""}</td>
          <td class="num">${b.dDone ? signed(b.dDone) : ""}</td>
          <td class="num">${Math.max(0, b.seen - b.done)}</td>
          ${personCell(b.win, b.lastSeenAt, cut)}
          <td>${escapeHtml(b.lastSeenAt ? clock(b.lastSeenAt) : "not scanned")}</td>
        </tr>`).join("");
      const gap = gapAt.get(i);
      const gapRow = gap
        ? `<tbody><tr class="vizpick-hist-muted"><td colspan="8">No update kept for Tableau data between ${escapeHtml(clock(gap.from))} and ${escapeHtml(clock(gap.to))} (${Math.floor(gap.minutes / 60)} h ${gap.minutes % 60} min).</td></tr></tbody>`
        : "";
      const stampFlag = e.stampUnverified
        ? ` <span class="vizpick-hist-flag" title="Recorded under the market crawl's Updated time before per-store stamps; this store's own stamp later showed different data at the same time.">time unverified</span>`
        : e.relabeledFrom
          ? ` <span class="vizpick-hist-flag" title="First recorded as ${escapeHtml(e.relabeledFrom)}; this store's own stamp showed the data belongs to this earlier update.">moved from ${escapeHtml(clock(e.relabeledFrom))}</span>`
          : "";
      return `${gapRow}<tbody class="${late ? "vizpick-hist-after" : ""}">
        <tr class="vizpick-hist-row" data-hist-toggle="${i}">
          <td>${escapeHtml(clock(dataTime(e)))}${stampFlag}</td>
          <td class="vizpick-hist-muted">${escapeHtml(clock(e.capturedAt))}</td>
          <td class="num">${e.totals.seen}</td>
          <td class="num">${e.totals.done}</td>
          <td class="num">${e.totals.open}</td>
          <td class="num">${d ? signed(d.added) : "—"}</td>
          <td class="num">${d ? signed(d.completed) : "—"}</td>
          <td class="num">${d && d.removed ? `-${d.removed}` : ""}</td>
        </tr>
        ${binRows ? `<tr class="vizpick-hist-bins" data-hist-bins="${i}" hidden><td colspan="8">
          <table><thead><tr><th>Location</th><th class="num">Picks added</th><th class="num">Completed</th><th class="num">Open</th><th>Last scanner</th><th>Job (shift)</th><th>Last scan</th></tr></thead>
          <tbody>${binRows}</tbody></table></td></tr>` : ""}
      </tbody>`;
    }).join("");

    const timelineHtml = `
      <p class="vizpick-hist-summary">
        ${entries.length} update${entries.length === 1 ? "" : "s"} kept, Tableau data from ${escapeHtml(clock(dataTime(first)))} to ${escapeHtml(clock(dataTime(last)))}.
        Suggested picks <strong>${first.totals.seen} → ${last.totals.seen}</strong>;
        <strong>${addedAfter}</strong> added and <strong>${doneAfter}</strong> completed after ${escapeHtml(histCutoff)}.
        <strong>${last.totals.open}</strong> open in <strong>${openBins.length}</strong> bins${unscannedOpen ? `, ${unscannedOpen} of them in bins nobody has scanned` : ""}.
        <span class="vizpick-hist-muted">${schedNote}</span>
        <br>Not scanned yet today: <strong>${unseen.length}</strong> bin${unseen.length === 1 ? "" : "s"} holding <strong>${unseenPicks}</strong> suggested picks.
        Picks that appeared on a bin's first scan of the day: <strong>${firstPicks}</strong>${totalAdded ? ` of ${totalAdded} added` : ""}
        (${firsts.length} first scan${firsts.length === 1 ? "" : "s"} caught between updates).
      </p>

      <h3 class="vizpick-hist-sub">Open picks by job of the last scanner</h3>
      <div class="vizpick-hist-scroll">
        <table class="vizpick-hist-table">
          <thead><tr><th>Job</th><th class="num">Open, scanned before ${escapeHtml(histCutoff)}</th><th class="num">Open, scanned after ${escapeHtml(histCutoff)}</th><th class="num">Bins</th><th class="num">Associates</th></tr></thead>
          <tbody>${groups.map((g) => `<tr><td>${escapeHtml(g.group)}</td><td class="num">${g.before}</td><td class="num">${g.after}</td><td class="num">${g.bins}</td><td class="num">${g.people.size}</td></tr>`).join("")}
          ${unscannedOpen ? `<tr><td>Nobody scanned the bin</td><td class="num" colspan="2">${unscannedOpen}</td><td class="num">${openBins.filter((b) => !b.win).length}</td><td></td></tr>` : ""}</tbody>
        </table>
      </div>

      <h3 class="vizpick-hist-sub">Open bins now (${openBins.length})</h3>
      <div class="vizpick-hist-scroll">
        <table class="vizpick-hist-table">
          <thead><tr><th>Location</th><th class="num">Open</th><th class="num">Seen / done</th><th>Last scanner</th><th>Job (shift)</th><th>Last scan</th></tr></thead>
          <tbody>${openBins.map((b) => `<tr>
            <td>${escapeHtml(b.location)}${firstByLoc.has(b.location) ? ` <span class="vizpick-hist-flag" title="Picks here appeared on this bin's first scan of the day">first scan</span>` : ""}</td>
            <td class="num">${b.seen - b.done}</td>
            <td class="num">${b.seen} / ${b.done}</td>
            ${personCell(b.win, b.lastSeenAt, cut)}
            <td>${escapeHtml(b.lastSeenAt ? clock(b.lastSeenAt) : "not scanned")}</td>
          </tr>`).join("")}</tbody>
        </table>
      </div>

      <h3 class="vizpick-hist-sub">First scans today — bins nobody had scanned at the previous update (${firsts.length})</h3>
      ${firsts.length ? `<div class="vizpick-hist-scroll"><table class="vizpick-hist-table">
        <thead><tr><th>Tableau data as of</th><th>Location</th><th class="num">Picks appeared</th><th class="num">Cases seen</th><th>Scanned by</th><th>Job (shift)</th><th>Scan time</th></tr></thead>
        <tbody>${firsts.map((f) => `<tr>
          <td>${escapeHtml(clock(f.dataTime))}</td>
          <td>${escapeHtml(f.location)}</td>
          <td class="num">${f.dSeen ? signed(f.dSeen) : "0"}</td>
          <td class="num">${f.dCasesSeen == null ? "—" : signed(f.dCasesSeen)}</td>
          ${personCell(f.win, f.lastSeenAt, cut)}
          <td>${escapeHtml(f.lastSeenAt ? clock(f.lastSeenAt) : "—")}</td>
        </tr>`).join("")}</tbody></table></div>`
        : `<p class="vizpick-hist-note">None caught yet. A first scan only shows when an earlier update saw the bin unscanned — captures start at 5 AM, so the first full day is the one to read.</p>`}

      <h3 class="vizpick-hist-sub">Not scanned yet today (${unseen.length})</h3>
      ${unseen.length ? `<div class="vizpick-hist-scroll"><table class="vizpick-hist-table">
        <thead><tr><th>Location</th><th>Bin group</th><th class="num">Suggested picks</th><th class="num">Cases expected</th><th>Last scanned</th></tr></thead>
        <tbody>${unseen.map((b) => `<tr>
          <td>${escapeHtml(b.location)}</td>
          <td>${escapeHtml(b.group)}</td>
          <td class="num">${b.seen}</td>
          <td class="num">${b.casesExpected ?? "—"}</td>
          <td>${escapeHtml(b.lastSeenAt ? new Date(b.lastSeenAt).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }) : "never")}</td>
        </tr>`).join("")}</tbody></table></div>`
        : `<p class="vizpick-hist-note">Every bin has been scanned today.</p>`}

      <h3 class="vizpick-hist-sub">Departments through the day</h3>
      ${deptRows.length ? `<div class="vizpick-hist-scroll"><table class="vizpick-hist-table">
        <thead><tr><th>Dept</th><th class="num">Suggested picks (first → now)</th><th class="num">Done (first → now)</th><th class="num">Cases seen / expected</th><th class="num">Picks added after ${escapeHtml(histCutoff)}</th><th class="num">Cases seen after ${escapeHtml(histCutoff)}</th></tr></thead>
        <tbody>${deptRows.map((d) => `<tr>
          <td>${escapeHtml(d.dept)}</td>
          <td class="num">${d.suggestedFirst ?? "—"} → ${d.suggested}</td>
          <td class="num">${d.doneFirst ?? "—"} → ${d.done}</td>
          <td class="num">${d.casesSeen} / ${d.casesExpected}</td>
          <td class="num">${d.addedAfter == null ? "—" : signed(d.addedAfter)}</td>
          <td class="num">${d.casesAfter == null ? "—" : signed(d.casesAfter)}</td>
        </tr>`).join("")}</tbody></table></div>`
        : `<p class="vizpick-hist-note">No department breakout kept yet — it starts with the next capture.</p>`}
      <p class="vizpick-hist-note">Bin group is the first part of a location code (the 024 in 024/002). It is not a department; the export has no department per bin.</p>

      <h3 class="vizpick-hist-sub">Updates through the day</h3>
      <div class="vizpick-hist-scroll">
        <table class="vizpick-hist-table">
          <thead><tr><th>Tableau data as of</th><th>Captured</th><th class="num">Picks seen</th><th class="num">Done</th><th class="num">Open</th><th class="num">Added</th><th class="num">Completed</th><th class="num">Removed</th></tr></thead>
          ${tl}
        </table>
      </div>
      ${histPollNote(histData?.polls || [])}
      <p class="vizpick-hist-note">Click an update to see which bins changed. Shaded rows are Tableau data from after the cutoff (the source runs 1–2 h behind the floor).
      VizPick assigns picks to locations, not people: the scanner shown is whoever scanned the bin last, so a scan after the cutoff inherits whatever was left there.
      Job and shift come from Digital Metrics' schedule for the selected day, matched by name.</p>`;

    const tabs = `<div class="vizpick-detail-tabs vizpick-hist-tabs" role="tablist" aria-label="Pick progression view">
      ${[["case", "Business case"], ["timeline", "Day timeline"], ["bins", "Bin by bin"]].map(([id, label]) =>
        `<button class="vizpick-detail-tab${histView === id ? " is-active" : ""}" role="tab" aria-selected="${histView === id}" data-hist-view="${id}">${label}</button>`).join("")}
    </div>`;
    histEl.innerHTML = `
      ${head(`Home store ${escapeHtml(last.store)} — pick progression`, `
        <label class="vizpick-hist-ctl">Day <select data-hist-day>${dayOpts}</select></label>
        <label class="vizpick-hist-ctl">Stocking leaves <input type="time" data-hist-cutoff value="${escapeHtml(histCutoff)}"></label>
        <button class="vizpick-linkbtn" data-hist-export>Export CSV</button>`)}
      ${tabs}
      ${histView === "case" ? businessCaseHtml(entries) : histView === "bins" ? ledgerShellHtml() : timelineHtml}`;
    if (histView === "bins") paintLedgerList();
  }

  // ── Business case: do digital scans add picks? ─────────────────────────────
  // The analyst's case to the VizPick report owner (2026-09-16): scanning with
  // the digital exception filter still adds suggested picks to a bin, which then
  // count as open under the digital associate. Everything below is measured from
  // the kept updates by lib/home_history.js::scanImpact / scanLedger.

  // Scan times arrive as "9/15/2026 3:20:17 PM", sometimes with a narrow
  // no-break space before AM/PM that Date() will not parse.
  const scanClock = (s) => clock(String(s || "").replace(/[  ]/g, " "));
  const scanDayKey = (s) => {
    const m = String(s || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
  };
  const personName = (win) => (win ? histPerson(win)?.name || win : "nobody");

  /** The groups the case compares; every other job is pooled. */
  function caseGroup(win) {
    const g = jobGroup(histPerson(win));
    return g === "Digital" || g === "Stocking 1" || g === "Not on today's schedule" || g === "Name not resolved" ? g : "Other jobs";
  }

  function businessCaseHtml(rawEntries) {
    // Foreign captures and repeat captures of one Tableau update are set aside
    // first, so the totals and the lists below read the same updates.
    const cleaned = cleanDay(rawEntries);
    const entries = cleaned.entries;
    const setAside = [
      cleaned.foreign.length ? `${cleaned.foreign.length} update${cleaned.foreign.length === 1 ? "" : "s"} whose bins weren't this store's` : "",
      cleaned.duplicates ? `${cleaned.duplicates} repeat capture${cleaned.duplicates === 1 ? "" : "s"} of the same Tableau update` : "",
    ].filter(Boolean).join(" and ");
    if (entries.length < 2) {
      histCaseText = "";
      histCaseModel = null;
      return `<p class="vizpick-hist-empty">The business case needs at least two updates on this day.</p>`;
    }
    const impact = scanImpact(entries, caseGroup);
    const ledger = scanLedger(entries);
    const byGroup = new Map(impact.groups.map((g) => [g.group, g]));
    const dig = byGroup.get("Digital") || null;
    const stk = byGroup.get("Stocking 1") || null;
    const pct = (v) => (v == null ? "—" : `${v}%`);
    const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
    const loading = !histSchedules.has(histDay);
    const noSchedule = histSchedules.has(histDay) && !histSchedules.get(histDay);
    const digAdds = [];
    for (const b of ledger) for (const r of b.rows) {
      if (r.kind === "scan" && r.dDue > 0 && r.win && caseGroup(r.win) === "Digital") digAdds.push({ location: b.location, ...r });
    }
    digAdds.sort((a, b) => String(a.at).localeCompare(String(b.at)) || a.location.localeCompare(b.location));

    let verdict;
    if (loading) verdict = "Loading names and the Digital Metrics schedule for this day…";
    else if (noSchedule) verdict = "Digital Metrics has no schedule for this day (or is not signed in), so scans cannot be grouped by job. Sign in to Digital Metrics and reopen this view.";
    else if (!dig?.scans) verdict = "No scans by digital associates were caught on this day.";
    else {
      verdict = `Digital associates' scans added ${plural(dig.picksAdded, "suggested pick")} to the store's pick total across ${plural(dig.scans, "scan")}.`;
      if (dig.rescans >= 3) {
        verdict += ` When a digital associate rescanned a bin already scanned that day, its picks went up ${pct(dig.rescanRate)} of the time`;
        verdict += stk?.rescans ? `, against ${pct(stk.rescanRate)} for Stocking 1` : "";
        verdict += ".";
      }
      verdict += ` At the last update, ${plural(dig.openAtClose, "pick")} ${dig.openAtClose === 1 ? "was" : "were"} still open in ${plural(dig.binsOpenAtClose, "bin")} last scanned by digital associates.`;
    }

    const order = ["Digital", "Stocking 1", "Other jobs", "Not on today's schedule", "Name not resolved"];
    const groupRows = order.map((g) => byGroup.get(g)).filter(Boolean);
    // "Other jobs" pools every scheduled job that is neither digital nor
    // Stocking 1; the same measure per job title, with who held it that day.
    const jobPeople = new Map();
    const otherJobs = scanImpact(entries, (w) => {
      if (caseGroup(w) !== "Other jobs") return "__skip";
      const p = histPerson(w);
      const job = p?.job || "Other";
      if (!jobPeople.has(job)) jobPeople.set(job, new Set());
      jobPeople.get(job).add(p?.name || w);
      return job;
    }).groups.filter((g) => g.group !== "__skip")
      .map((g) => ({ ...g, people: [...(jobPeople.get(g.group) || [])] }))
      .sort((a, b) => (b.rescans + b.firstScans) - (a.rescans + a.firstScans) || a.group.localeCompare(b.group));
    const statCells = (g) => `<td class="num">${g.rescans}</td>
        <td class="num">${g.rescansGained} (${pct(g.rescanRate)})</td><td class="num">${g.rescanPicks}</td>
        <td class="num">${g.firstScans}</td><td class="num">${g.firstScanPicks}</td>`;
    // Open picks are only reported for digital associates (verdict + tally):
    // leftovers under other jobs are not part of this case (analyst, 2026-09-16).
    const otherToggle = otherJobs.length
      ? ` <button class="vizpick-linkbtn" data-hist-other-toggle aria-expanded="${histOtherOpen}">${histOtherOpen ? "hide" : "show"} ${otherJobs.length} job${otherJobs.length === 1 ? "" : "s"}</button>`
      : "";
    const otherSubRows = histOtherOpen
      ? otherJobs.map((j) => `<tr class="vizpick-case-sub"><td>${escapeHtml(j.group)} <span class="vizpick-hist-muted">${escapeHtml(j.people.join(", "))}</span></td>${statCells(j)}</tr>`).join("")
      : "";
    const groupTable = `<div class="vizpick-hist-scroll"><table class="vizpick-hist-table">
      <thead><tr><th>Scanned by</th><th class="num">Rescans</th><th class="num">Rescans that added picks</th><th class="num">New picks on rescans</th><th class="num">First scans of the day</th><th class="num">New picks on first scans</th></tr></thead>
      <tbody>${groupRows.map((g) => `<tr class="${g.group === "Digital" ? "vizpick-case-digital" : ""}">
        <td>${escapeHtml(g.group)}${g.group === "Other jobs" ? otherToggle : ""}</td>${statCells(g)}</tr>${g.group === "Other jobs" ? otherSubRows : ""}`).join("")}
      </tbody></table></div>`;

    const scanRow = (s, prevLabel = true) => `<tr>
      <td>${escapeHtml(s.location)}</td>
      <td>${escapeHtml(personName(s.win))}</td>
      <td>${escapeHtml(scanClock(s.scanAt))}</td>
      ${prevLabel ? `<td>${escapeHtml(personName(s.prevWin))}${s.prevWin ? ` <span class="vizpick-hist-muted">${escapeHtml(histPerson(s.prevWin)?.job || "")}</span>` : ""}</td>` : ""}
      <td class="num ${s.dDue > 0 ? "vizpick-ledger-up" : ""}">${signed(s.dDue)}</td>
      <td class="num">${s.done} / ${s.due}</td>
    </tr>`;
    // The same picks per digital associate, so each person's share is visible.
    const byAssociate = new Map();
    for (const r of digAdds) {
      const cur = byAssociate.get(r.win) || { win: r.win, scans: 0, picks: 0, bins: new Set() };
      cur.scans++; cur.picks += r.dDue; cur.bins.add(r.location);
      byAssociate.set(r.win, cur);
    }
    const associates = [...byAssociate.values()].sort((a, b) => b.picks - a.picks);
    const digAddsTotal = associates.reduce((n, a) => n + a.picks, 0);
    const associatesHtml = associates.length
      ? `<div class="vizpick-hist-scroll"><table class="vizpick-hist-table">
          <thead><tr><th>Digital associate</th><th class="num">Scans that added picks</th><th class="num">Bins</th><th class="num">Picks added</th></tr></thead>
          <tbody>${associates.map((a) => `<tr><td>${escapeHtml(personName(a.win))} <span class="vizpick-hist-muted">${escapeHtml(histPerson(a.win)?.job || "")}</span></td>
            <td class="num">${a.scans}</td><td class="num">${a.bins.size}</td><td class="num vizpick-ledger-up">+${a.picks}</td></tr>`).join("")}
          <tr class="vizpick-case-digital"><td>All digital associates</td><td class="num">${digAdds.length}</td><td class="num">${new Set(digAdds.map((r) => r.location)).size}</td><td class="num">+${digAddsTotal}</td></tr></tbody></table></div>`
      : "";
    const addsHtml = digAdds.length
      ? `${associatesHtml}<div class="vizpick-hist-scroll"><table class="vizpick-hist-table">
          <thead><tr><th>Tableau data as of</th><th>Bin</th><th>Scanned by</th><th>Scan</th><th>Scanned before by</th><th class="num">Picks added</th><th class="num">Done / due after</th></tr></thead>
          <tbody>${digAdds.map((r) => `<tr><td>${escapeHtml(clock(r.at))}</td>${scanRow(r).replace(/^<tr>/, "").replace(/<\/tr>$/, "")}</tr>`).join("")}</tbody></table></div>`
      : `<p class="vizpick-hist-note">No digital scan added picks on this day.</p>`;

    // ── How this is measured, with a worked example from this day ───────────
    // The example is the digital scan that added the most picks to a bin
    // someone else had scanned before, so it shows a handover plainly.
    const example = [...digAdds].filter((r) => r.prevWin && r.prevWin !== r.win).sort((a, b) => b.dDue - a.dDue)[0]
      || [...digAdds].sort((a, b) => b.dDue - a.dDue)[0] || null;
    let methodHtml = "";
    let exampleModel = null;
    const methodLines = [];
    const steps = [
      "Tableau's VizPick Details report has a \"Location Details\" download: one row per backroom bin with its suggested picks due, suggested picks done, who scanned the bin last (user ID) and when.",
      "Every time Tableau publishes an update for the store (checked every 30 minutes, published about hourly), the suite saves that whole table: every bin, its counts, and its last scanner.",
      "Each bin is compared with itself at the previous update. If its last-scan time changed, someone scanned it in between, and the change in picks due and done between those two updates is recorded against that scan.",
      "The scanner's job comes from that day's Digital Metrics schedule, matched by name. A scan counts as digital when the scheduled job is a digital job.",
    ];
    if (example) {
      const bin = ledger.find((b) => b.location === example.location);
      const exTime = Date.parse(example.at);
      const before = [...entries].reverse().find((e) => Date.parse(e.sourceIso || e.capturedAt) < exTime && (e.bins || []).some((b) => b.location === example.location));
      const priorBin = before?.bins.find((b) => b.location === example.location) || null;
      const who = (win) => `${personName(win)}${histPerson(win)?.job ? ` (${histPerson(win).job})` : ""}`;
      const narrative = priorBin
        ? `At the ${clock(before.sourceIso || before.capturedAt)} update, bin ${example.location} had last been scanned at ${scanClock(priorBin.lastSeenAt)} by ${who(priorBin.win)} and showed ${priorBin.done} of ${priorBin.seen} picks done. `
          + `At the ${clock(example.at)} update, its last scan was ${scanClock(example.scanAt)} by ${who(example.win)}, and it showed ${example.done} of ${example.due} picks done: `
          + `${example.dDue} more picks due${example.dDone ? ` and ${example.dDone} more done` : " and none more done"}, with no other scan of that bin recorded in between.`
        : "";
      const rows = (bin?.rows || []).map((r) => `<tr class="${r.kind === "noscan" ? "vizpick-ledger-noscan" : ""}${r === bin.rows.find((x) => x.kind === "scan" && x.at === example.at && x.scanAt === example.scanAt) ? " vizpick-case-digital" : ""}">
          <td>${escapeHtml(clock(r.at))}</td>
          <td>${r.kind === "noscan" ? "no new scan" : escapeHtml(scanClock(r.scanAt))}${r.scanAt && scanDayKey(r.scanAt) !== histDay ? ` <span class="vizpick-hist-muted">(${escapeHtml(scanDayKey(r.scanAt) || "")})</span>` : ""}</td>
          <td>${r.kind === "noscan" ? "—" : escapeHtml(personName(r.win))} <span class="vizpick-hist-muted">${r.kind === "noscan" ? "" : escapeHtml(histPerson(r.win)?.job || "")}</span></td>
          <td class="num">${r.done} / ${r.due}</td>
          <td class="num">${r.dDue == null ? "starting point" : `${r.dDue ? `<span class="vizpick-ledger-up">${signed(r.dDue)} due</span>` : "+0 due"}${r.dDone ? `, <span class="vizpick-ledger-done">${signed(r.dDone)} done</span>` : ""}`}</td>
        </tr>`).join("");
      methodHtml = `
        <h3 class="vizpick-hist-sub">How this is measured</h3>
        <ol class="vizpick-case-steps">${steps.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ol>
        <p class="vizpick-hist-summary"><strong>Worked example, bin ${escapeHtml(example.location)}.</strong> ${escapeHtml(narrative)}</p>
        <div class="vizpick-hist-scroll"><table class="vizpick-hist-table">
          <thead><tr><th>Tableau update</th><th>Bin's last scan</th><th>Scanned by</th><th class="num">Done / due</th><th class="num">Change since the row above</th></tr></thead>
          <tbody>${rows}</tbody></table></div>
        <p class="vizpick-hist-note">What this can't show: who pulled a pick ("done" is the bin's total, not a person's), which screen or filter was open on the device, or a second scan inside the same update window. The counts on a scan row are the next update's, so they can include work finished shortly after the scan.</p>`;
      methodLines.push("", "How this is measured:");
      steps.forEach((s, i) => methodLines.push(`${i + 1}. ${s}`));
      if (narrative) methodLines.push("", `Worked example, bin ${example.location}: ${narrative}`);
      methodLines.push("What this can't show: who pulled a pick (\"done\" is the bin's total), which screen or filter was open on the device, or a second scan inside the same update window.");
      exampleModel = {
        location: example.location,
        narrative,
        rows: (bin?.rows || []).map((r) => ({
          update: clock(r.at),
          scan: r.kind === "noscan" ? "no new scan" : `${scanClock(r.scanAt)}${r.scanAt && scanDayKey(r.scanAt) !== histDay ? ` (${scanDayKey(r.scanAt) || ""})` : ""}`,
          name: r.kind === "noscan" ? "—" : personName(r.win),
          job: r.kind === "noscan" ? "" : histPerson(r.win)?.job || "",
          done: r.done, due: r.due,
          change: r.dDue == null ? "starting point" : `${signed(r.dDue)} due${r.dDone ? `, ${signed(r.dDone)} done` : ""}`,
        })),
      };
    }

    // Plain text for an email or Teams message to the report owner.
    const lines = [`VizPick, store ${entries[0].store}, ${histDay}`, "", verdict, "", "Rescans of bins already scanned that day:"];
    for (const g of groupRows) lines.push(`- ${g.group}: ${g.rescans} rescans, ${g.rescansGained} added picks (${pct(g.rescanRate)}), ${g.rescanPicks} new picks`);
    if (otherJobs.length) {
      lines.push("", "\"Other jobs\" is every scheduled job that is neither digital nor Stocking 1:");
      for (const j of otherJobs) lines.push(`- ${j.group} (${j.people.join(", ")}): ${j.rescans} rescans, picks went up on ${j.rescansGained}, +${j.rescanPicks} picks; ${j.firstScans} first scans, +${j.firstScanPicks} picks`);
    }
    if (associates.length) {
      lines.push("", `Picks added on digital scans, by associate (${digAddsTotal} total):`);
      for (const a of associates) lines.push(`- ${personName(a.win)}: +${a.picks} picks on ${a.scans} scans across ${a.bins.size} bins`);
    }
    lines.push(...methodLines);
    lines.push("", "Limits: Tableau keeps only each bin's last scan per update, and a scan's counts are the next update's. The data shows whose scan it was, not which filter was active.");
    histCaseText = lines.join("\n");

    // Everything above as plain values for "Generate PDF report", so the PDF
    // says exactly what the tab says (lib/case_report.js).
    const people = {};
    for (const e of entries) for (const b of e.bins || []) {
      if (!b.win || people[b.win]) continue;
      const p = histPerson(b.win);
      people[b.win] = { name: p?.name || b.win, job: p?.job || null, shiftStart: p?.shiftStart || null, shiftEnd: p?.shiftEnd || null };
    }
    const countsOf = (g) => ({ rescans: g.rescans, rescansGained: g.rescansGained, rescanRate: g.rescanRate, rescanPicks: g.rescanPicks, firstScans: g.firstScans, firstScanPicks: g.firstScanPicks });
    histCaseModel = {
      store: String(entries[0].store), day: histDay,
      generatedAt: new Date().toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }),
      verdict, setAside,
      tallies: dig?.scans ? [
        { value: `+${dig.picksAdded}`, label: `picks added on ${plural(dig.scans, "digital scan")}` },
        { value: `${pct(dig.rescanRate)} vs ${pct(stk?.rescanRate ?? null)}`, label: "digital rescans that added picks, vs Stocking 1" },
        { value: dig.openAtClose, label: `picks open at the last update under digital associates (${plural(dig.binsOpenAtClose, "bin")})` },
      ] : [],
      groupRows: groupRows.map((g) => ({ group: g.group, ...countsOf(g) })),
      otherJobs: otherJobs.map((j) => ({ group: j.group, people: j.people, ...countsOf(j) })),
      associates: associates.map((a) => ({ name: personName(a.win), job: histPerson(a.win)?.job || "", scans: a.scans, bins: a.bins.size, picks: a.picks })),
      digAdds: digAdds.map((r) => ({
        update: clock(r.at), location: r.location, name: personName(r.win), job: histPerson(r.win)?.job || "",
        scan: scanClock(r.scanAt), prevName: r.prevWin ? personName(r.prevWin) : "", prevJob: r.prevWin ? histPerson(r.prevWin)?.job || "" : "",
        dDue: r.dDue, done: r.done, due: r.due,
      })),
      steps, example: exampleModel,
      cannotShow: "What this can't show: who pulled a pick (\"done\" is the bin's total, not a person's), which screen or filter was open on the device, or a second scan inside the same update window. The counts on a scan row are the next update's, so they can include work finished shortly after the scan.",
      limits: "Limits: Tableau keeps only each bin's last scan per update, so a second scan inside the same update window is invisible. A scan's counts are the next update's, up to an hour later. The data shows whose scan it was, not which filter was active on the device. Jobs come from the Digital Metrics schedule for the selected day.",
      summaryText: histCaseText,
      entries, people,
    };

    const tally = (value, label) => `<div class="vizpick-case-tally"><strong>${value}</strong><span>${label}</span></div>`;
    return `
      <p class="vizpick-case-verdict">${escapeHtml(verdict)}</p>
      ${setAside ? `<p class="vizpick-hist-note">Measured from ${entries.length} Tableau updates. Set aside: ${escapeHtml(setAside)}.</p>` : ""}
      ${dig?.scans ? `<div class="vizpick-case-tallies">
        ${tally(`+${dig.picksAdded}`, `picks added on ${plural(dig.scans, "digital scan")}`)}
        ${tally(`${pct(dig.rescanRate)} <small>vs ${pct(stk?.rescanRate ?? null)}</small>`, "digital rescans that added picks, vs Stocking 1")}
        ${tally(dig.openAtClose, `picks open at the last update under digital associates (${plural(dig.binsOpenAtClose, "bin")})`)}
      </div>` : ""}
      <div class="vizpick-case-actions">
        <button class="btn btn-primary" data-hist-pdf>Generate PDF report</button>
        <button class="btn" data-hist-copy>Copy summary</button>
        <button class="vizpick-linkbtn" data-hist-ledger-export>Export bin history CSV</button>
        <span class="vizpick-hist-muted" data-hist-copied aria-live="polite"></span>
      </div>

      <h3 class="vizpick-hist-sub">Do picks go up when a bin is scanned, whoever scans it?</h3>
      ${groupTable}
      <p class="vizpick-hist-note">"New picks" are picks that appeared in a bin when that group scanned it: how many picks each group's scans generated. They are not picks left behind; most were pulled afterwards. "Rescans" are bins already scanned earlier that day, so a first scan of the day doesn't inflate them.</p>

      <h3 class="vizpick-hist-sub">Every digital scan that added picks (${digAdds.length})</h3>
      ${addsHtml}

      ${methodHtml}

      <p class="vizpick-hist-note">Limits: Tableau keeps only each bin's last scan per update, so a second scan inside the same update window is invisible. A scan's counts are the next update's, up to an hour later. The data shows whose scan it was, not which filter was active on the device. Jobs come from the Digital Metrics schedule for the selected day.</p>`;
  }

  // ── Bin by bin: every bin's scans across the day ───────────────────────────
  function ledgerShellHtml() {
    const opt = (v, label) => `<option value="${v}"${histLedgerFilter === v ? " selected" : ""}>${label}</option>`;
    return `
      <div class="vizpick-ledger-tools">
        <input type="search" id="vizpick-hist-ledger-q" data-hist-ledger-q placeholder="Bin (040/005) or name" value="${escapeHtml(histLedgerQuery)}" aria-label="Filter bins by bin code or associate name">
        <select id="vizpick-hist-ledger-filter" data-hist-ledger-filter aria-label="Which bins">
          ${opt("all", "All bins")}${opt("picks", "Had picks")}${opt("open", "Open at last update")}${opt("handed", "Changed hands with picks open")}${opt("digital", "A digital scan added picks")}
        </select>
        <button class="vizpick-linkbtn" data-hist-ledger-expand="1">Expand all</button>
        <button class="vizpick-linkbtn" data-hist-ledger-expand="0">Collapse all</button>
        <button class="vizpick-linkbtn" data-hist-ledger-export>Export bin history CSV</button>
        <span class="vizpick-hist-muted" data-hist-ledger-count></span>
      </div>
      <p class="vizpick-hist-note">Each scan row shows who scanned the bin, when, and the bin's picks done / due at the next Tableau update, with the change since the row above. "No scan" rows are updates where the counts changed but nobody had rescanned the bin.</p>
      <div class="vizpick-ledger-list" data-hist-ledger-list></div>`;
  }

  function paintLedgerList() {
    const listEl = histEl?.querySelector("[data-hist-ledger-list]");
    if (!listEl) return;
    const ledger = scanLedger(cleanDay(histData?.entries || []).entries);
    const q = histLedgerQuery.trim().toLowerCase();
    const isDigitalAdd = (b) => b.rows.some((r) => r.kind === "scan" && r.dDue > 0 && r.win && caseGroup(r.win) === "Digital");
    const shown = ledger.filter((b) => {
      if (histLedgerFilter === "picks" && !b.hadPicks) return false;
      if (histLedgerFilter === "open" && !b.open) return false;
      if (histLedgerFilter === "handed" && !b.handedOver) return false;
      if (histLedgerFilter === "digital" && !isDigitalAdd(b)) return false;
      if (!q) return true;
      if (b.location.toLowerCase().includes(q)) return true;
      return b.rows.some((r) => [r.win, personName(r.win)].some((v) => String(v || "").toLowerCase().includes(q)));
    });
    const change = (r) => {
      if (r.dDue == null) return "";
      const parts = [];
      if (r.dDue) parts.push(`<span class="vizpick-ledger-up">${signed(r.dDue)} due</span>`);
      if (r.dDone) parts.push(`<span class="vizpick-ledger-done">${signed(r.dDone)} done</span>`);
      return parts.join(", ") || "no change";
    };
    const what = (r) => {
      if (r.kind === "start") return r.scannedToday ? "already scanned today when tracking began" : "last scanned before today";
      if (r.kind === "noscan") return "counts changed with no new scan";
      const handed = r.prevWin && r.win && r.prevWin !== r.win;
      const base = handed
        ? (r.carriedOpen ? `took over ${r.carriedOpen} open from ${escapeHtml(personName(r.prevWin))}` : `after ${escapeHtml(personName(r.prevWin))}, nothing open`)
        : "rescanned by the same associate";
      return r.firstToday ? `${base} · first scan today` : base;
    };
    const when = (r) => {
      const upd = `<span class="vizpick-hist-muted"> · update ${escapeHtml(clock(r.at))}</span>`;
      if (r.kind === "noscan") return `no scan${upd}`;
      if (!r.scanAt) return `not scanned${upd}`;
      const d = scanDayKey(r.scanAt);
      return `${escapeHtml(scanClock(r.scanAt))}${d && d !== histDay ? ` <span class="vizpick-hist-muted">(${escapeHtml(d)})</span>` : ""}${upd}`;
    };
    listEl.innerHTML = shown.map((b) => {
      const end = !b.hadPicks ? `<span class="vizpick-hist-muted">no picks</span>`
        : b.open ? `<span class="vizpick-ledger-up">${b.open} open</span> · ${b.done} / ${b.due}` : `<span class="vizpick-ledger-done">${b.done} / ${b.due} done</span>`;
      const rows = b.rows.map((r) => {
        const p = r.win ? histPerson(r.win) : null;
        return `<tr class="${r.kind === "noscan" ? "vizpick-ledger-noscan" : ""}">
          <td>${when(r)}</td>
          <td>${r.kind === "noscan" ? "—" : escapeHtml(personName(r.win))}</td>
          <td>${r.kind === "noscan" ? "" : escapeHtml(p?.job || (r.win ? "not on the schedule" : ""))}</td>
          <td class="num">${r.done} / ${r.due}</td>
          <td>${change(r)}</td>
          <td>${what(r)}</td>
        </tr>`;
      }).join("");
      return `<details class="vizpick-ledger-bin" open>
        <summary><span class="code">${escapeHtml(b.location)}</span>
          <span class="vizpick-hist-muted">${b.scans} scan${b.scans === 1 ? "" : "s"} · last ${escapeHtml(personName(b.win))}</span>
          <span class="end">${end}</span></summary>
        <div class="vizpick-hist-scroll"><table class="vizpick-hist-table">
          <thead><tr><th>Scan</th><th>Associate</th><th>Job</th><th class="num">Done / due</th><th>Change</th><th>What happened</th></tr></thead>
          <tbody>${rows}</tbody></table></div>
      </details>`;
    }).join("") || `<p class="vizpick-hist-note">No bins match. Try a bin code like 040/005 or part of a name.</p>`;
    const countEl = histEl.querySelector("[data-hist-ledger-count]");
    if (countEl) countEl.textContent = `${shown.length} of ${ledger.length} bins`;
  }

  // What the home-store checks found on the selected day, so a missing hour
  // says whether Tableau had not published or the check itself failed.
  function histPollNote(polls) {
    if (!polls.length) return "";
    const lastPoll = polls[polls.length - 1];
    const said = {
      unchanged: `Tableau still showed data as of ${clock(lastPoll.stamp)}`,
      added: `a new update was kept (Tableau data as of ${clock(lastPoll.stamp)})`,
      confirmed: `same data as the newest update kept`,
      rejected: `the capture was refused because its bins were not this store's`,
      failed: `the check failed (${lastPoll.error || "no data"})`,
    }[lastPoll.outcome] || String(lastPoll.outcome || "");
    const failed = polls.filter((p) => !p.ok);
    const failedText = failed.length
      ? ` ${failed.length} failed: ${failed.slice(-6).map((p) => `${clock(p.at)} (${p.error || "no data"})`).join("; ")}.`
      : " None failed.";
    return `<p class="vizpick-hist-note">Last checked ${escapeHtml(clock(lastPoll.at))}: ${escapeHtml(said)}. ${polls.length} check${polls.length === 1 ? "" : "s"} logged this day.${escapeHtml(failedText)}</p>`;
  }

  container.querySelector('[data-action="open-history"]')?.addEventListener("click", () => {
    if (!histDialog) return;
    if (!histDialog.open) histDialog.showModal();
    paintHomeHistory();
    loadHomeHistory();
  });
  // Click on the backdrop (the dialog element itself, outside its content) closes.
  histDialog?.addEventListener("click", (e) => { if (e.target === histDialog) histDialog.close(); });

  histEl?.addEventListener("click", async (e) => {
    if (e.target.closest?.("[data-hist-close]")) { histDialog?.close(); return; }
    if (e.target.closest?.("[data-hist-load]")) { histEl.querySelector("[data-hist-file]")?.click(); return; }
    if (e.target.closest?.("[data-hist-save]")) {
      try {
        const res = await host.messaging.send("home_history_export", {});
        const days = Object.keys(res.history?.days || {}).sort();
        if (!days.length) { histFileNote = "Nothing kept yet to save."; paintHomeHistory(); return; }
        const store = res.history.days[days[days.length - 1]]?.[0]?.store || "home";
        const blob = new Blob([JSON.stringify(res.history)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `vizpick-pick-history-${store}-${days[0]}-to-${days[days.length - 1]}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        histFileNote = `Saved ${days.length} day${days.length === 1 ? "" : "s"} (${days[0]} to ${days[days.length - 1]}).`;
      } catch (err) {
        histFileNote = `Couldn't save the history file: ${err?.message ?? err}`;
      }
      paintHomeHistory();
      return;
    }
    if (e.target.closest?.("[data-hist-other-toggle]")) { histOtherOpen = !histOtherOpen; paintHomeHistory(); return; }
    const viewBtn = e.target.closest?.("[data-hist-view]");
    if (viewBtn) { histView = viewBtn.dataset.histView; paintHomeHistory(); return; }
    const pdfBtn = e.target.closest?.("[data-hist-pdf]");
    if (pdfBtn) {
      const note = histEl.querySelector("[data-hist-copied]");
      const say = (text) => { if (note) note.textContent = text; };
      if (!histCaseModel || histCaseModel.day !== histDay) { say("Open a day with at least two updates first."); return; }
      if (!histSchedules.get(histDay)) { say("The schedule for this day hasn't loaded, so scans can't be grouped by job yet. Sign in to Digital Metrics, reopen, and try again."); return; }
      const model = histCaseModel;
      pdfBtn.disabled = true;
      say("Building the PDF…");
      try {
        const { generateCasePdf } = await import("./lib/case_report.js");
        const { blob, files } = await generateCasePdf(model);
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `vizpick-business-case-${model.store}-${model.day}.pdf`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
        say(`PDF saved with ${files.length} data files attached. Open it in Adobe Acrobat Reader and click the paperclip to get the files.`);
      } catch (err) {
        say(`Couldn't build the PDF: ${err?.message ?? err}`);
      } finally {
        pdfBtn.disabled = false;
      }
      return;
    }
    if (e.target.closest?.("[data-hist-copy]")) {
      const note = histEl.querySelector("[data-hist-copied]");
      try {
        await navigator.clipboard.writeText(histCaseText);
        if (note) note.textContent = "Copied. Paste it into an email or Teams.";
      } catch {
        if (note) note.textContent = "Couldn't copy: the browser blocked clipboard access. Click in the page and try again.";
      }
      return;
    }
    const expand = e.target.closest?.("[data-hist-ledger-expand]");
    if (expand) {
      const open = expand.dataset.histLedgerExpand === "1";
      histEl.querySelectorAll(".vizpick-ledger-bin").forEach((d) => { d.open = open; });
      return;
    }
    if (e.target.closest?.("[data-hist-ledger-export]") && histData?.entries?.length) {
      const blob = new Blob([ledgerCsv(scanLedger(cleanDay(histData.entries).entries), { person: histPerson })], { type: "text/csv" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `vizpick-bins-${histData.entries[0].store}-${histData.day}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      return;
    }
    const toggle = e.target.closest?.("[data-hist-toggle]");
    if (toggle) {
      const bins = histEl.querySelector(`[data-hist-bins="${toggle.dataset.histToggle}"]`);
      if (bins) bins.hidden = !bins.hidden;
      return;
    }
    if (e.target.closest?.("[data-hist-capture]") && !histBusy) {
      histBusy = true;
      paintHomeHistory();
      // Not forced: the analyst's rule is that an unchanged Tableau stamp means
      // no re-capture (see the note on HOME_POLL_MIN in service.js).
      try { await withWatchdog(host.messaging.send("home_history_poll_now", {}), 300_000, "home-history"); }
      catch { /* the panel simply shows what is kept */ }
      histBusy = false;
      histDay = null;          // jump to the newest day
      await loadHomeHistory();
      return;
    }
    if (e.target.closest?.("[data-hist-export]") && histData?.entries?.length) {
      const blob = new Blob([historyCsv(histData.entries, { person: histPerson })], { type: "text/csv" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `vizpick-home-${histData.entries[0].store}-${histData.day}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }
  });
  histEl?.addEventListener("change", (e) => {
    if (e.target.matches?.("[data-hist-day]")) { histDay = e.target.value; loadHomeHistory(); }
    if (e.target.matches?.("[data-hist-cutoff]")) { histCutoff = e.target.value || "15:00"; paintHomeHistory(); }
    if (e.target.matches?.("[data-hist-ledger-filter]")) { histLedgerFilter = e.target.value; paintLedgerList(); }
    if (e.target.matches?.("[data-hist-file]")) {
      const file = e.target.files?.[0];
      if (!file) return;
      (async () => {
        try {
          const history = JSON.parse(await file.text());
          const res = await host.messaging.send("home_history_import", { history });
          const days = Object.keys(res.added || {}).sort();
          const total = days.reduce((n, d) => n + res.added[d], 0);
          histFileNote = total
            ? `Loaded ${total} update${total === 1 ? "" : "s"} from ${file.name} (${days.map((d) => `${d}: ${res.added[d]}`).join(", ")}).`
            : `Nothing new in ${file.name}: every update in it was already kept.`;
          if (days.length) histDay = days[days.length - 1];
        } catch (err) {
          histFileNote = `Couldn't load ${file.name}: ${err instanceof SyntaxError ? "the file isn't valid JSON" : (err?.message ?? err)}`;
        }
        await loadHomeHistory();
      })();
    }
  });
  // Typing in the bin search repaints only the list, so the box keeps focus.
  histEl?.addEventListener("input", (e) => {
    if (e.target.matches?.("[data-hist-ledger-q]")) { histLedgerQuery = e.target.value; paintLedgerList(); }
  });
  const scheduleHistory = () => {
    if (!histOpen()) return;
    if (histTimer) clearTimeout(histTimer);
    histTimer = setTimeout(() => { histTimer = null; loadHomeHistory(); }, ROWS_REPAINT_DEBOUNCE_MS);
  };
  const unsubHistRows = host.messaging.on("today_rows", scheduleHistory);
  const unsubHistDone = host.messaging.on("source_complete", scheduleHistory);
  // The home-store poll runs on its own alarm, outside any crawl.
  const unsubHistPoll = host.messaging.on("home_history", () => loadHomeHistory());

  // 8. Cleanup — MUST be called by shell when navigating away.
  return () => {
    unsubHistRows();
    unsubHistDone();
    unsubHistPoll();
    if (histTimer) clearTimeout(histTimer);
    if (histDialog?.open) histDialog.close();
    titlesStopped = true;   // ends the Workday title pass between batches
    unsub();
    unsubProgress();
    unsubPhase();
    unsubRows();
    unsubMarket();
    // A pending debounce would fire paint() after unmount, against a detached
    // container — and paint() sends a message, so it would also wake the SW
    // for nothing.
    if (rowsRepaintTimer) clearTimeout(rowsRepaintTimer);
    link.remove();
  };
}
