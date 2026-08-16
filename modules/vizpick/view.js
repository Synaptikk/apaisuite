// modules/vizpick/view.js
//
// Full-page dashboard mount. Loads view.html, wires the Refresh button, the
// Market picker and the Yesterday/Today tabs, subscribes to source_complete
// broadcasts, and re-renders on each update. The Market select is the whole
// point of this module: pick a market once and see every store in it side by
// side, instead of typing store numbers one at a time into Tableau's VizPick
// Details search box.

import { gaugeSvg } from "./lib/charts.js";
import { getUserHomeMarket, onUserMarketChange } from "../../shared/userStore.js";

// Goal thresholds observed live in the Tableau VizPick dashboard
// (Cases/Locations goal 95%, Picks/Overstock goal 90%). VizPick Health
// itself has no published goal ring in Tableau, so it renders neutral blue.
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
  const btnToggleAll = container.querySelector('[data-action="toggle-all"]');
  const marketSelect = container.querySelector("[data-market-select]");

  let state = null;
  let selectedMarket = null;
  let marketIsUserSet = false;
  let activeTab = "yesterday";
  // Per-store collapse state, so a background re-render doesn't re-open a
  // card the user deliberately collapsed. Cards default to OPEN.
  const collapsed = new Set();

  let homeMarket = await getUserHomeMarket();

  // 4. Wire handlers.
  btnRefresh.addEventListener("click", runRefresh);
  btnLoadToday.addEventListener("click", runToday);
  btnCancel.addEventListener("click", () => host.messaging.send("cancel_today").catch(() => {}));
  btnToggleAll.addEventListener("click", () => {
    const rows = rowsForActiveTab();
    const anyOpen = rows.some((r) => !collapsed.has(r.store));
    rows.forEach((r) => (anyOpen ? collapsed.add(r.store) : collapsed.delete(r.store)));
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

  // Track collapse state from the user's own clicks on the native <details>.
  container.addEventListener("toggle", (e) => {
    const d = e.target;
    if (!(d instanceof HTMLElement) || !d.matches(".vizpick-store-card")) return;
    const store = d.dataset.store;
    if (!store) return;
    if (d.open) collapsed.delete(store); else collapsed.add(store);
  }, true);

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
      .map((t) => ({ ...roster.get(t.store), ...projectTodayRow(t) }));
  }

  // Map the Details/current-day fields onto the same shape the cards render.
  // Location % and the VizPick composite have no current-day equivalent in
  // the Details export, so they are explicitly absent rather than faked.
  function projectTodayRow(t) {
    return {
      store:           t.store,
      vizpick:         NaN,
      casesSeenPct:    t.casesSeenPct,
      locationPct:     NaN,
      overstockPct:    NaN,
      pickPct:         t.pickPct,
      totalPicked:     t.totalPicked,
      casesSeen:       t.casesSeen,
      casesExpected:   t.casesExpected,
      picksCompleted:  t.suggestedPicksCompleted,
      picksSuggested:  t.suggestedPicks,
      overstockExceptions: t.overstockExceptions,
      palletsSeen:     NaN,
      palletsExpected: NaN,
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

  function paintUpdatedBar() {
    const absEl  = container.querySelector("[data-updated-abs]");
    const relEl  = container.querySelector("[data-updated-rel]");
    const noteEl = container.querySelector("[data-updated-note]");
    const freshEl = container.querySelector('[data-freshness="stores"]');

    const snap = activeSnapshot();
    const su = snap?.sourceUpdate;

    if (!snap) {
      absEl.textContent = "—";
      relEl.textContent = "";
      noteEl.textContent = TABS[activeTab].note;
    } else if (su?.iso) {
      const d = new Date(su.iso);
      // Only show a clock time when the source actually carries one. The
      // Yesterday view publishes a bare date; inventing 00:00 would be a lie.
      absEl.textContent = su.hasTime
        ? d.toLocaleString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
        : d.toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" });
      relEl.textContent = su.hasTime ? `(${humanAge(Date.now() - d.getTime())} ago)` : "";
      noteEl.textContent = TABS[activeTab].note + (su.hasTime ? "" : " This view publishes a date with no clock time.");
    } else {
      // No source stamp — say so rather than passing our capture time off as
      // the source's update time.
      absEl.textContent = "unknown";
      relEl.textContent = snap.capturedAt ? `(captured ${humanAge(Date.now() - new Date(snap.capturedAt).getTime())} ago)` : "";
      noteEl.textContent = TABS[activeTab].note + " Tableau's own update stamp could not be read for this capture.";
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
      { key: "vizpick",      label: "VizPick Health", goal: undefined },
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
    if (!wrap) return;

    if (count) count.textContent = rows.length ? `${rows.length} stores` : "";
    btnToggleAll.hidden = !rows.length;
    if (rows.length) {
      const anyOpen = rows.some((r) => !collapsed.has(r.store));
      btnToggleAll.textContent = anyOpen ? "Collapse all" : "Expand all";
    }

    if (!rows.length) {
      wrap.innerHTML = `<p class="vizpick-empty">${
        activeTab === "today"
          ? "Use “Load today's data” above to capture the current business day."
          : "Click Refresh to capture VizPick store data."
      }</p>`;
      return;
    }

    const sorted = [...rows].sort((a, b) => Number(a.store) - Number(b.store) || a.store.localeCompare(b.store));
    wrap.innerHTML = sorted.map((r) => storeCardHtml(r)).join("");
  }

  function storeCardHtml(r) {
    const hasHealth = Number.isFinite(r.vizpick);
    const gauge = hasHealth
      ? gaugeSvg(r.vizpick, { size: 96, thickness: 10, label: "", fmt: (v) => Math.round(v).toString() })
      : `<div class="vizpick-card-nohealth" title="The current-day view has no VizPick composite score">—</div>`;

    // Metric rows. `ratio` is a REAL numerator/denominator pair taken from the
    // export — never a figure derived by dividing a rounded percentage. See
    // the note at the top of lib/parse_vizpick_stores_csv.js.
    const metrics = [
      { label: "Cases Seen %", value: r.casesSeenPct, goal: GOALS.casesSeenPct, fmt: fmtPct,
        ratio: ratio(r.casesSeen, r.casesExpected) },
      { label: "Location %",   value: r.locationPct,  goal: GOALS.locationPct,  fmt: fmtPct },
      { label: "Pick %",       value: r.pickPct,      goal: GOALS.pickPct,      fmt: fmtPct,
        ratio: ratio(r.picksCompleted, r.picksSuggested) },
      { label: "Total Picked", value: r.totalPicked,  goal: null,               fmt: fmtInt },
      { label: "Overstock %",  value: r.overstockPct, goal: GOALS.overstockPct, fmt: fmtPct },
      { label: "Pallets %",    value: r.palletsPct,   goal: null,               fmt: fmtPct,
        ratio: ratio(r.palletsSeen, r.palletsExpected) },
    ];

    const metricsHtml = metrics
      .filter((m) => Number.isFinite(m.value) || m.ratio)
      .map((m) => `
        <div class="vizpick-store-card-metric">
          <span class="vizpick-store-card-metric-label">${escapeHtml(m.label)}</span>
          <span class="vizpick-store-card-metric-value">
            ${m.ratio ? `<span class="vizpick-ratio">${escapeHtml(m.ratio)}</span>` : ""}
            <strong class="${m.goal != null ? pctClass(m.value, m.goal) : ""}">${escapeHtml(m.fmt(m.value))}</strong>
          </span>
        </div>`)
      .join("");

    const sub = r.isToday
      ? `${escapeHtml(r.bu ?? "")}${r.bu ? " · " : ""}Region ${escapeHtml(r.region ?? "")}`
      : `${escapeHtml(r.bu)} · Region ${escapeHtml(r.region)}`;

    // Cards render EXPANDED by default; `collapsed` only holds stores the
    // user has explicitly closed this session.
    const open = collapsed.has(r.store) ? "" : " open";

    return `
      <details class="vizpick-store-card" data-store="${escapeHtml(r.store)}"${open}>
        <summary class="vizpick-store-card-summary">
          <div class="vizpick-store-card-gauge">${gauge}</div>
          <div class="vizpick-store-card-id">
            <div class="vizpick-store-card-num">#${escapeHtml(r.store)}</div>
            <div class="vizpick-store-card-sub">${sub}</div>
          </div>
          <span class="vizpick-store-card-caret" aria-hidden="true">›</span>
        </summary>
        <div class="vizpick-store-card-details">${metricsHtml}</div>
      </details>`;
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

  // What the user can actually do about each failure class, stated up front —
  // the raw envelope stays available underneath for diagnosis.
  const FIXES = {
    AUTH:              "Open the Tableau tab that was left open, complete the sign-in, then click Refresh again.",
    SLOW_RENDER:       "Usually transient. Click Refresh again; if it keeps happening, open the Tableau tab first and let the viz finish loading, then Refresh.",
    NO_CONTENT_SCRIPT: "Reload the extension at edge://extensions, close every open Tableau tab, then click Refresh.",
    WRONG_VIEW:        "Close the stray Tableau tab so a fresh one can be opened on the right view, then Refresh.",
    TABLEAU_ERROR:     "Tableau itself errored. Open the tab that was left open to see its message.",
    EXPORT_UI:         "Tableau's Download → Crosstab dialog changed or did not open. Check the sheet list in the debug details below.",
    NO_CAPTURE:        "The export was triggered but no CSV came back. Check the captured URLs in the debug details below.",
    PARSE:             "The CSV was captured but its columns were not what we expect — Tableau may have changed the sheet.",
  };

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

  function pctClass(value, goal) {
    if (!Number.isFinite(value)) return "";
    if (value >= goal) return "vizpick-good";
    if (value >= goal - 5) return "vizpick-warn";
    return "vizpick-bad";
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
