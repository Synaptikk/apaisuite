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

// Goals published on the Tableau VizPick dashboard. These are shown as the
// caption under each gauge so the official target stays visible — they do NOT
// drive the colour. Colour uses the absolute 98/95/90 bands in
// lib/charts.js::bandFor, which apply to every percentage alike.
const GOALS = {
  casesSeenPct: 95,
  locationPct:  95,
  pickPct:      90,
  overstockPct: 90,
};

// The two tabs are backed by two different Tableau views with different
// capabilities — see lib/sources/vizpick_today_tableau.js.
const TABS = {
  yesterday: {
    label: "Yesterday",
    note: "Source: the VizPick summary view, which Tableau refreshes once daily for the day prior.",
  },
  today: {
    label: "Today — Live",
    note: "Source: the VizPick Details view, refreshed through the current business day. Tableau warns it can run 1–2 hours behind upstream systems.",
  },
};

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
const UI_PREFS_KEY = "vizpick.ui.v1";

const SORTS = {
  "store-asc":  { label: "Store number — low to high",  cmp: (a, b) => storeNum(a) - storeNum(b) },
  "store-desc": { label: "Store number — high to low",  cmp: (a, b) => storeNum(b) - storeNum(a) },
  "score-desc": { label: "Total score — high to low",   cmp: (a, b) => score(b) - score(a) },
  "score-asc":  { label: "Total score — low to high",   cmp: (a, b) => score(a) - score(b) },
};

function storeNum(r) {
  const n = Number(r.store);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}
// "Total score" is the VizPick composite. Stores missing it (a Today card
// whose donut-health export failed) sort last in both directions rather than
// being treated as a 0, which would fake a terrible score.
function score(r) {
  return Number.isFinite(r.vizpick) ? r.vizpick : -Infinity;
}

export async function mount(host, container) {
  // 1. Inject module CSS (removed on unmount).
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = host.url("styles.css");
  link.dataset.module = host.id;
  document.head.appendChild(link);

  // 2. Load view.html into the container.
  const resp = await fetch(host.url("view.html"));
  container.innerHTML = await resp.text();

  // 3. Grab handles.
  const btnRefresh   = container.querySelector('[data-action="refresh"]');
  const btnLoadToday = container.querySelector('[data-action="load-today"]');
  const btnCancel    = container.querySelector('[data-action="cancel-today"]');
  const btnResetOrder = container.querySelector('[data-action="reset-order"]');
  const sortSelect    = container.querySelector("[data-sort-select]");
  const marketSelect = container.querySelector("[data-market-select]");

  let state = null;
  let selectedMarket = null;
  let marketIsUserSet = false;
  let activeTab = "yesterday";
  // Card ordering. `sortMode` is one of the SORTS keys; `customOrder` maps a
  // market to the store order the user dragged into place. Both persist so an
  // arrangement survives closing the module.
  let sortMode = "store-asc";
  let customOrder = {};
  let dragStore = null;

  let homeMarket = await getUserHomeMarket();

  // Restore saved sort/order before the first paint so cards never flash in
  // one order and then jump to another.
  await loadUiPrefs();

  // 4. Wire handlers.
  btnRefresh.addEventListener("click", runRefresh);
  btnLoadToday.addEventListener("click", runToday);
  btnCancel.addEventListener("click", () => host.messaging.send("cancel_today").catch(() => {}));
  btnResetOrder.addEventListener("click", async () => {
    if (selectedMarket) delete customOrder[selectedMarket];
    sortMode = "store-asc";
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

  container.querySelectorAll("[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeTab = btn.dataset.tab;
      render();
    });
  });

  // ── Drag to rearrange ────────────────────────────────────────────
  // Uses native HTML5 drag-and-drop on the cards. Dropping commits the new
  // order, switches the sort control to "custom", and persists it.
  const grid = container.querySelector("[data-store-cards]");

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

  // 7. Follow the Settings → Defaults home market unless the user picked one.
  const unsubMarket = onUserMarketChange((m) => {
    homeMarket = m;
    if (!marketIsUserSet) {
      selectedMarket = null;
      render();
    }
  });

  // ── Actions ─────────────────────────────────────────────────────
  async function runRefresh() {
    setBusy(btnRefresh, true);
    try {
      await host.messaging.send("pull_stores");
    } catch (e) {
      console.warn("[vizpick] pull_stores failed:", e?.message ?? e);
    } finally {
      setBusy(btnRefresh, false);
      await paint();
    }
  }

  async function runToday() {
    const stores = yesterdayRows().map((r) => r.store);
    if (!stores.length) {
      renderTodayBar(null, "Refresh the Yesterday tab first — it supplies the store list for this market.");
      return;
    }
    btnLoadToday.disabled = true;
    btnCancel.hidden = false;
    try {
      await host.messaging.send("pull_today", { stores, market: selectedMarket });
    } catch (e) {
      console.warn("[vizpick] pull_today failed:", e?.message ?? e);
    } finally {
      btnLoadToday.disabled = false;
      btnCancel.hidden = true;
      await paint();
    }
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

  function yesterdayRows() {
    const all = state?.yesterday?.rows || state?.rows || [];
    return selectedMarket ? all.filter((r) => r.market === selectedMarket) : [];
  }

  function todayRows() {
    // Today rows carry no market/BU/region of their own (the Details export
    // has no such columns), so they're joined back onto the yesterday roster
    // by store number — which is also what scoped the capture.
    const today = state?.today?.rows || [];
    if (!today.length) return [];
    const roster = new Map(yesterdayRows().map((r) => [r.store, r]));
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
    return activeTab === "today" ? todayRows() : yesterdayRows();
  }

  function activeSnapshot() {
    return activeTab === "today" ? state?.today : (state?.yesterday || null);
  }

  function render() {
    if (!state) return;
    paintMarketOptions();
    paintTabs();
    paintUpdatedBar();
    paintTodayBar();

    const rows = rowsForActiveTab();
    const meta = container.querySelector("[data-picker-meta]");
    if (meta) meta.textContent = rows.length ? `${rows.length} store${rows.length === 1 ? "" : "s"}` : "";

    renderGauges(rows);
    renderStoreCards(rows);
    paintDebug();
  }

  function paintMarketOptions() {
    const all = state?.yesterday?.rows || state?.rows || [];
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
    for (const key of Object.keys(TABS)) {
      const btn = container.querySelector(`[data-tab="${key}"]`);
      if (btn) btn.setAttribute("aria-selected", String(key === activeTab));
      const dateEl = container.querySelector(`[data-tab-date="${key}"]`);
      if (dateEl) {
        const snap = key === "today" ? state?.today : state?.yesterday;
        dateEl.textContent = snap ? dataDateLabel(key, snap) : "no data";
      }
    }
  }

  // What calendar day does each tab's data actually describe?
  //   Today     → the source stamp's own day.
  //   Yesterday → the day BEFORE the source stamp, because that view is
  //               "refreshed daily for the day prior".
  function dataDateLabel(key, snap) {
    const iso = snap?.sourceUpdate?.iso;
    if (!iso) return snap?.capturedAt ? "date unknown" : "no data";
    const d = new Date(iso);
    if (key === "yesterday") d.setDate(d.getDate() - 1);
    return d.toLocaleDateString(undefined, { weekday: "short", month: "numeric", day: "numeric" });
  }

  // Tableau's own "Last update" stamp, rendered in the Market Average header.
  // Format follows the source's precision: the Details view publishes a full
  // timestamp, the summary view only a date — we never invent a clock time to
  // fill the gap. The source note and relative age move to the tooltip so the
  // header stays a single scannable line.
  function paintUpdatedBar() {
    const absEl   = container.querySelector("[data-updated-abs]");
    const freshEl = container.querySelector('[data-freshness="stores"]');
    if (absEl) {
      const snap = activeSnapshot();
      const su = snap?.sourceUpdate;
      const note = TABS[activeTab].note;

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

    const inFlight = state?.todayProgress;
    if (inFlight && inFlight.total) { renderTodayBar(inFlight); return; }

    const n = todayRows().length;
    const roster = yesterdayRows().length;
    const partial = state?.today?.partial;
    renderTodayBar(
      null,
      n
        ? `Showing ${n} of ${roster} stores in this market.` +
          (partial ? " Some stores could not be captured — see the capture details below." : "") +
          " Today is captured one store at a time, so reloading takes a few minutes."
        : `Today's numbers come from Tableau's VizPick Details view, which reports one store at a time. ` +
          `Loading this market means ${roster} sequential exports — expect a few minutes.`
    );
  }

  function renderTodayBar(progress, message) {
    const statusEl = container.querySelector("[data-today-status]");
    if (!statusEl) return;
    if (progress && progress.total) {
      const { done, total, store } = progress;
      statusEl.innerHTML =
        `<strong>Capturing today — ${done} of ${total} stores</strong>` +
        (store ? ` <span class="vizpick-muted">(store ${escapeHtml(store)})</span>` : "") +
        `<div class="vizpick-progress"><div class="vizpick-progress-fill" style="width:${Math.round((done / total) * 100)}%"></div></div>`;
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
        ? `${TABS[activeTab].label} · Market ${selectedMarket ?? "—"} · mean of ${rows.length} store${rows.length === 1 ? "" : "s"}`
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
      // The composite is a 0-100 score, not a percentage, so it stays neutral.
      { key: "vizpick",      label: "VizPick Health", goal: undefined, neutral: true },
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
        return gaugeSvg(v, { goal: g.goal, label: g.label, neutral: g.neutral, fmt: (x) => Math.round(x).toString() });
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
    // The VizPick composite is a 0-100 score, not a percentage against the
    // 98/95/90 bands, so its ring stays neutral blue.
    const gauge = Number.isFinite(r.vizpick)
      ? gaugeSvg(r.vizpick, { size: 96, thickness: 10, label: "", neutral: true, fmt: (v) => Math.round(v).toString() })
      : `<div class="vizpick-card-nohealth" title="No VizPick composite score for this store">—</div>`;

    // `ratio` is a REAL numerator/denominator pair from the export — never a
    // figure derived by dividing a rounded percentage. See the note at the top
    // of lib/parse_vizpick_stores_csv.js.
    const metrics = [
      { label: "Cases Seen %", value: r.casesSeenPct, pct: true, fmt: fmtPct, ratio: ratio(r.casesSeen, r.casesExpected) },
      { label: "Location %",   value: r.locationPct,  pct: true, fmt: fmtPct },
      { label: "Pick %",       value: r.pickPct,      pct: true, fmt: fmtPct, ratio: ratio(r.picksCompleted, r.picksSuggested) },
      { label: "Total Picked", value: r.totalPicked,  pct: false, fmt: fmtInt },
      { label: "Overstock %",  value: r.overstockPct, pct: true, fmt: fmtPct },
      { label: "Pallets %",    value: r.palletsPct,   pct: true, fmt: fmtPct, ratio: ratio(r.palletsSeen, r.palletsExpected) },
    ];

    const metricsHtml = metrics
      .filter((m) => Number.isFinite(m.value) || m.ratio)
      .map((m) => `
        <div class="vizpick-store-card-metric">
          <span class="vizpick-store-card-metric-label">${escapeHtml(m.label)}</span>
          <span class="vizpick-store-card-metric-value">
            ${m.ratio ? `<span class="vizpick-ratio">${escapeHtml(m.ratio)}</span>` : ""}
            <strong class="${m.pct ? pctClass(m.value) : ""}">${escapeHtml(m.fmt(m.value))}</strong>
          </span>
        </div>`)
      .join("");

    const sub = `${escapeHtml(r.bu ?? "")}${r.bu ? " · " : ""}${r.region != null && r.region !== "" ? `Region ${escapeHtml(r.region)}` : ""}`;

    // Always expanded — every metric is visible at all times. The card is
    // draggable instead of collapsible.
    return `
      <article class="vizpick-store-card" data-store="${escapeHtml(r.store)}" draggable="true"
               aria-label="Store ${escapeHtml(r.store)} — drag to rearrange">
        <header class="vizpick-store-card-summary">
          <div class="vizpick-store-card-gauge">${gauge}</div>
          <div class="vizpick-store-card-id">
            <div class="vizpick-store-card-num">#${escapeHtml(r.store)}</div>
            <div class="vizpick-store-card-sub">${sub}</div>
          </div>
          <span class="vizpick-store-card-grip" aria-hidden="true" title="Drag to rearrange">⠿</span>
        </header>
        <div class="vizpick-store-card-details">${metricsHtml}</div>
      </article>`;
  }

  function paintDebug() {
    const section = container.querySelector("[data-debug-section]");
    const body    = container.querySelector("[data-debug-body]");
    if (!section || !body) return;
    const dbg = activeTab === "today" ? state?.debugToday : state?.debug;
    if (!dbg || dbg.ok) { section.hidden = true; body.innerHTML = ""; return; }
    section.hidden = false;
    body.innerHTML = renderDebug(dbg);
  }

  function renderDebug(dbg) {
    const parts = [];
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
      if (!p || p.v !== 1) return;
      if (typeof p.sortMode === "string" && (SORTS[p.sortMode] || p.sortMode === "custom")) sortMode = p.sortMode;
      if (p.customOrder && typeof p.customOrder === "object") customOrder = p.customOrder;
    } catch { /* prefs are best-effort */ }
  }

  async function saveUiPrefs() {
    try {
      await chrome.storage.local.set({ [UI_PREFS_KEY]: { v: 1, sortMode, customOrder } });
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
      return list.sort(SORTS["store-asc"].cmp);
    }
    return list.sort((SORTS[sortMode] || SORTS["store-asc"]).cmp);
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

  // Colour band for a percentage. Absolute thresholds shared with the gauge
  // rings (lib/charts.js::bandFor), so text and rings can never disagree.
  function pctClass(value) {
    return bandFor(value)?.cls ?? "";
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
    unsubMarket();
    link.remove();
  };
}
