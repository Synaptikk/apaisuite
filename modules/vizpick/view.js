// modules/vizpick/view.js
//
// Full-page dashboard mount. Loads view.html, wires the Refresh button, the
// Market picker and the Yesterday/Today tabs, subscribes to source_complete
// broadcasts, and re-renders on each update. The Market select is the whole
// point of this module: pick a market once and see every store in it side by
// side, instead of typing store numbers one at a time into Tableau's VizPick
// Details search box.

import { gaugeSvg, bandFor } from "./lib/charts.js";
import { getUserHomeMarket, onUserMarketChange } from "../../shared/userStore.js";

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

  let homeMarket = await getUserHomeMarket();

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

  marketSelect.addEventListener("change", () => {
    selectedMarket = marketSelect.value || null;
    marketIsUserSet = true;
    render();
  });

  // Delegated: the strip is rebuilt on every paint as the history grows.
  container.querySelector("[data-tabs]")?.addEventListener("click", (e) => {
    const btn = e.target?.closest?.("[data-tab]");
    if (!btn) return;
    activeTab = btn.dataset.tab;
    render();
  });

  function expandedSet() {
    const key = selectedMarket ?? "_";
    if (!Array.isArray(expanded[key])) expanded[key] = [];
    return expanded[key];
  }
  function isExpanded(store) { return expandedSet().includes(String(store)); }
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
  const unsubRows = host.messaging.on("today_rows", () => { paint(); });

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
      n
        ? `Showing ${n} of ${roster} stores in this market.` +
          (partial ? " Some stores could not be captured — see the capture details below." : "") +
          " Today is captured one store at a time, so reloading takes a couple of minutes."
        : `Today's numbers come from Tableau's VizPick Details view, which reports one store at a time. ` +
          `Loading this market means ${roster} exports, spread across 3 background tabs — about two minutes.`
    );
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
      btnAll.textContent = rows.some((r) => isExpanded(r.store)) ? "Hide all numbers" : "Show all numbers";
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

    // The four goal metrics, rendered BOTH as small rings beside the composite
    // (mirroring the VizPick dashboard's own layout) and as the text rows
    // below, which are the only place the raw x/y ratios fit.
    const rings = [
      { label: "Cases",     value: r.casesSeenPct, goal: GOALS.casesSeenPct },
      { label: "Locations", value: r.locationPct,  goal: GOALS.locationPct },
      { label: "Picks",     value: r.pickPct,      goal: GOALS.pickPct },
      { label: "Overstock", value: r.overstockPct, goal: GOALS.overstockPct },
    ];
    const ringsHtml = rings
      .map((g) => (Number.isFinite(g.value)
        ? gaugeSvg(g.value, {
            size: 62, thickness: 8, goal: g.goal, label: g.label,
            fmt: (v) => `${Math.round(v)}%`,
          })
        : `<div class="vizpick-gauge">
             <div class="vizpick-minigauge-na">—</div>
             <div class="vizpick-gauge-label">${escapeHtml(g.label)}</div>
           </div>`))
      .join("");

    const metrics = [
      { label: "Cases Seen %", value: r.casesSeenPct, goal: GOALS.casesSeenPct, fmt: fmtPct, ratio: ratio(r.casesSeen, r.casesExpected) },
      { label: "Location %",   value: r.locationPct,  goal: GOALS.locationPct,  fmt: fmtPct },
      { label: "Pick %",       value: r.pickPct,      goal: GOALS.pickPct,      fmt: fmtPct, ratio: ratio(r.picksCompleted, r.picksSuggested) },
      // A COUNT, with no denominator — deliberately. `Total Picked` is not the
      // numerator of Pick %: store 5151 reported Total Picked 611 against a
      // Pick % of 392/603, so dividing 611 by 65% invents a "total" of 940 that
      // describes nothing. The real picks ratio is already on the Pick % row
      // right above it, which is where that question is actually answered.
      { label: "Total Picked", value: r.totalPicked,  goal: null,               fmt: fmtInt },
      { label: "Overstock %",  value: r.overstockPct, goal: GOALS.overstockPct, fmt: fmtPct },
      // No published goal for Pallets %, so it is shown but never judged.
      { label: "Pallets %",    value: r.palletsPct,   goal: null,               fmt: fmtPct, ratio: ratio(r.palletsSeen, r.palletsExpected) },
    ];

    const metricsHtml = metrics
      .filter((m) => Number.isFinite(m.value) || m.ratio)
      .map((m) => `
        <div class="vizpick-store-card-metric">
          <span class="vizpick-store-card-metric-label">${escapeHtml(m.label)}</span>
          <span class="vizpick-store-card-metric-value">
            ${m.ratio ? `<span class="vizpick-ratio"${m.ratioTitle ? ` title="${escapeHtml(m.ratioTitle)}"` : ""}>${escapeHtml(m.ratio)}</span>` : ""}
            <strong class="${m.goal != null ? pctClass(m.value, m.goal) : ""}"
                    title="${m.goal != null ? `Goal ${m.goal}%` : ""}">${escapeHtml(m.fmt(m.value))}</strong>
          </span>
        </div>`)
      .join("");

    const sub = `${escapeHtml(r.bu ?? "")}${r.bu ? " · " : ""}${r.region != null && r.region !== "" ? `Region ${escapeHtml(r.region)}` : ""}`;
    const open = isExpanded(r.store);

    // Store number leads at the top LEFT, with the overall score ring to its
    // right. Only the graphs show by default — the numeric rows are behind a
    // per-card toggle, so a market reads as a wall of rings at a glance.
    return `
      <article class="vizpick-store-card" data-store="${escapeHtml(r.store)}" draggable="true"
               aria-label="Store ${escapeHtml(r.store)} — drag to rearrange">
        <header class="vizpick-store-card-summary">
          <div class="vizpick-store-card-id">
            <div class="vizpick-store-card-num">#${escapeHtml(r.store)}</div>
            <div class="vizpick-store-card-sub">${sub}</div>
          </div>
          <div class="vizpick-store-card-gauge">${gauge}</div>
          <span class="vizpick-store-card-grip" aria-hidden="true" title="Drag to rearrange">⠿</span>
        </header>
        <div class="vizpick-store-card-rings">${ringsHtml}</div>
        <button class="vizpick-card-toggle" data-toggle-store="${escapeHtml(r.store)}"
                aria-expanded="${open}">${open ? "Hide numbers" : "Show numbers"}</button>
        <div class="vizpick-store-card-details"${open ? "" : " hidden"}>${metricsHtml}</div>
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
    } catch { /* prefs are best-effort */ }
  }

  async function saveUiPrefs() {
    try {
      await chrome.storage.local.set({ [UI_PREFS_KEY]: { v: 2, sortMode, customOrder, expanded } });
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
    link.remove();
  };
}
