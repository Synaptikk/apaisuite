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

  let state = { snapshot: null, hierarchy: null, debug: null, auto: { enabled: true }, periodMin: null };
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
      if (typeof p.selectedMarket === "string") { selectedMarket = p.selectedMarket; marketIsUserSet = !!p.marketIsUserSet; }
    } catch { /* prefs are a convenience; never block the render on them */ }
    sortSelect.value = sortMode;
  }

  async function savePrefs() {
    try {
      await host.storage.local.set({
        [UI_PREFS_KEY]: { sortMode, expanded, selectedMarket, marketIsUserSet },
      });
    } catch { /* as above */ }
  }

  return () => {
    // The shell unmounts the container but does not GC listeners — without
    // this, a subscription stacks on every route change.
    unsubUpdated();
    link.remove();
  };
}
