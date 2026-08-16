// modules/vizpick/view.js
//
// Full-page dashboard mount. Loads view.html, wires the Refresh button and
// the Market picker, subscribes to source_complete broadcasts, and re-renders
// on each update. The Market select is the whole point of this module: pick
// a market once and see every store in it side by side, instead of typing
// store numbers one at a time into Tableau's VizPick Details search box.

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
  const marketSelect = container.querySelector("[data-market-select]");

  let lastRows = [];
  let selectedMarket = null;
  let marketIsUserSet = false;
  // Settings → Defaults home market (chrome.storage.sync). Used as the
  // initial market selection so this module opens straight to your own
  // market's stores instead of whichever sorts first.
  let homeMarket = await getUserHomeMarket();

  // 4. Wire click/change handlers.
  btnRefresh.addEventListener("click", runRefresh);
  marketSelect.addEventListener("change", () => {
    selectedMarket = marketSelect.value || null;
    marketIsUserSet = true;
    renderMarket();
  });

  // 5. Initial paint from persisted state.
  await paint();

  // 6. Re-paint when a background/other-tab refresh completes.
  const unsub = host.messaging.on("source_complete", () => { paint(); });

  // 7. If the Settings → Defaults home market changes while this view is
  // open and the user hasn't manually picked a different market here,
  // follow it.
  const unsubMarket = onUserMarketChange((m) => {
    homeMarket = m;
    if (!marketIsUserSet) {
      selectedMarket = null;
      paintMarketOptions();
      renderMarket();
    }
  });

  // ── Helpers ─────────────────────────────────────────────────────
  async function runRefresh() {
    setBusy(true);
    try {
      await host.messaging.send("pull_stores");
    } catch (e) {
      console.warn("[vizpick] pull_stores failed:", e?.message ?? e);
    } finally {
      setBusy(false);
      await paint();
    }
  }

  function setBusy(busy) {
    btnRefresh.disabled = busy;
    const spinner = btnRefresh.querySelector(".btn-spinner");
    if (spinner) spinner.hidden = !busy;
  }

  async function paint() {
    let state;
    try {
      state = await host.messaging.send("get_state");
    } catch (e) {
      console.warn("[vizpick] get_state failed:", e?.message ?? e);
      return;
    }

    const freshEl = container.querySelector('[data-freshness="stores"]');
    if (freshEl) {
      const { text, state: fstate } = renderFreshness(state.freshness);
      freshEl.textContent = text;
      freshEl.dataset.state = fstate;
    }

    lastRows = state.rows || [];
    paintMarketOptions();
    renderMarket();
    paintDebug(state);
  }

  function paintMarketOptions() {
    const markets = [...new Set(lastRows.map((r) => r.market))].sort(
      (a, b) => Number(a) - Number(b) || a.localeCompare(b)
    );

    if (!markets.length) {
      marketSelect.innerHTML = `<option value="">No data yet — click Refresh</option>`;
      marketSelect.disabled = true;
      selectedMarket = null;
      return;
    }

    // Keep the current selection if it's still present; otherwise default
    // to the Settings → Defaults home market when available, else the
    // first market in the list.
    if (!selectedMarket || !markets.includes(selectedMarket)) {
      selectedMarket = (homeMarket && markets.includes(homeMarket)) ? homeMarket : markets[0];
    }

    marketSelect.innerHTML = markets
      .map((m) => `<option value="${escapeHtml(m)}"${m === selectedMarket ? " selected" : ""}>Market ${escapeHtml(m)}</option>`)
      .join("");
    marketSelect.disabled = false;
  }

  function renderMarket() {
    const meta = container.querySelector("[data-picker-meta]");
    const rows = selectedMarket ? lastRows.filter((r) => r.market === selectedMarket) : [];

    if (meta) {
      meta.textContent = rows.length ? `${rows.length} store${rows.length === 1 ? "" : "s"}` : "";
    }

    renderGauges(rows);
    renderStoreCards(rows);
  }

  function renderGauges(rows) {
    const wrap = container.querySelector("[data-gauges]");
    if (!wrap) return;
    if (!rows.length) {
      wrap.innerHTML = `<p class="vizpick-empty">Click Refresh, then pick a market above to see its gauges.</p>`;
      return;
    }

    const avg = (key) => rows.reduce((s, r) => s + (r[key] || 0), 0) / rows.length;

    const gauges = [
      { key: "vizpick",      label: "VizPick Health", goal: undefined },
      { key: "casesSeenPct", label: "Cases Seen %",   goal: GOALS.casesSeenPct },
      { key: "locationPct",  label: "Location %",     goal: GOALS.locationPct },
      { key: "pickPct",      label: "Pick %",         goal: GOALS.pickPct },
      { key: "overstockPct", label: "Overstock %",    goal: GOALS.overstockPct },
    ];

    wrap.innerHTML = gauges
      .map((g) => gaugeSvg(avg(g.key), { goal: g.goal, label: g.label, fmt: (v) => Math.round(v).toString() }))
      .join("");
  }

  function renderStoreCards(rows) {
    const wrap = container.querySelector("[data-store-cards]");
    const count = container.querySelector("[data-store-count]");
    if (!wrap) return;

    if (count) count.textContent = rows.length ? `${rows.length} stores` : "";

    if (!rows.length) {
      wrap.innerHTML = `<p class="vizpick-empty">Click Refresh to capture VizPick store data.</p>`;
      return;
    }

    // Sort by store number for a stable, scannable grid.
    const sorted = [...rows].sort((a, b) => Number(a.store) - Number(b.store) || a.store.localeCompare(b.store));

    wrap.innerHTML = sorted.map((r) => storeCardHtml(r)).join("");
  }

  function storeCardHtml(r) {
    const gauge = gaugeSvg(r.vizpick, { size: 96, thickness: 10, label: "", fmt: (v) => Math.round(v).toString() });
    const metrics = [
      { label: "Cases Seen %", value: r.casesSeenPct, goal: GOALS.casesSeenPct, fmt: fmtPct },
      { label: "Location %",   value: r.locationPct,  goal: GOALS.locationPct,  fmt: fmtPct },
      { label: "Total Picked", value: r.totalPicked,   goal: null,               fmt: fmtInt },
      { label: "Overstock %",  value: r.overstockPct, goal: GOALS.overstockPct, fmt: fmtPct },
      { label: "Pick %",       value: r.pickPct,       goal: GOALS.pickPct,      fmt: fmtPct },
    ];

    const metricsHtml = metrics
      .map((m) => `
        <div class="vizpick-store-card-metric">
          <span class="vizpick-store-card-metric-label">${escapeHtml(m.label)}</span>
          <strong class="${m.goal != null ? pctClass(m.value, m.goal) : ""}">${escapeHtml(m.fmt(m.value))}</strong>
        </div>`)
      .join("");

    return `
      <details class="vizpick-store-card">
        <summary class="vizpick-store-card-summary">
          <div class="vizpick-store-card-gauge">${gauge}</div>
          <div class="vizpick-store-card-id">
            <div class="vizpick-store-card-num">#${escapeHtml(r.store)}</div>
            <div class="vizpick-store-card-sub">${escapeHtml(r.bu)} · Region ${escapeHtml(r.region)}</div>
          </div>
          <span class="vizpick-store-card-caret" aria-hidden="true">›</span>
        </summary>
        <div class="vizpick-store-card-details">${metricsHtml}</div>
      </details>`;
  }

  function paintDebug(state) {
    const section = container.querySelector("[data-debug-section]");
    const body    = container.querySelector("[data-debug-body]");
    if (!section || !body) return;
    const dbg = state.debug;
    const hasError = dbg && !dbg.ok;
    if (!hasError) { section.hidden = true; body.innerHTML = ""; return; }
    section.hidden = false;
    body.innerHTML = renderDebug(dbg);
  }

  function renderDebug(dbg) {
    const parts = [];
    if (dbg.errorClass) parts.push(`<code>${escapeHtml(dbg.errorClass)}</code>`);
    if (dbg.error) parts.push(`<br><span class="vizpick-debug-error">${escapeHtml(String(dbg.error))}</span>`);
    if (dbg.debug) {
      parts.push(`<details><summary>Capture debug</summary><pre>${escapeHtml(JSON.stringify(dbg.debug, null, 2))}</pre></details>`);
    }
    return parts.join("");
  }

  // ── Formatting helpers ─────────────────────────────────
  function fmtPct(n) { return Number.isFinite(n) ? `${Math.round(n)}%` : "—"; }
  function fmtInt(n) { return Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "—"; }
  function pctClass(value, goal) {
    if (!Number.isFinite(value)) return "";
    if (value >= goal) return "vizpick-good";
    if (value >= goal - 5) return "vizpick-warn";
    return "vizpick-bad";
  }

  function renderFreshness(f) {
    if (!f) return { text: "no capture yet", state: "" };
    if (f.inFlight) return { text: "refreshing…", state: "pending" };
    if (f.lastError) return { text: "error — see console", state: "error" };
    if (f.lastSuccess) {
      const age = Date.now() - new Date(f.lastSuccess).getTime();
      return { text: humanAge(age) + " ago", state: f.isStale ? "stale" : "ok" };
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
    unsubMarket();
    link.remove();
  };
}
