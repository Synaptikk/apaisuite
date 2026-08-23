// modules/vizpick/view.js
//
// Full-page dashboard mount. Loads view.html, wires the Refresh button, the
// Market picker and the Yesterday/Today tabs, subscribes to source_complete
// broadcasts, and re-renders on each update. The Market select is the whole
// point of this module: pick a market once and see every store in it side by
// side, instead of typing store numbers one at a time into Tableau's VizPick
// Details search box.

import { gaugeSvg, bandFor } from "./lib/charts.js";
import { getUserHomeMarket, getUserHomeStore, onUserMarketChange } from "../../shared/userStore.js";
import { rollUpSkippedByAssociate } from "./lib/parse_vizpick_stores_csv.js";
import { buildPerformanceHtml, buildPickListHtml, buildCardEmail } from "./lib/card_report.js";
import * as associateDirectory from "../../shared/associateDirectory.js";
import { hasName } from "../../shared/associateDirectory.js";
import { lookupNames, lookupDiagnostics, diffLookupDiagnostics } from "../../shared/associateLookup.js";
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
  let directory = new Map();
  // WINs this mount has already put through the resolver, so a repaint does
  // not re-query them. Deliberately NOT expressed as a null in `directory`:
  // that conflates "we tried and failed" with "we hold no record", and it
  // would also clobber a record carrying a title but no name.
  let attempted = new Set();
  // Outcome of the last resolution pass, so the Associates card can explain a
  // column of ids instead of just showing one. null = never ran.
  let nameResolve = null;

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
  btnRefresh.addEventListener("click", () => runRefresh(false));
  btnForce.addEventListener("click", () => runRefresh(true));
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
  async function refreshDirectory() {
    // Only the associates actually on screen. Collecting every WIN in the
    // market meant resolving hundreds of people nobody would ever see.
    const wins = new Set();
    for (const r of rowsForActiveTab()) {
      for (const a of topAssociatesFor(r).shown) if (a.win) wins.add(a.win);
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
    const missing = [...wins].filter((w) => !hasName(directory.get(w)) && !attempted.has(w));
    if (!missing.length) return false;

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
    const stillMissing = missing.filter((w) => !hasName(directory.get(w)));
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
      const unresolved = stillMissing.filter((w) => !hasName(directory.get(w))).length;
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

    // Mark everything this pass touched, so a repaint does not re-query the
    // ones that stayed unresolved. They render as the bare WIN, which is the
    // honest outcome: better an id than a confidently wrong name on a list
    // like this — but the card now says WHY, via nameResolveNote().
    for (const w of missing) attempted.add(w);
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
  const unsub = host.messaging.on("source_complete", () => { paint(); });
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
    const stores = rosterRows().map((r) => r.store);
    if (!stores.length) {
      renderTodayBar(null, "Refresh the Yesterday tab first — it supplies the store list for this market.");
      return;
    }
    btnLoadToday.disabled = true;
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
    return selectedMarket ? all.filter((r) => r.market === selectedMarket) : [];
  }

  function todayRows() {
    // Today rows carry no market/BU/region of their own (the Details export
    // has no such columns), so they're joined back onto the yesterday roster
    // by store number — which is also what scoped the capture.
    const today = state?.today?.rows || [];
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
      deptCount:       t.deptCount,
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
    refreshDirectory().then((changed) => { if (changed) render(); }).catch(() => {});
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
      const su = snap?.sourceUpdate;
      const note = activeNote();

      if (!snap) {
        absEl.textContent = "—";
        absEl.title = note;
      } else if (su?.iso) {
        const d = new Date(su.iso);
        const day = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
        if (su.hasTime) {
          const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
          absEl.textContent = `${day} — ${time}`;
          absEl.title = `Tableau last updated ${d.toLocaleString()} (${humanAge(Date.now() - d.getTime())} ago). ${note}`;
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
    const partial = state?.today?.partial;
    renderTodayBar(
      null,
      (n
        ? `Showing ${n} of ${roster} stores in this market.` +
          (partial ? " Some stores could not be captured — see the capture details below." : "") +
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
    return `Checks ${mine} (${a.market}) every ${a.periodMin} min and reloads only when Tableau's Updated stamp moves.`;
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
    if (!r.isToday) {
      return `<p class="vizpick-dept-none">Department breakdown is current-day only — the daily summary export has no department detail.</p>`;
    }
    const depts = Array.isArray(r.depts) ? r.depts : [];
    if (!depts.length) {
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
        ${pane === "assoc" ? assoc : `
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
    const bare = shown.filter((a) => a.win && !hasName(directory.get(a.win))).length;
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
    if (!r.isToday) {
      return `<p class="vizpick-dept-none">Associate detail is current-day only — the daily summary export has no per-location data.</p>`;
    }
    const gaps = r.locations?.gaps;
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
      const who = directory.get(a.win) || null;
      const open = isAssocOpen(store, a.win);
      const label = who?.name ? escapeHtml(who.name) : escapeHtml(a.win);
      const title = who?.title ? `<span class="vizpick-assoc-title">${escapeHtml(who.title)}</span>` : "";
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
                <span class="vizpick-assoc-name">${label}</span>
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
      sourceUpdate: snap?.sourceUpdate ?? null,
      capturedAt: r?.capturedAt ?? snap?.capturedAt ?? null,
      isToday: activeTab === "today",
      market: r?.market ?? selectedMarket ?? null,
    };
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
    return (win) => directory.get(win)?.name ?? null;
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
            <div class="vizpick-store-card-num">#${escapeHtml(r.store)}${
              isHome ? `<span class="vizpick-home-chip" title="Your home store, from Settings > Defaults">yours</span>` : ""
            }</div>
            <div class="vizpick-store-card-sub">${sub}</div>
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
    const clean = !dbg || dbg.ok;

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

  // 8. Cleanup — MUST be called by shell when navigating away.
  return () => {
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
