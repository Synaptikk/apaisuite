// modules/digitalrollup/view.js
//
// Full-page mount for the Digital Market Rollup. Same shape as VizPick's
// market rollup — header, market picker, average panel, card grid — minus the
// gauge rings, because the GIF board's headline figures are on four
// different scales (a percentage, a rate, minutes and two queue depths) and a
// ring implies a 0-100 fill that most of them do not have.
//
// The status colours here are NOT computed. The API ships a *_status of
// "green" | "yellow" | "red" | "gray" beside every figure, so this file only
// paints what the source already decided; see lib/normalize.js.

import { getUserHomeMarket, getUserHomeStore } from "../../shared/userStore.js";
import {
  at, cardStatus, cardSeverity, sortCards, isKnownSort,
  METRIC_SORTS, DEFAULT_SORT,
} from "./lib/sorting.js";
import { chartSvg, SCREEN_PALETTE, EXPORT_PALETTE } from "./lib/pick_chart.js";

const UI_PREFS_KEY = "ui.v1";

// A capture older than this is called out in the freshness pill. The board is
// real-time off GRT, so a snapshot from this morning is genuinely stale by
// mid-afternoon in a way a daily source never is.
const STALE_AFTER_MS = 30 * 60 * 1000;

// The figures every card leads with, in workflow order: pick → stage →
// dispense → availability. The first, second, fourth and fifth mirror the
// strip the GIF board itself puts across the top, which is how the user
// already reads it.
//
// `totes` is ours, not the board's. It is a backlog rather than a rate — a
// number that is fine at 20 and a problem at 200 — and it leads dispense
// trouble rather than reporting it, so waiting to see it behind "Show
// details" means seeing it after the wait time has already moved. The API
// bands it for us (`totes_to_stage_status`), so surfacing it costs nothing
// and invents no threshold.
const HEADLINE = [
  { label: "on-time",   path: "picking.on_time_fmt",        status: "picking.status" },
  { label: "pick rate", path: "picking.pick_rate_fmt",      status: "picking.pick_rate_status" },
  { label: "totes",     path: "staging.totes_to_stage_fmt", status: "staging.totes_to_stage_status" },
  { label: "avg wait",  path: "dispense.wait_time_fmt",     status: "dispense.wait_time_status" },
  { label: "pre-sub",   path: "quality.pre_sub_fmt",        status: "quality.pre_sub_status" },
];

// The full breakdown behind "Show details", one block per API group. Kept in
// the API's own vocabulary so a field can be traced straight back to
// /api/dashboard without a translation table.
const GROUPS = [
  {
    key: "picking", title: "Picking", status: "picking.status", statusLabel: "picking.status_label",
    rows: [
      { label: "On-time pick",  value: "picking.on_time_fmt",   status: "picking.status" },
      { label: "Pick rate",     value: "picking.pick_rate_fmt", status: "picking.pick_rate_status" },
      { label: "Items picked",  value: "picking.total_picks" },
      { label: "Open orders",   value: "picking.orders_raw" },
    ],
  },
  {
    key: "staging", title: "Staging",
    rows: [
      { label: "Totes to stage", value: "staging.totes_to_stage_fmt", status: "staging.totes_to_stage_status" },
      { label: "Scanned to stage", value: "staging.scan_stage_fmt",   status: "staging.scan_stage_status" },
    ],
  },
  {
    key: "dispense", title: "Dispense", status: "dispense.status", statusLabel: "dispense.status_label",
    rows: [
      { label: "In queue",        value: "dispense.in_queue_fmt" },
      { label: "Avg wait",        value: "dispense.wait_time_fmt", status: "dispense.wait_time_status" },
      { label: "High wait (>5m)", value: "dispense.high_wait_fmt" },
      { label: "Exceptions",      value: "dispense.exceptions_fmt" },
      { label: "Early removals",  value: "dispense.early_removals_fmt" },
    ],
  },
  {
    key: "quality", title: "Availability",
    rows: [
      { label: "Pre-sub %",  value: "quality.pre_sub_fmt",  status: "quality.pre_sub_status" },
      { label: "Post-sub %", value: "quality.post_sub_fmt", status: "quality.post_sub_status" },
      { label: "FTP rate",   value: "quality.ftp_fmt",      status: "quality.ftp_status" },
      { label: "Nil pick %", value: "quality.nil_pick_fmt", status: "quality.nil_status" },
    ],
  },
];

// Market averages, in the order the board itself shows them.
const TILES = [
  { label: "Avg on-time pick", value: "avg_on_time_pick", status: "avg_on_time_pick_status" },
  { label: "Avg wait",         value: "avg_wait_time",    status: "avg_wait_status" },
  { label: "Avg pre-sub",      value: "avg_pre_sub",      status: "avg_pre_sub_status" },
  { label: "Avg post-sub",     value: "avg_post_sub",     status: "avg_post_sub_status" },
  { label: "Avg pick rate",    value: "avg_pick_rate",    status: "avg_pick_rate_status" },
  { label: "Items picked",     value: "total_items_picked" },
  { label: "Open orders",      value: "total_orders" },
];

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const statusClass = (s) =>
  s === "green" ? "dmr-good" : s === "yellow" ? "dmr-warn" : s === "red" ? "dmr-bad" : s === "gray" ? "dmr-na" : "dmr-neutral";

/** Present a value, treating the API's em-dash and null alike as "no data". */
function present(v) {
  if (v == null || v === "" || v === "—") return { text: "—", missing: true };
  return { text: String(v), missing: false };
}

const fmtInt = (n) => Number(n).toLocaleString();

// Below this much history no hourly rate is shown: seen live 2026-09-23, a
// boot pull and the first live tick two seconds apart scaled one pick to
// "≈ 1,705/hr". At ~30 picks a minute, 5 minutes keeps the noise near 5%.
const PACE_MIN_SPAN_MS = 5 * 60 * 1000;
const HOUR_MS_VIEW = 60 * 60 * 1000;
const timeText = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** "23 min" / "1h 5m", for the span a partial rolling hour covers. */
function spanText(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function relAge(ms) {
  if (!Number.isFinite(ms)) return "";
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export async function mount(host, container) {
  // Inject module CSS and WAIT for it. Without the await the first render
  // lands before the stylesheet applies, so the card grid lays out with
  // default block rules — full-width cards that ignore the window — and only
  // a resize fixes it, which reads as a responsive bug rather than a
  // load-order one. (Same trap as vizpick/view.js.)
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = host.url("styles.css");
  link.dataset.module = host.id;
  const cssReady = new Promise((resolve) => {
    if (link.sheet) return resolve();
    link.addEventListener("load", resolve, { once: true });
    // Never block the module on a missing stylesheet — render unstyled rather
    // than not at all.
    link.addEventListener("error", resolve, { once: true });
    setTimeout(resolve, 3000);
  });
  document.head.appendChild(link);
  await cssReady;

  const resp = await fetch(host.url("view.html"));
  container.innerHTML = await resp.text();

  const btnRefresh   = container.querySelector('[data-action="refresh"]');
  const btnToggleAll = container.querySelector('[data-action="toggle-all"]');
  const marketSelect = container.querySelector("[data-market-select]");
  const sortSelect   = container.querySelector("[data-sort-select]");
  const autoToggle   = container.querySelector("[data-auto-toggle]");
  const liveToggle   = container.querySelector("[data-live-toggle]");
  const liveWrap     = container.querySelector("[data-live-wrap]");

  let state = { snapshot: null, hierarchy: null, debug: null, auto: { enabled: true }, periodMin: null, livePeriodSec: 60, rolling: {} };
  // Live polling is a view preference, not a background job: it only runs
  // while this board is mounted AND visible. On by default.
  let liveOn = true;
  // null = polling fine; otherwise why the last live tick could not run.
  let liveNote = null;
  let liveTimer = null;
  // Workvivo share: the chat is remembered; the note under the button says how
  // the last share went and survives the 15 s re-render.
  let shareChannel = "";
  let shareNote = null;
  let sharing = false;
  let selectedMarket = null;
  let marketIsUserSet = false;
  let sortMode = DEFAULT_SORT;
  // Which cards are expanded, keyed by market so opening a store in one
  // market does not open a same-numbered store in another.
  let expanded = {};
  let busy = false;
  let runNote = null;

  const homeMarket = await getUserHomeMarket();
  // Read once at mount: there is no onUserStoreChange, and changing it means a
  // trip to Settings, which unmounts this view anyway.
  const homeStore = await getUserHomeStore();

  // Before loadPrefs, which selects a saved value — the option has to exist.
  buildSortOptions();
  await loadPrefs();

  // ── Wiring ──────────────────────────────────────────────────────
  btnRefresh.addEventListener("click", () => runPull());

  liveToggle.addEventListener("change", async () => {
    liveOn = liveToggle.checked;
    liveNote = null;
    await savePrefs();
    scheduleLive();
    paintLive();
  });

  // Hover readout on the day graph. Delegated because the card is rebuilt on
  // every live tick; the SVG carries its own plot bounds (pick_chart.js).
  const grid = container.querySelector("[data-store-cards]");
  grid.addEventListener("mousemove", (e) => {
    const svg = e.target?.closest?.(".dmr-chart svg");
    if (svg) showChartTip(svg, e);
  });
  grid.addEventListener("mouseleave", hideChartTip, true);
  grid.addEventListener("mouseout", (e) => {
    if (e.target?.closest?.(".dmr-chart svg") && !e.relatedTarget?.closest?.(".dmr-chart svg")) hideChartTip();
  });

  // A hidden tab stops ticking (checked per tick below); coming back should
  // not wait out the rest of a minute to catch up.
  const onVisibility = () => { if (document.visibilityState === "visible") liveTick(); };
  document.addEventListener("visibilitychange", onVisibility);

  autoToggle.addEventListener("change", async () => {
    await host.messaging.send("set_auto", { auto: { enabled: autoToggle.checked } });
    await paint();
  });

  // The background refresh publishes this when it lands. Without it an open
  // board would keep showing the snapshot it mounted with while newer data sat
  // in storage — the module would look broken precisely when it was working.
  const unsubUpdated = host.messaging.on("board_updated", () => { paint(); });

  marketSelect.addEventListener("change", async () => {
    selectedMarket = marketSelect.value || null;
    marketIsUserSet = true;
    await savePrefs();
    // A different market is a different board — the snapshot we hold is for
    // the old one, so pull rather than render stale rows under a new label.
    runPull();
  });

  sortSelect.addEventListener("change", async () => {
    sortMode = sortSelect.value;
    await savePrefs();
    render();
  });

  btnToggleAll.addEventListener("click", async () => {
    const cards = visibleCards();
    const key = selectedMarket ?? "_";
    const anyOpen = cards.some((c) => isExpanded(c.store_nbr));
    expanded[key] = anyOpen ? [] : cards.map((c) => String(c.store_nbr));
    await savePrefs();
    render();
  });

  // Delegated: the grid is rebuilt on every render.
  container.querySelector("[data-store-cards]").addEventListener("click", async (e) => {
    if (e.target?.closest?.("[data-share]")) return shareToWorkvivo();
    if (e.target?.closest?.("[data-share-channel]")) return askChannel();
    const btn = e.target?.closest?.("[data-toggle-store]");
    if (!btn) return;
    const store = btn.getAttribute("data-toggle-store");
    const key = selectedMarket ?? "_";
    const list = new Set(expanded[key] || []);
    if (list.has(store)) list.delete(store); else list.add(store);
    expanded[key] = [...list];
    await savePrefs();
    render();
  });

  container.querySelector('[data-action="copy-diagnostics"]')?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const was = btn.textContent;
    try {
      const res = await host.messaging.send("diagnostics", {});
      await navigator.clipboard.writeText(JSON.stringify(res?.diagnostics ?? res, null, 2));
      btn.textContent = "Copied ✓";
    } catch (err) {
      btn.textContent = `Failed: ${String(err?.message ?? err).slice(0, 40)}`;
    }
    setTimeout(() => { btn.textContent = was; }, 2500);
  });

  await paint();
  scheduleLive();
  // Tick now rather than a minute from now: the last-hour line needs two
  // readings, so waiting a full period first meant two minutes of "—" on
  // every open. (First-run users with no board yet get runPull below.)
  if (state.snapshot) liveTick();
  // Nothing stored yet means a first-run user staring at an empty board with
  // no idea the Refresh button is the whole interaction. Pull for them.
  if (!state.snapshot) runPull({ trigger: "auto" });

  // ── Data ────────────────────────────────────────────────────────

  async function paint() {
    const res = await host.messaging.send("get_state", {});
    state = {
      snapshot:  res?.snapshot  ?? null,
      hierarchy: res?.hierarchy ?? null,
      debug:     res?.debug     ?? null,
      auto:      res?.auto      ?? { enabled: true },
      periodMin: res?.periodMin ?? null,
      livePeriodSec: res?.livePeriodSec ?? 60,
      rolling:   res?.rolling   ?? {},
    };
    resolveMarket();
    render();
  }

  function resolveMarket() {
    const markets = state.hierarchy?.markets || [];
    if (selectedMarket && markets.some((m) => m.market === selectedMarket)) return;
    if (!marketIsUserSet && homeMarket && markets.some((m) => m.market === String(homeMarket))) {
      selectedMarket = String(homeMarket);
      return;
    }
    // Fall back to whatever the snapshot actually holds, then to the first
    // market the user can see. Either beats an empty picker.
    selectedMarket = state.snapshot?.market || markets[0]?.market || selectedMarket || null;
  }

  // Three callers: the Refresh button, a market change (both a person), and
  // the first-run pull below (not). Same function, so the trigger has to be
  // passed in — this module is the reason the field exists at all.
  async function runPull({ trigger = "user" } = {}) {
    host.usage.record("pull", { trigger });
    if (busy) return;
    busy = true;
    runNote = null;
    setBusy(true);
    try {
      // sendRaw, not send: send() REJECTS on { ok: false } and hands back only
      // the message, which would throw away the error `kind` that adviceFor()
      // turns into something the reader can act on.
      const res = await host.messaging.sendRaw("pull", { market: selectedMarket }, { timeoutMs: 120_000 });
      runNote = res?.ok ? null : adviceFor(res);
    } catch (e) {
      runNote = `Refresh failed: ${String(e?.message ?? e)}`;
    } finally {
      busy = false;
      setBusy(false);
      await paint();
    }
  }

  // ── Live ────────────────────────────────────────────────────────

  function scheduleLive() {
    clearInterval(liveTimer);
    liveTimer = null;
    if (!liveOn) return;
    liveTimer = setInterval(liveTick, (state.livePeriodSec || 60) * 1000);
  }

  /**
   * One poll. Skipped while the tab is hidden, while a manual Refresh is
   * running, and before there is a market — so an idle or backgrounded board
   * costs nothing. Repaints come through the board_updated broadcast.
   */
  async function liveTick() {
    if (!liveOn || busy || document.visibilityState !== "visible") return;
    const market = selectedMarket || state.snapshot?.market;
    if (!market) return;
    try {
      const res = await host.messaging.sendRaw("live_tick", { market }, { timeoutMs: 30_000 });
      liveNote = res?.ok ? null : res?.kind === "NO_TAB"
        ? "Live needs the Digital Market Rollup board open in another tab of this browser. Until then this updates every 10 minutes."
        : (res?.error || "The last live update failed.");
    } catch (e) {
      liveNote = `The last live update failed: ${String(e?.message ?? e)}`;
    }
    paintLive();
  }

  function paintLive() {
    liveToggle.checked = liveOn;
    const label = container.querySelector("[data-live-label]");
    const sec = state.livePeriodSec || 60;
    if (label) label.textContent = liveOn ? `Live · ${sec < 60 ? `${sec}s` : `${Math.round(sec / 60)}m`}` : "Live";
    liveWrap.dataset.liveState = !liveOn ? "off" : liveNote ? "waiting" : "on";
    liveWrap.title = !liveOn
      ? "Live updates are off. This board updates on the Auto cadence or when you click Refresh."
      : liveNote || `Updating about every ${state.livePeriodSec || 60} seconds while this board is on screen.`;
  }

  /** Turn a failure class into something the reader can act on. */
  function adviceFor(res) {
    const msg = res?.error || "The pull failed.";
    switch (res?.kind) {
      case "DISCLAIMER":
        return `${msg} Open the board once in this browser and click "I Understand, Continue", then Refresh here.`;
      case "AUTH":
        return `${msg} Sign in to Walmart SSO in this browser, then Refresh.`;
      case "PARSE":
        return `${msg} The board's shape changed — the drift is recorded in Settings → debug.`;
      case "TAB":
        return `${msg} Nothing was changed; try Refresh again.`;
      default:
        return msg;
    }
  }

  // ── Render ──────────────────────────────────────────────────────

  function render() {
    paintAuto();
    paintLive();
    paintMarketOptions();
    paintRunNote();
    paintFreshness();
    paintPanel();
    paintCards();
    paintDebug();
  }

  function setBusy(on) {
    btnRefresh.disabled = on;
    btnRefresh.querySelector(".btn-spinner").hidden = !on;
    btnRefresh.querySelector(".btn-label").textContent = on ? "Refreshing" : "Refresh";
  }

  /**
   * Build the Sort menu from METRIC_SORTS. Grouped so the five metrics read as
   * a set rather than a flat list of ten, and worded low→high / high→low
   * throughout so the direction is never something the reader has to infer
   * from which metric it is.
   */
  function buildSortOptions() {
    const metricOpts = METRIC_SORTS.map((s) => {
      // Name the bad end, so "worst first" is findable without knowing which
      // direction that is for this particular metric.
      const worstAsc = s.worst === "low";
      return `
        <option value="${esc(s.key)}-asc">${esc(s.label)} — low to high${worstAsc ? " (worst first)" : ""}</option>
        <option value="${esc(s.key)}-desc">${esc(s.label)} — high to low${worstAsc ? "" : " (worst first)"}</option>`;
    }).join("");

    sortSelect.innerHTML = `
      <option value="attention">Needs attention first</option>
      <optgroup label="Store">
        <option value="store-asc">Store number — low to high</option>
        <option value="store-desc">Store number — high to low</option>
      </optgroup>
      <optgroup label="Metric">${metricOpts}</optgroup>`;
  }

  function paintAuto() {
    const on = !!state.auto?.enabled;
    autoToggle.checked = on;
    const label = container.querySelector("[data-auto-label]");
    const mins = state.periodMin;
    // Name the actual cadence rather than just "Auto" — a background refresh
    // whose interval you cannot see is one you cannot reason about when the
    // numbers look older than you expected.
    if (label) label.textContent = on && mins ? `Auto · ${mins}m` : "Auto";
    autoToggle.closest(".dmr-auto")?.setAttribute(
      "title",
      on
        ? `Refreshing this board in the background every ${mins ?? "—"} minutes.`
        : "Background refresh is off — this board only updates when you click Refresh."
    );
  }

  function paintMarketOptions() {
    const markets = state.hierarchy?.markets || [];
    const meta = container.querySelector("[data-picker-meta]");
    if (!markets.length) {
      marketSelect.disabled = true;
      marketSelect.innerHTML = `<option value="">No data yet — click Refresh</option>`;
      if (meta) meta.textContent = "";
      return;
    }
    marketSelect.disabled = false;
    marketSelect.innerHTML = markets
      .map((m) => `<option value="${esc(m.market)}"${m.market === selectedMarket ? " selected" : ""}>${esc(m.name)}</option>`)
      .join("");
    const cur = markets.find((m) => m.market === selectedMarket);
    if (meta) meta.textContent = cur?.region ? `Region ${cur.region}` : "";
  }

  function paintRunNote() {
    const el = container.querySelector("[data-run-note]");
    if (!el) return;
    el.textContent = runNote || "";
    el.hidden = !runNote;
  }

  function paintFreshness() {
    const el = container.querySelector("[data-freshness]");
    if (!el) return;
    const snap = state.snapshot;
    const failed = state.debug && state.debug.ok === false;

    if (busy) {
      el.textContent = "refreshing…";
      el.dataset.state = "pending";
      el.title = "";
      return;
    }
    if (!snap) {
      el.textContent = failed ? "no data — last pull failed" : "no data yet";
      el.dataset.state = failed ? "error" : "";
      el.title = failed ? String(state.debug?.error ?? "") : "";
      return;
    }

    const age = Date.now() - (snap.capturedAt || 0);
    const stale = age > STALE_AFTER_MS;
    // A failed pull deliberately leaves the previous snapshot in place — which
    // is the right call, but it means a frozen board can look perfectly
    // healthy. Say when what is on screen is not what the last attempt found.
    el.textContent = failed
      ? `last refresh failed · showing ${relAge(age)}`
      : `${snap.dataAge?.text || "captured"} · ${relAge(age)}`;
    el.dataset.state = failed ? "error" : stale ? "stale" : "ok";
    el.title = [
      snap.refreshedAtFull ? `Board last read GRT: ${snap.refreshedAtFull}` : "",
      `This browser fetched: ${new Date(snap.capturedAt).toLocaleString()}`,
      snap.dataAge?.tooltip || "",
      snap.via ? `Fetched ${snap.via === "tab" ? "via a background tab" : "directly"}` : "",
    ].filter(Boolean).join("\n");
  }

  function paintPanel() {
    const tiles = container.querySelector("[data-tiles]");
    const stamp = container.querySelector("[data-updated-abs]");
    const sub   = container.querySelector("[data-panel-sub]");
    const snap  = state.snapshot;

    if (stamp) {
      stamp.textContent = snap?.refreshedAt || "—";
      stamp.title = snap?.refreshedAtFull
        ? `The board last read GRT at ${snap.refreshedAtFull}. This is the source's own stamp, not when this browser fetched.`
        : "";
    }
    if (sub) sub.textContent = snap ? [snap.granularity, snap.reportDateFmt].filter(Boolean).join(" · ") : "";

    if (!tiles) return;
    if (!snap) {
      tiles.innerHTML = `<p class="dmr-empty">Click Refresh to load this market's board.</p>`;
      return;
    }
    tiles.innerHTML = TILES.map((t) => {
      const { text } = present(at(snap.summary, t.value));
      const status = at(snap.summary, t.status) || "";
      return `
        <div class="dmr-tile" data-status="${esc(status)}">
          <span class="dmr-tile-value">${esc(text)}</span>
          <span class="dmr-tile-label">${esc(t.label)}</span>
        </div>`;
    }).join("");
  }

  /** The rolling last-hour line — home store card only (see service.js). */
  function hourHtml(store) {
    const r = state.rolling?.[store];
    // Too little history for a rate that means anything: say what has been
    // seen so far instead of scaling one minute up to an hour.
    if (!r || (!r.full && r.spanMs < PACE_MIN_SPAN_MS)) {
      const seen = r ? `${fmtInt(r.picked)} picked in ${spanText(r.spanMs)} so far` : "waiting for the next update";
      return `
        <div class="dmr-hour is-partial" title="The hourly rate appears after ${PACE_MIN_SPAN_MS / 60000} minutes of readings. Leave the board open (Live) or let Auto collect in the background.">
          <span class="dmr-hour-value">—<small>/hr</small></span>
          <span class="dmr-hour-label">measuring · ${esc(seen)}</span>
        </div>`;
    }
    const asOf = new Date(r.asOf).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const title = r.full
      ? `${fmtInt(r.picked)} items picked in the 60 minutes up to the board's ${asOf} update (${r.samples} readings today).`
      : `${fmtInt(r.picked)} items picked in the last ${spanText(r.spanMs)}, scaled to an hour. Becomes the true last-hour count once there is an hour of readings.`;
    const d = r.day;
    // Only worth its space once it covers more than the rolling hour does.
    const dayHtml = d && d.spanMs > HOUR_MS_VIEW
      ? `<span class="dmr-hour-pace" title="${esc(`${fmtInt(d.picked)} items picked since ${timeText(d.since)}, the first reading today.`)}">today avg ${esc(fmtInt(d.perHour))}/hr since ${esc(timeText(d.since))}</span>`
      : "";
    return `
      <div class="dmr-hour${r.full ? "" : " is-partial"}" title="${esc(title)}">
        <span class="dmr-hour-value">${esc(fmtInt(r.perHour))}<small>/hr</small></span>
        <span class="dmr-hour-label">${r.full ? "picks, last hour" : `pace, last ${esc(spanText(r.spanMs))}`}</span>
        ${dayHtml}
      </div>`;
  }

  /** The day graph + Share row under the home card's per-hour line. */
  function homeExtrasHtml(card) {
    const r = state.rolling?.[String(card.store_nbr)];
    const pts = r?.series || [];
    const svg = chartSvg(pts, { avg: dayAvgShown(r), width: 320, height: 120 });
    const chart = svg
      ? `<div class="dmr-chart"><div class="dmr-chart-title">Pick rate today <span>items/hr, 15-min average</span></div>${svg}<div class="dmr-chart-tip" hidden></div></div>`
      : `<p class="dmr-chart-empty">The pick-rate graph starts after 15 minutes of readings.</p>`;
    const canShare = !!svg && !sharing;
    const chan = shareChannel
      ? `to <button class="dmr-linkbtn" data-share-channel title="Change the Workvivo chat">${esc(shareChannel)}</button>`
      : `<button class="dmr-linkbtn" data-share-channel>set chat</button>`;
    const note = shareNote
      ? `<p class="dmr-share-note" data-state="${esc(shareNote.state)}">${esc(shareNote.text)}</p>`
      : "";
    return `
      ${chart}
      <div class="dmr-share">
        <button class="btn btn-sm" data-share ${canShare ? "" : "disabled"}
          title="${esc(svg ? "Post this summary and graph to the Workvivo chat" : "Available once the graph has 15 minutes of readings")}">${sharing ? "Sharing…" : "Share to Workvivo"}</button>
        <span class="dmr-share-chan">${chan}</span>
      </div>
      ${note}`;
  }

  // Today's average only once it covers more than the rolling hour: before
  // that it is the same figure as the pace, and a second line would just
  // shadow the first.
  // A declaration, not a const arrow: mount() renders before execution reaches
  // this line, and a const here threw "before initialization" on first paint.
  function dayAvgShown(r) {
    return r?.day && r.day.spanMs > HOUR_MS_VIEW ? r.day.perHour : null;
  }

  /** 'Store 1458 picks @ 2:15 PM: 1,780/hr last hour · today avg 1,650/hr · 10,068 picked' */
  function summaryText(card) {
    const store = String(card.store_nbr);
    const r = state.rolling?.[store];
    if (!r) return "";
    const rate = r.full
      ? `${fmtInt(r.perHour)}/hr last hour`
      : `${fmtInt(r.perHour)}/hr pace (last ${spanText(r.spanMs)})`;
    const bits = [rate];
    if (dayAvgShown(r) != null) bits.push(`today avg ${fmtInt(r.day.perHour)}/hr`);
    const total = card.picking?.total_picks;
    if (total != null && total !== "—") bits.push(`${total} picked`);
    return `Store ${store} picks @ ${timeText(r.asOf)}: ${bits.join(" · ")}`;
  }

  function askChannel() {
    const v = window.prompt(
      "Workvivo chat to share to — the exact name as it appears in your Workvivo chat list:",
      shareChannel
    );
    if (v == null) return false;
    shareChannel = v.trim();
    shareNote = null;
    savePrefs();
    render();
    return !!shareChannel;
  }

  async function shareToWorkvivo() {
    if (sharing) return;
    const card = visibleCards().find((c) => isHomeStore(c.store_nbr));
    const r = card && state.rolling?.[String(card.store_nbr)];
    if (!card || !r?.series?.length) return;
    if (!shareChannel && !askChannel()) return;
    const text = summaryText(card);
    // Posting speaks for the user in a shared chat: show exactly what goes
    // where, every time.
    if (!window.confirm(`Post to the Workvivo chat "${shareChannel}"?\n\n${text}\n\n(plus the pick-rate graph)`)) return;
    host.usage.record("share_workvivo", {});
    sharing = true;
    shareNote = { state: "pending", text: "Posting… this opens Workvivo in a background tab for a few seconds." };
    render();
    try {
      const svg = chartSvg(r.series, {
        avg: dayAvgShown(r), width: 800, height: 420, palette: EXPORT_PALETTE,
        title: `Store ${card.store_nbr} · pick rate today (items/hr)`, subtitle: text,
      });
      const pngBase64 = await svgToPngBase64(svg, 800, 420);
      const res = await host.messaging.sendRaw("share_workvivo", { channelName: shareChannel, text, pngBase64 }, { timeoutMs: 120_000 });
      shareNote = res?.ok
        ? { state: "ok", text: `Posted to "${shareChannel}" at ${timeText(Date.now())}.` }
        : { state: "error", text: shareAdvice(res) };
    } catch (e) {
      shareNote = { state: "error", text: `Share failed: ${String(e?.message ?? e)}` };
    } finally {
      sharing = false;
      render();
    }
  }

  function shareAdvice(res) {
    switch (res?.kind) {
      case "NOT_FOUND":
        return `No Workvivo chat named "${shareChannel}" in your chat list. Check the exact name (click it to change).`;
      case "NO_SESSION": case "NO_TAB": case "NO_CSRF":
        return "Could not reach Workvivo. Open workvivo.walmart.com, make sure you are signed in, then try again.";
      default:
        return `Share failed: ${res?.error || "Workvivo did not accept the post."}`;
    }
  }

  /** Rasterise an SVG string to PNG base64 (no data: prefix), at 2× for sharpness. */
  function svgToPngBase64(svg, w, h) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = w * 2; c.height = h * 2;
        const ctx = c.getContext("2d");
        ctx.scale(2, 2);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL("image/png").split(",")[1]);
      };
      img.onerror = () => reject(new Error("could not draw the graph"));
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    });
  }

  function showChartTip(svg, e) {
    const tip = svg.parentElement.querySelector(".dmr-chart-tip");
    const r = state.rolling?.[visibleCards().find((c) => isHomeStore(c.store_nbr))?.store_nbr + ""];
    const pts = r?.series || [];
    if (!tip || pts.length < 2) return;
    const ds = svg.dataset;
    const box = svg.getBoundingClientRect();
    const vbW = svg.viewBox.baseVal.width;
    const vx = ((e.clientX - box.left) / box.width) * vbW;
    const t = Number(ds.t0) + ((vx - Number(ds.x0)) / (Number(ds.x1) - Number(ds.x0))) * (Number(ds.tn) - Number(ds.t0));
    let best = pts[0];
    for (const p of pts) if (Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
    const px = Number(ds.x0) + ((best[0] - Number(ds.t0)) / ((Number(ds.tn) - Number(ds.t0)) || 1)) * (Number(ds.x1) - Number(ds.x0));
    let cross = svg.querySelector("[data-cross]");
    if (!cross) {
      cross = document.createElementNS("http://www.w3.org/2000/svg", "line");
      cross.setAttribute("data-cross", "");
      cross.setAttribute("style", "stroke:var(--apai-muted);stroke-width:1;stroke-dasharray:2 2");
      svg.appendChild(cross);
    }
    cross.setAttribute("x1", px); cross.setAttribute("x2", px);
    cross.setAttribute("y1", ds.y1); cross.setAttribute("y2", ds.y0);
    tip.hidden = false;
    tip.textContent = `${timeText(best[0])} · ${fmtInt(best[1])}/hr`;
    const left = (px / vbW) * box.width;
    tip.style.left = `${Math.min(Math.max(left, 40), box.width - 40)}px`;
  }

  function hideChartTip() {
    container.querySelectorAll(".dmr-chart-tip").forEach((t) => { t.hidden = true; });
    container.querySelectorAll(".dmr-chart [data-cross]").forEach((l) => l.remove());
  }

  function visibleCards() {
    const snap = state.snapshot;
    if (!snap || String(snap.market) !== String(selectedMarket ?? snap.market)) return [];
    return snap.cards || [];
  }


  function isExpanded(store) {
    return (expanded[selectedMarket ?? "_"] || []).includes(String(store));
  }

  // Compared NUMERICALLY: getUserHomeStore() strips the leading zeros off the
  // WIN suffix while the API returns an integer store_nbr, so "01458" and 1458
  // must not be compared as strings. (Same trap as vizpick.)
  function isHomeStore(store) {
    return homeStore != null && Number(homeStore) === Number(store);
  }

  function paintCards() {
    const grid  = container.querySelector("[data-store-cards]");
    const count = container.querySelector("[data-store-count]");
    const cards = visibleCards();

    if (count) {
      count.textContent = cards.length
        ? `${cards.length} store${cards.length === 1 ? "" : "s"}`
        : "";
    }
    btnToggleAll.hidden = !cards.length;
    if (cards.length) {
      const anyOpen = cards.some((c) => isExpanded(c.store_nbr));
      btnToggleAll.textContent = anyOpen ? "Hide all details" : "Show all details";
    }

    if (!grid) return;
    if (!cards.length) {
      grid.innerHTML = state.snapshot
        ? `<p class="dmr-empty">The stored board is for market ${esc(state.snapshot.market)}. Click Refresh to load market ${esc(selectedMarket ?? "—")}.</p>`
        : `<p class="dmr-empty">Click Refresh to load this market's board.</p>`;
      return;
    }
    grid.innerHTML = sortCards(cards, sortMode).map(cardHtml).join("");
  }

  function cardHtml(card) {
    const store = String(card.store_nbr);
    const open = isExpanded(store);
    const home = isHomeStore(store);
    const overall = cardStatus(card);
    // `live_meta.has_data` is the app's own "this store reported nothing"
    // flag. Dim the card rather than dropping it — a store vanishing from the
    // market silently is worse than a store visibly showing nothing.
    const noData = card.live_meta && card.live_meta.has_data === false;

    const headline = HEADLINE.map((h) => {
      const { text, missing } = present(at(card, h.path));
      const cls = missing ? "dmr-na" : statusClass(at(card, h.status));
      return `
        <div class="dmr-headline-cell">
          <span class="dmr-headline-value ${cls}">${esc(text)}</span>
          <span class="dmr-headline-label">${esc(h.label)}</span>
        </div>`;
    }).join("");

    const groups = GROUPS.map((g) => {
      const rows = g.rows.map((r) => {
        const { text, missing } = present(at(card, r.value));
        const cls = missing ? "dmr-na" : statusClass(at(card, r.status));
        return `
          <div class="dmr-metric">
            <span class="dmr-metric-label">${esc(r.label)}</span>
            <span class="dmr-metric-value ${cls}">${esc(text)}</span>
          </div>`;
      }).join("");
      const label = at(card, g.statusLabel);
      const chip = label
        ? `<span class="dmr-chip" data-status="${esc(at(card, g.status) || "gray")}">${esc(label)}</span>`
        : "";
      return `<div class="dmr-group"><div class="dmr-group-head">${esc(g.title)}${chip}</div>${rows}</div>`;
    }).join("");

    // Overdue / at-risk are counts that are normally zero and matter entirely
    // when they are not, so they get their own line instead of a row that
    // reads "false" nine cards out of ten.
    const flags = [];
    if (card.picking?.is_overdue) {
      flags.push(`<span class="dmr-chip" data-status="red">Overdue ${esc(card.picking.overdue_minutes ?? "")}m</span>`);
    }
    if (card.picking?.is_at_risk) {
      flags.push(`<span class="dmr-chip" data-status="yellow">At risk ${esc(card.picking.at_risk_minutes ?? "")}m</span>`);
    }
    const flagsHtml = flags.length ? `<div class="dmr-flags">${flags.join("")}</div>` : "";

    return `
      <article class="dmr-store-card${home ? " is-home" : ""}${noData ? " is-nodata" : ""}"
               data-store="${esc(store)}"
               aria-label="Store ${esc(store)}${home ? " — your store" : ""}">
        <header class="dmr-store-card-summary">
          <div class="dmr-store-card-id">
            <div class="dmr-store-card-num">#${esc(store)}${
              home ? `<span class="dmr-home-chip" title="Your home store, from Settings > Defaults">yours</span>` : ""
            }</div>
            <div class="dmr-store-card-sub">${esc(card.report_date_fmt || "")}${noData ? " · no live data" : ""}</div>
          </div>
          <span class="dmr-chip" data-status="${esc(overall.status)}">${esc(overall.label || "—")}</span>
        </header>
        ${home ? hourHtml(store) + homeExtrasHtml(card) : ""}
        <div class="dmr-headline" style="--dmr-headline-n:${HEADLINE.length}">${headline}</div>
        ${flagsHtml}
        <button class="dmr-card-toggle" data-toggle-store="${esc(store)}" aria-expanded="${open}">${
          open ? "Hide details" : "Show details"
        }</button>
        <div class="dmr-store-card-details"${open ? "" : " hidden"}>${groups}</div>
      </article>`;
  }

  function paintDebug() {
    const section = container.querySelector("[data-debug-section]");
    const body    = container.querySelector("[data-debug-body]");
    if (!section || !body) return;
    const dbg = state.debug;
    if (!dbg || dbg.ok !== false) {
      section.hidden = true;
      return;
    }
    section.hidden = false;
    body.innerHTML = `
      <p><strong>${esc(dbg.kind || "ERROR")}</strong> — ${esc(dbg.error || "")}</p>
      <p class="dmr-debug-fix">${esc(adviceFor(dbg))}</p>
      <p><code>market ${esc(dbg.market || "—")}</code> · <code>${esc(new Date(dbg.at).toLocaleString())}</code></p>`;
  }

  // ── Prefs ───────────────────────────────────────────────────────
  // host.storage namespaces these under "digitalrollup." for us — never
  // reach for chrome.storage directly from view code.

  async function loadPrefs() {
    try {
      // host.storage.local.get(key) returns the VALUE, not a {key: value} bag.
      const p = (await host.storage.local.get(UI_PREFS_KEY)) || {};
      // Validated, not trusted: an option removed or renamed by a later build
      // would otherwise leave the select showing nothing selected while
      // sortCards silently fell through to "attention".
      if (typeof p.sortMode === "string" && isKnownSort(p.sortMode)) sortMode = p.sortMode;
      if (p.expanded && typeof p.expanded === "object") expanded = p.expanded;
      if (typeof p.liveOn === "boolean") liveOn = p.liveOn;
      if (typeof p.shareChannel === "string") shareChannel = p.shareChannel;
      if (typeof p.selectedMarket === "string") { selectedMarket = p.selectedMarket; marketIsUserSet = !!p.marketIsUserSet; }
    } catch { /* prefs are a convenience; never block the render on them */ }
    sortSelect.value = sortMode;
  }

  async function savePrefs() {
    try {
      await host.storage.local.set({
        [UI_PREFS_KEY]: { sortMode, expanded, selectedMarket, marketIsUserSet, liveOn, shareChannel },
      });
    } catch { /* as above */ }
  }

  return () => {
    // The shell unmounts the container but does not GC listeners — without
    // this, a subscription stacks on every route change.
    unsubUpdated();
    clearInterval(liveTimer);
    document.removeEventListener("visibilitychange", onVisibility);
    link.remove();
  };
}
