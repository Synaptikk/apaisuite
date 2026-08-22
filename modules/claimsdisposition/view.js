// modules/claimsdisposition/view.js
//
// ClaimsDisposition UI controller. Mounted by the shell on #/claimsdisposition.
//
// Data path (post-merge):
//   1. On mount: read latest pull from IndexedDB (lib/db.js).
//   2. If present → materialize canonical records via loadDatasetFromPull
//      and render.
//   3. If absent → auto-trigger the SW's `pull` handler. The progress bar
//      slot above #cd-content shows live status (subscribed via
//      chrome.storage.onChanged on "claimsdisposition.progress"). On
//      completion, reload from IndexedDB and re-render.
//
// The dashboard's 9 visualisation components are unchanged — they consume
// canonical records and don't care about the data source.
//
// Ported from React+Vite donor at Trey/ClaimsDisposition/src/App.jsx; React
// state/effect hooks → tiny imperative setState that fans out update(state)
// to each component.

import { loadDatasetFromPull }     from "./lib/load.js";
import { getDateRange,
         formatDateFmt }           from "./lib/dates.js";
import { getPullById,
         listPulls }               from "./lib/db.js";
import { getUserHomeStore,
         getUserHomeMarket }       from "../../shared/userStore.js";
import { getMarketRoster }         from "../../shared/marketRoster.js";

import { createHeader }            from "./components/header.js";
import { createFilterBar }         from "./components/filterBar.js";
import { createSummaryCards }      from "./components/summaryCards.js";
import { createMarketCharts }      from "./components/marketCharts.js";
import { createStoreTable }        from "./components/storeTable.js";
import { createTimeOfDay }         from "./components/timeOfDay.js";
import { createDayOfWeek }         from "./components/dayOfWeek.js";
import { createOutlierPanel,
         filteredOutlierCount }    from "./components/outlierPanel.js";
import { createDetailDrawer }      from "./components/detailDrawer.js";

const NUMBER_FMT = new Intl.NumberFormat("en-US");
const PROGRESS_KEY = "claimsdisposition.progress";
// chrome.storage.sync key for the user's preferred store roster.
// Sync (not local) so the list survives a profile rebuild AND follows
// the user across Edge profiles on a fresh laptop. Payload is tiny
// (~10 ints, well under the 8KB per-item sync quota).
const USER_STORES_KEY = "claimsdisposition.userStores";

export async function mount(host, container) {
  // ── Inject stylesheet (shell wraps in .module-claimsdisposition) ──
  const styleLink = document.createElement("link");
  styleLink.rel = "stylesheet";
  styleLink.href = chrome.runtime.getURL("modules/claimsdisposition/styles.css");
  document.head.appendChild(styleLink);

  // ── Pull the static markup shell ──
  const viewHtmlUrl = chrome.runtime.getURL("modules/claimsdisposition/view.html");
  const html = await (await fetch(viewHtmlUrl)).text();
  container.innerHTML = html;

  const $ = (id) => container.querySelector(`#${id}`);
  const els = {
    header:        $("cd-header"),
    dataSource:    $("cd-data-source"),
    progress:      $("cd-progress"),
    filters:       $("cd-filters"),
    loading:       $("cd-loading"),
    error:         $("cd-error"),
    content:       $("cd-content"),
    summary:       $("cd-summary"),
    marketCharts:  $("cd-market-charts"),
    storeTable:    $("cd-store-table"),
    timeOfDay:     $("cd-time-of-day"),
    dayOfWeek:     $("cd-day-of-week"),
    outlierPanel:  $("cd-outlier-panel"),
    drawerHost:    $("cd-drawer-host"),
  };

  // Flagged true by the cleanup function — checked after every await that
  // could return after the user navigated away, so we never write to DOM
  // nodes the shell has detached or call .update() on destroyed components.
  let cancelled = false;

  // ── State ─────────────────────────────────────────────────────
  let state = {
    records: [],
    realStoreNumbers: [],
    loading: true,
    error: null,
    filters: {
      storeNumbers: [],
      dateRange: { from: null, to: null },
      dispositionTypes: [],
      departments: [],
      severity: null,
    },
    selectedStore: null,

    // Pull state (only used by the data-source picker + progress bar).
    pullsIndex:      [],     // summaries from db.listPulls()
    selectedPullId:  null,   // pullId currently rendered, or null when empty
    inFlightPull:    false,  // SW pull in progress
    pullDays:        30,
    // Empty until the async read of chrome.storage.sync (kicked off below)
    // replaces it with the user's saved roster, or — for first-run users —
    // with getDefaultRoster(). This used to seed a literal 10-store list,
    // which meant a first-run analyst in another market saw someone else's
    // stores selected for a few hundred ms and could pull them by reflex.
    pullStores:      new Set(),
  };

  // Whichever roster the user gets seeded with on first run is also what
  // "Reset to default" returns to. Their home market's roster first (a
  // market-level user wants the whole market), then their own store, then
  // nothing — an empty picker asks a question; a wrong one answers it.
  // Memoized on first read.
  let defaultRosterCache = null;
  async function getDefaultRoster() {
    if (defaultRosterCache) return defaultRosterCache;
    const [market, detected] = await Promise.all([
      getUserHomeMarket().catch(() => null),
      getUserHomeStore().catch(() => null),
    ]);
    const roster = market ? getMarketRoster(market) : null;
    defaultRosterCache = roster?.length ? roster.slice()
                       : detected      ? [Number(detected)]
                       : [];
    return defaultRosterCache;
  }

  // Read saved store roster from chrome.storage.sync. If present, override
  // the default; if absent (first run on this profile), use getDefaultRoster().
  // Persist whichever default we pick so the user can edit subsequently — but
  // only when it's non-empty, so an unidentifiable user isn't handed a saved
  // empty roster they then have to notice and undo.
  chrome.storage.sync.get(USER_STORES_KEY).then(async (got) => {
    if (cancelled) return;
    const saved = got?.[USER_STORES_KEY];
    if (Array.isArray(saved) && saved.length) {
      setState({ pullStores: new Set(saved.map(Number).filter(Number.isFinite)) });
      return;
    }
    const seed = await getDefaultRoster();
    if (cancelled) return;
    setState({ pullStores: new Set(seed) });
    if (seed.length) {
      chrome.storage.sync.set({ [USER_STORES_KEY]: [...seed] }).catch(() => {});
    }
  }).catch((e) => console.warn("[claimsdisposition] couldn't read saved stores:", e?.message));

  // Persist any change to the store roster.
  function persistStores(stores) {
    const list = [...stores].map(Number).sort((a, b) => a - b);
    chrome.storage.sync.set({ [USER_STORES_KEY]: list }).catch((e) => {
      console.warn("[claimsdisposition] couldn't save store roster:", e?.message);
    });
  }

  // ── Visualisation component instances ─────────────────────────
  const headerCmp       = createHeader();
  const filterBarCmp    = createFilterBar({ onChange: (filters) => setState({ filters }) });
  const summaryCmp      = createSummaryCards({
    getFilteredOutlierCount: (s) => filteredOutlierCount(s),
  });
  const marketChartsCmp = createMarketCharts();
  const storeTableCmp   = createStoreTable({ onSelectStore: (sn) => setState({ selectedStore: sn }) });
  const timeOfDayCmp    = createTimeOfDay();
  const dayOfWeekCmp    = createDayOfWeek();
  const outlierCmp      = createOutlierPanel({ onSelectStore: (sn) => setState({ selectedStore: sn }) });
  const drawerCmp       = createDetailDrawer({
    onClose: () => setState({ selectedStore: null }),
  });

  els.header.replaceWith(headerCmp.root);
  els.filters.replaceWith(filterBarCmp.root);
  els.summary.appendChild(summaryCmp.root);
  els.marketCharts.appendChild(marketChartsCmp.root);
  els.storeTable.appendChild(storeTableCmp.root);
  els.timeOfDay.appendChild(timeOfDayCmp.root);
  els.dayOfWeek.appendChild(dayOfWeekCmp.root);
  els.outlierPanel.appendChild(outlierCmp.root);
  els.drawerHost.appendChild(drawerCmp.root);

  const components = [
    headerCmp, filterBarCmp, summaryCmp, marketChartsCmp,
    storeTableCmp, timeOfDayCmp, dayOfWeekCmp, outlierCmp, drawerCmp,
  ];

  // ── Single source of truth for state changes ──────────────────
  function setState(patch) {
    state = { ...state, ...patch };
    syncShellChrome();
    renderDataSource();
    for (const c of components) c.update?.(state);
  }

  function syncShellChrome() {
    els.loading.classList.toggle("cd-hidden", !state.loading);
    els.error.classList.toggle("cd-hidden", !state.error);
    els.content.classList.toggle("cd-hidden", state.loading || !!state.error);
    if (state.error) els.error.textContent = `Failed to load data: ${state.error}`;
  }

  // ── Data-source picker (lives above the filter bar) ───────────
  // Renders a small toolbar:
  //   Source ▼   Days ▼  [Pull]  [Download CSVs]
  // The source dropdown lists the user's IndexedDB pull history; changing
  // it re-loads records from that pull. Pull triggers a SW handler call
  // and the progress bar takes over until completion.
  function renderDataSource() {
    els.dataSource.innerHTML = "";

    // Source picker.
    const sourceWrap = document.createElement("label");
    sourceWrap.className = "cd-field cd-inline";
    sourceWrap.innerHTML = `<span class="cd-field-label">Source</span>`;
    const sourceSel = document.createElement("select");
    sourceSel.className = "cd-select";
    if (!state.pullsIndex.length) {
      const opt = document.createElement("option");
      opt.textContent = state.inFlightPull ? "Pulling…" : "No pulls yet";
      opt.disabled = true;
      sourceSel.appendChild(opt);
      sourceSel.disabled = true;
    } else {
      for (const p of state.pullsIndex) {
        const opt = document.createElement("option");
        opt.value = p.pullId;
        opt.textContent = pullLabel(p);
        if (p.pullId === state.selectedPullId) opt.selected = true;
        sourceSel.appendChild(opt);
      }
    }
    sourceSel.addEventListener("change", () => switchPull(sourceSel.value));
    sourceWrap.appendChild(sourceSel);

    // Days selector (drives the next Pull's date range).
    const daysWrap = document.createElement("label");
    daysWrap.className = "cd-field cd-inline";
    daysWrap.innerHTML = `<span class="cd-field-label">Pull range</span>`;
    const daysSel = document.createElement("select");
    daysSel.className = "cd-select";
    for (const n of [7, 14, 30, 60, 90]) {
      const opt = document.createElement("option");
      opt.value = n; opt.textContent = `Last ${n} days`;
      if (n === state.pullDays) opt.selected = true;
      daysSel.appendChild(opt);
    }
    daysSel.addEventListener("change", () => setState({ pullDays: Number(daysSel.value) }));
    daysWrap.appendChild(daysSel);

    // Pull button.
    const pullBtn = document.createElement("button");
    pullBtn.className = "cd-btn cd-btn-primary";
    pullBtn.textContent = state.inFlightPull ? "Pulling…" : "Pull";
    pullBtn.disabled = state.inFlightPull;
    pullBtn.addEventListener("click", () => doPull());

    // Download CSVs button (uses the currently selected pull, NOT the most
    // recent — so a user reviewing an old pull can export it directly).
    const dlBtn = document.createElement("button");
    dlBtn.className = "cd-btn";
    dlBtn.textContent = "Download CSVs";
    dlBtn.disabled = !state.selectedPullId || state.inFlightPull;
    dlBtn.addEventListener("click", () => doDownload());

    els.dataSource.append(sourceWrap, daysWrap, pullBtn, dlBtn);

    // ── Stores row (chips + add + reset, persisted to chrome.storage.sync) ──
    const storesRow = document.createElement("div");
    storesRow.className = "cd-stores-row";

    const storesLabel = document.createElement("span");
    storesLabel.className = "cd-field-label";
    storesLabel.textContent = `Stores (${state.pullStores.size})`;
    storesRow.appendChild(storesLabel);

    const chipsWrap = document.createElement("div");
    chipsWrap.className = "cd-stores-chips";
    const sorted = [...state.pullStores].sort((a, b) => Number(a) - Number(b));
    for (const sn of sorted) {
      const chip = document.createElement("span");
      chip.className = "cd-store-chip";
      chip.innerHTML = `<span>${sn}</span><button type="button" class="cd-store-chip-x" aria-label="Remove store ${sn}" title="Remove ${sn}">×</button>`;
      chip.querySelector(".cd-store-chip-x").addEventListener("click", () => {
        const next = new Set(state.pullStores);
        next.delete(sn);
        persistStores(next);
        setState({ pullStores: next });
      });
      chipsWrap.appendChild(chip);
    }
    if (sorted.length === 0) {
      const empty = document.createElement("span");
      empty.className = "cd-muted";
      empty.style.fontSize = "var(--fs-sm)";
      empty.textContent = "No stores — add one to enable Pull";
      chipsWrap.appendChild(empty);
    }
    storesRow.appendChild(chipsWrap);

    const addInput = document.createElement("input");
    addInput.type = "text";
    addInput.inputMode = "numeric";
    addInput.placeholder = "Add store #";
    addInput.maxLength = 6;
    addInput.className = "cd-input cd-store-add-input";

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "cd-btn";
    addBtn.textContent = "Add";

    function tryAdd() {
      const raw = addInput.value.trim();
      const n = Number(raw);
      if (!raw || !Number.isFinite(n) || n <= 0) return;
      const next = new Set(state.pullStores);
      next.add(n);
      persistStores(next);
      addInput.value = "";
      setState({ pullStores: next });
    }
    addBtn.addEventListener("click", tryAdd);
    addInput.addEventListener("keydown", (e) => { if (e.key === "Enter") tryAdd(); });

    storesRow.appendChild(addInput);
    storesRow.appendChild(addBtn);

    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "cd-btn cd-btn-link";
    resetBtn.textContent = "Reset to default";
    resetBtn.title = defaultRosterCache
      ? `Restore the default roster: ${defaultRosterCache.join(", ")}`
      : "Restore the default roster";
    resetBtn.addEventListener("click", async () => {
      const seed = await getDefaultRoster();
      const next = new Set(seed);
      persistStores(next);
      setState({ pullStores: next });
    });
    storesRow.appendChild(resetBtn);

    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "cd-btn cd-btn-link";
    clearBtn.textContent = "Clear all";
    clearBtn.addEventListener("click", () => {
      if (!confirm("Remove every store from the Pull roster?")) return;
      const next = new Set();
      persistStores(next);
      setState({ pullStores: next });
    });
    storesRow.appendChild(clearBtn);

    els.dataSource.appendChild(storesRow);
  }

  function pullLabel(p) {
    const when = new Date(p.pulledAt);
    const date = formatDateFmt(when, "MMM d, yyyy");
    const hr   = String(when.getHours()).padStart(2, "0");
    const mn   = String(when.getMinutes()).padStart(2, "0");
    const rows = NUMBER_FMT.format(p.totalRows ?? 0);
    return `${date} ${hr}:${mn} · ${rows} rows · last ${p.days}d`;
  }

  // ── Progress bar ──────────────────────────────────────────────
  // Reads from the same chrome.storage.session doc the SW writes. Hidden
  // by default; appears whenever the doc has a non-null pullId and the
  // pull hasn't finished + 2s grace. (We keep it visible briefly after
  // completion so the user sees the bar fill to 100% instead of vanishing
  // the moment the last fetch returns.)
  let progressHideTimer = null;
  function renderProgress(doc) {
    if (!doc) {
      els.progress.classList.add("cd-hidden");
      els.progress.innerHTML = "";
      return;
    }
    const done = doc.doneCount ?? 0;
    const total = doc.total ?? 1;
    const pct = Math.round((done / total) * 100);
    const current = Object.entries(doc.stores ?? {})
      .find(([, s]) => s.status === "fetching")?.[0];

    els.progress.classList.remove("cd-hidden");
    els.progress.innerHTML = `
      <div class="cd-progress-row">
        <span class="cd-progress-label">
          ${doc.finishedAt ? "Pull complete" : "Pulling claims data…"}
          <strong>${done} / ${total} stores</strong>
          · ${pct}%
        </span>
        <button type="button" class="cd-progress-details cd-btn cd-btn-xs">Details</button>
      </div>
      <div class="cd-progress-bar"><div class="cd-progress-fill" style="width:${pct}%"></div></div>
      <div class="cd-progress-current">${current ? `currently fetching store ${current}` : ""}</div>
      <div class="cd-progress-detailsbox cd-hidden"></div>
    `;
    const detailsBtn = els.progress.querySelector(".cd-progress-details");
    const detailsBox = els.progress.querySelector(".cd-progress-detailsbox");
    detailsBtn.addEventListener("click", () => {
      detailsBox.classList.toggle("cd-hidden");
      renderProgressDetails(detailsBox, doc);
    });

    if (doc.finishedAt) {
      // Auto-hide 2s after completion. On click of Details we cancel this
      // so a curious user can keep the panel open.
      clearTimeout(progressHideTimer);
      progressHideTimer = setTimeout(() => {
        els.progress.classList.add("cd-hidden");
      }, 2000);
      detailsBtn.addEventListener("click", () => clearTimeout(progressHideTimer));
    }
  }

  function renderProgressDetails(box, doc) {
    if (!doc?.stores) { box.textContent = ""; return; }
    box.innerHTML = "";
    for (const [store, s] of Object.entries(doc.stores)) {
      const row = document.createElement("div");
      row.className = "cd-progress-detail-row";
      const parts = [];
      if (s.totalCount != null) parts.push(`${NUMBER_FMT.format(s.totalCount)} rows`);
      if (s.ms != null)         parts.push(`${(s.ms / 1000).toFixed(1)}s`);
      if (s.warning)            parts.push(`⚠ ${s.warning.slice(0, 60)}`);
      if (s.error)              parts.push(s.error.slice(0, 60));
      row.innerHTML = `
        <span class="cd-progress-detail-store">${store}</span>
        <span class="cd-progress-detail-meta">${parts.join(" · ") || "—"}</span>
        <span class="cd-progress-detail-status cd-progress-detail-${s.status}">${s.status}</span>
      `;
      box.appendChild(row);
    }
  }

  // ── Pull → render flow ────────────────────────────────────────
  async function doPull() {
    if (state.inFlightPull) return;

    // The cold-start auto-pull can fire before the async roster read below
    // has landed, and the state seed is deliberately empty. Resolve the
    // default here rather than shipping an empty `stores` the SW rejects.
    let stores = [...state.pullStores];
    if (!stores.length) {
      stores = await getDefaultRoster();
      if (cancelled) return;
      if (stores.length) setState({ pullStores: new Set(stores) });
    }
    if (!stores.length) {
      setState({
        loading: false,
        error: "No stores selected. Pick stores above, or set your home market in Settings > Defaults.",
      });
      return;
    }

    setState({ inFlightPull: true });
    try {
      const resp = await sendSW("pull", {
        stores,
        days:   state.pullDays,
      }, 600_000);
      // If the view was unmounted mid-pull, bail before touching DOM /
      // setState — otherwise we'd write to nodes the shell has already
      // detached and call component update() methods on destroyed instances.
      if (cancelled) return;
      if (!resp.ok) {
        // SW already attempted autonomous reauth (reload embed tab and
        // re-run the per-store loop). If we still got an auth failure,
        // surface it as a passive status — no "click here" prompt; the
        // next dashboard mount will retry automatically.
        const msg = resp.authFailure
          ? `Looker auth still failing after ${resp.reauthAttempts ?? 0} background retries. Will retry on next dashboard refresh.`
          : `pull failed: ${resp.error}`;
        setState({ inFlightPull: false, error: msg });
        return;
      }
      // Re-list pulls, switch to the new one, materialize records.
      const pulls = await listPulls();
      if (cancelled) return;
      setState({ pullsIndex: pulls, inFlightPull: false });
      await switchPull(resp.pullId);
    } catch (e) {
      if (cancelled) return;
      console.error("[claimsdisposition] pull threw:", e);
      setState({ inFlightPull: false, error: String(e?.message ?? e) });
    }
  }

  async function doDownload() {
    if (!state.selectedPullId) return;
    try {
      const resp = await sendSW("downloadCsv", { pullId: state.selectedPullId });
      if (!resp.ok) {
        console.warn("[claimsdisposition] downloadCsv failed:", resp.error);
        return;
      }
      const wrote   = resp.results.filter((x) => x.downloadId).length;
      const skipped = resp.results.filter((x) => x.skipped).length;
      console.log(`[claimsdisposition] wrote ${wrote} CSV(s) to ~/Downloads/APAISuite-claims/${skipped ? ` (${skipped} skipped)` : ""}`);
    } catch (e) {
      console.error("[claimsdisposition] download threw:", e);
    }
  }

  // Load a specific pull from IndexedDB and re-render the dashboard.
  // Filters that reference data in the OLD pull (store numbers, departments,
  // disposition types) are reset on switch — otherwise a user who had Store
  // 669 filtered on pull A and switches to pull B that doesn't include 669
  // sees an empty dashboard with no obvious cause.
  //
  // Performance: each step is timed in the console because the donor
  // dashboard was sized for one store (~22k rows) and a full live pull
  // multiplies that by ~8x (~186k rows). The longest task is materializing
  // canonical records from the raw row dicts (date parsing dominates). We
  // bracket the work with a loading state + an rAF yield so the spinner
  // actually paints before the main thread becomes unresponsive — the user
  // sees feedback instead of perceiving the page as frozen.
  async function switchPull(pullId) {
    if (!pullId) return;
    setState({ loading: true });
    // Yield so the spinner paints before we monopolize the main thread.
    await new Promise((r) => requestAnimationFrame(() => r()));
    if (cancelled) return;

    const t0 = performance.now();
    const pull = await getPullById(pullId);
    const tDb = performance.now() - t0;
    if (cancelled) return;
    if (!pull) {
      console.warn(`[claimsdisposition] pull ${pullId} not found in IndexedDB`);
      setState({ loading: false });
      return;
    }

    const t1 = performance.now();
    const { records, realStoreNumbers } = loadDatasetFromPull(pull);
    const tParse = performance.now() - t1;

    const t2 = performance.now();
    const { min, max } = getDateRange(records);
    // Pull-record meta (pulledAt, startDate, endDate) flows into state so
    // the PDF generator can stamp the cover page with the live-pull
    // timestamp and source range.
    const sourcePullMeta = {
      pullId:    pull.pullId,
      pulledAt:  pull.pulledAt,
      startDate: pull.startDate,
      endDate:   pull.endDate,
      days:      pull.days,
      // Null on pulls taken before the field existed; the PDF omits the
      // market line rather than printing a market this data isn't from.
      marketNumber: pull.marketNumber ?? null,
    };
    setState({
      records,
      realStoreNumbers,
      selectedPullId: pullId,
      sourcePullMeta,
      cvpByStore: pull.cvp?.byStore || null,
      cvpMeta:    pull.cvp ? { latestWeek: pull.cvp.latestWeek, fetchedAt: pull.cvp.fetchedAt } : null,
      loading: false,
      filters: {
        storeNumbers:     [],
        dateRange:        { from: min, to: max },
        dispositionTypes: [],
        departments:      [],
        severity:         null,
      },
      selectedStore: null,
    });
    const tRender = performance.now() - t2;
    console.log(`[claimsdisposition] switchPull ${pullId}: ${NUMBER_FMT.format(records.length)} records · ${realStoreNumbers.length} stores · ${min?.toISOString().slice(0, 10)} → ${max?.toISOString().slice(0, 10)} · timings: idb=${tDb.toFixed(0)}ms parse=${tParse.toFixed(0)}ms render=${tRender.toFixed(0)}ms total=${(performance.now() - t0).toFixed(0)}ms`);
  }

  // ── chrome.storage.session subscription for live progress ─────
  // The SW writes "claimsdisposition.progress" on each per-store tick.
  // storage.onChanged is more reliable than chrome.runtime.sendMessage
  // broadcasts from a busy SW — the latter were observed dropping events
  // during chrome.scripting.executeScript work.
  const onStorageChanged = (changes, area) => {
    if (area !== "session") return;
    if (!changes[PROGRESS_KEY]) return;
    renderProgress(changes[PROGRESS_KEY].newValue);
  };
  chrome.storage.onChanged.addListener(onStorageChanged);

  // Pick up any in-flight pull doc on mount (user may have navigated away
  // mid-pull and come back). If the doc references a pullId that ALREADY
  // exists in IndexedDB, the SW completed the pull but died before writing
  // `finishedAt` to the progress doc (or the storage event was missed
  // across a reload). In that case the pull is effectively finished —
  // synthesize a `finishedAt` so the progress bar renders 100% and auto-
  // hides, rather than freezing at the last partial state.
  chrome.storage.session.get(PROGRESS_KEY).then(async (s) => {
    const doc = s?.[PROGRESS_KEY];
    if (!doc || doc.finishedAt) return;
    const existing = await getPullById(doc.pullId).catch(() => null);
    if (cancelled) return;
    if (existing) {
      renderProgress({ ...doc, finishedAt: existing.pulledAt ?? Date.now() });
    } else {
      renderProgress(doc);
    }
  }).catch(() => {});

  // ── Initial load ──────────────────────────────────────────────
  try {
    const pulls = await listPulls();
    if (cancelled) return () => {};
    const latest = pulls[0] ? await getPullById(pulls[0].pullId) : null;
    if (cancelled) return () => {};
    setState({ pullsIndex: pulls });
    if (latest) {
      // History exists → render from the latest pull. No network call.
      await switchPull(latest.pullId);
    } else {
      // Cold start with empty DB → auto-pull. The SW handles autonomous
      // reauth (reload embed tab + retry) so a sleeping Google session is
      // recovered without any user action. If the SW's reauth attempts
      // exhaust, the resulting error is shown passively below — no
      // "click here" prompt; the next dashboard mount will simply try
      // again.
      console.log("[claimsdisposition] no pulls in IndexedDB; auto-pulling…");
      setState({ loading: true });
      await doPull();
    }
  } catch (err) {
    if (cancelled) return () => {};
    console.error("[claimsdisposition] initial load failed:", err);
    setState({ loading: false, error: String(err?.message ?? err) });
  }

  // ── Cleanup contract ──────────────────────────────────────────
  return async () => {
    cancelled = true;
    clearTimeout(progressHideTimer);
    chrome.storage.onChanged.removeListener(onStorageChanged);
    for (const c of components) c.destroy?.();
    styleLink.remove();
  };
}

// Send a typed message to the SW dispatcher. Uses host.messaging if
// available; falls back to direct chrome.runtime.sendMessage so this view
// works in environments where the shell injected a stripped-down host.
function sendSW(type, payload = {}, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`claimsdisposition.${type} timed out after ${timeoutMs}ms`)), timeoutMs);
    chrome.runtime.sendMessage(
      { module: "claimsdisposition", type, ...payload },
      (resp) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!resp) return reject(new Error(`no response from claimsdisposition.${type}`));
        resolve(resp);
      }
    );
  });
}
