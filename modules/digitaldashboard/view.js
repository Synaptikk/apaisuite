// modules/digitaldashboard/view.js
//
// Single-store (1458) GIF dashboard. Reads everything through the SW handlers
// in service.js, which front the local gif-daemon. No market picker, no store
// cards, no live-poll loop driving a tab — the old market rollup view is in
// docs/_archive/legacy-digitalrollup/.
//
// Daemon reads can take a couple of minutes (they may wake the emulator), so
// network-backed actions use sendRaw with a long timeout and show a spinner;
// the view paints the cached summary first so it is never blank while waiting.

import { hourlyBars } from "./lib/pick_history.js";
import { barChartSvg } from "./lib/pick_chart.js";
import { clockText } from "./lib/gif_metrics.js";

const n = (x) => (x == null ? "—" : Number(x).toLocaleString("en-US"));

export async function mount(host, container) {
  // Inject + await module CSS (same load-order trap as the old view).
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = host.url("styles.css");
  link.dataset.module = host.id;
  await new Promise((resolve) => {
    if (link.sheet) return resolve();
    link.addEventListener("load", resolve, { once: true });
    link.addEventListener("error", resolve, { once: true });
    setTimeout(resolve, 3000);
    document.head.appendChild(link);
  });

  container.innerHTML = await (await fetch(host.url("view.html"))).text();
  const $ = (sel) => container.querySelector(sel);

  // The SW dispatcher wraps a plain handler result as { ok:true, data:<result> }
  // but passes a handler that already returns { ok, … } through flat (the
  // "unwrapped-{ok}" gotcha). ask() returns the payload either way: the wrapped
  // .data, or the flat object (e.g. the health handler's { ok, emulator, … }).
  async function ask(type, payload = {}, opts) {
    const r = await host.messaging.sendRaw(type, payload, opts);
    return (r && r.ok === true && Object.prototype.hasOwnProperty.call(r, "data")) ? r.data : r;
  }

  let summary = null;     // last /summary
  let watch = null;       // last break check
  let settings = null;
  let busy = false;
  let disposed = false;
  const timers = [];

  // ── painting ────────────────────────────────────────────────────
  function note(msg, kind = "") {
    const el = $("[data-note]");
    if (!msg) { el.hidden = true; return; }
    el.hidden = false; el.textContent = msg; el.className = "dmr-note" + (kind ? " dmr-note-" + kind : "");
  }
  function setEmu(h) {
    const el = $("[data-emu]");
    if (!h) { el.textContent = "connecting…"; return; }
    if (!h.ok) { el.textContent = "offline"; el.dataset.state = "off"; return; }
    el.textContent = h.emulator === "up" ? "live" : "starting…";
    el.dataset.state = h.emulator === "up" ? "up" : "down";
  }

  function paintSummary() {
    if (!summary) return;
    $("[data-asof]").textContent = summary.asOf ? "as of " + new Date(summary.asOf).toLocaleTimeString() + (summary.stale ? " (stale, refreshing…)" : "") : "—";
    const pph = summary.pph;
    $('[data-tile="pph"]').textContent = pph ? n(pph.perHour) : "—";
    $('[data-tile-lbl="pph"]').textContent = pph && !pph.full ? `picks / hr (pace, last ${pph.spanMin}m)` : "picks / hr (last hour)";
    // The daemon already ran completedSummary; summary.completed is the object
    // { hours, total, avgPerHour, peak }, not a raw array — use it directly.
    const comp = summary.completed || {};
    $('[data-tile="avg"]').textContent = comp.avgPerHour != null ? n(comp.avgPerHour) : "—";
    $('[data-tile="day"]').textContent = n(summary.dayPicked);
    $('[data-tile="ready"]').textContent = n(summary.readyToPick);

    // hourly bar chart from the running-total series
    const chart = $("[data-chart]");
    if (Array.isArray(summary.series) && summary.series.length >= 2 && summary.dayStart) {
      const day = hourlyBars(summary.series, summary.dayStart);
      chart.innerHTML = day ? barChartSvg(day, { width: Math.min(640, container.clientWidth - 40 || 600), height: 150, title: "Store 1458", subtitle: comp.peak ? `peak ${comp.peak.slot} ${n(comp.peak.qtyPicked)}` : "" }) : "Not enough readings yet.";
    } else {
      chart.textContent = "Collecting data…";
    }

    // express by slot — the SW already computed this via expressSummary.
    const live = summary.express;
    const rows = (live?.slots || []).map((x) =>
      `<div class="dmr-exp-row"><span class="dmr-exp-slot">${x.slot}</span>` +
      `<span class="dmr-exp-v">≥${n(x.items)} items · ≥${n(x.orders)} orders</span>` +
      `<span class="dmr-exp-tag">${x.final ? "final" : n(x.remaining) + " left · open"}</span></div>`).join("");
    const avgLine = live?.avgItemsPerHour != null ? `<div class="dmr-exp-avg">avg / closed hour: ${n(live.avgItemsPerHour)} items · ${n(live.avgOrdersPerHour)} orders (${live.closedCount} hr)</div>` : "";
    $("[data-express]").innerHTML = rows ? rows + avgLine : "No open slots read yet.";
  }

  function paintBreaks() {
    const el = $("[data-breaks]");
    if (!watch) return;
    if (watch.error) { el.textContent = "Couldn't check: " + watch.error; return; }
    if (!watch.scheduledCount) { el.textContent = watch.note || "No one on the grid to pick this hour."; return; }
    const over = (watch.suspects || []).filter((s) => s.over);
    const head = `<div class="dmr-breaks-head">${watch.scheduledCount} scheduled to pick this hour · checked ${new Date(watch.checkedAt).toLocaleTimeString()}</div>`;
    if (!over.length) { el.innerHTML = head + `<div class="dmr-breaks-ok">All within ${watch.limitMin ?? 18} min.</div>`; return; }
    const rows = over.map((s) => `<div class="dmr-break-row"><span class="dmr-break-name">${escapeHtml(s.name)}</span><span class="dmr-break-min">out ${s.idleMin} min</span><span class="dmr-break-last">last pick ${clockText(s.lastSeen)}</span></div>`).join("");
    el.innerHTML = head + rows;
  }

  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  // ── data ────────────────────────────────────────────────────────
  async function loadCached() {
    const [cs, cw, st] = await Promise.all([
      ask("cached_summary").catch(() => null),
      ask("cached_watch").catch(() => null),
      ask("get_settings").catch(() => null),
    ]);
    if (cs?.data) { summary = cs.data; paintSummary(); }
    if (cw) { watch = cw; paintBreaks(); }
    if (st) { settings = st; fillSettings(st); updateLimitHint(st); }
  }

  async function pingHealth() {
    const h = await ask("health").catch((e) => ({ ok: false, error: e.message }));
    if (!disposed) setEmu(h);
    return h;
  }

  // While a read is in flight, poll the daemon's phase and show it live. The
  // daemon serves /health immediately (just a variable), so this runs
  // concurrently with the long summary/breaks request. `label` says which text
  // slot to drive. Returns a stop function.
  function startProgress(onText) {
    let stopped = false;
    (async () => {
      let dots = 0;
      while (!stopped && !disposed) {
        const h = await pingHealth();
        if (stopped) break;
        let p;
        if (!h?.ok) p = h?.kind === "OFFLINE" ? "Live pick data is offline" : "Connecting";
        else if (h.emulator === "down") p = "Connecting";
        else p = "Updating";
        onText(p + ".".repeat((dots++ % 3) + 1));
        await new Promise((r) => setTimeout(r, 2000));
      }
    })();
    return () => { stopped = true; };
  }

  async function refresh() {
    if (busy) return;
    busy = true;
    const stopProg = startProgress((p) => note(p, "wait"));
    try {
      summary = await ask("summary", { maxAge: 90, wait: 100 }, { timeoutMs: 200_000 });
      stopProg();
      paintSummary(); note(summary?.stale ? "Showing the last reading; a fresher one is still loading." : "");
    } catch (e) {
      stopProg(); console.warn("[digitaldashboard] refresh failed", e); note(e?.message || "Refresh failed — try again.", "err");
    } finally { busy = false; pingHealth(); }
  }

  async function checkBreaks() {
    if (busy) return;
    busy = true;
    const el = $("[data-breaks]");
    const stopProg = startProgress((p) => { el.textContent = p; });
    try {
      watch = await ask("check_breaks", { maxAge: 60, wait: 150 }, { timeoutMs: 240_000 });
      stopProg(); paintBreaks();
    } catch (e) {
      stopProg(); console.warn("[digitaldashboard] break check failed", e); el.textContent = "Couldn't check: " + (e?.message || "try again.");
    } finally { busy = false; pingHealth(); }
  }

  // ── settings ────────────────────────────────────────────────────
  function fillSettings(s) {
    for (const key of ["daemonUrl", "channel", "sampleMin", "reAlertMin"]) {
      const el = $(`[data-set="${key}"]`); if (el) el.value = s[key] ?? "";
    }
    for (const key of ["autoSample", "listen", "autoBreakAlert"]) {
      const el = $(`[data-set="${key}"]`); if (el) el.checked = !!s[key];
    }
  }
  function updateLimitHint(s) {
    const el = $("[data-break-limit]"); if (el) el.textContent = `over ${s.limitMin ?? 18} min`;
  }
  async function saveSettings() {
    const patch = {};
    for (const key of ["daemonUrl", "channel"]) patch[key] = $(`[data-set="${key}"]`).value.trim();
    for (const key of ["sampleMin", "reAlertMin"]) patch[key] = Number($(`[data-set="${key}"]`).value) || undefined;
    for (const key of ["autoSample", "listen", "autoBreakAlert"]) patch[key] = $(`[data-set="${key}"]`).checked;
    try {
      settings = await ask("set_settings", { patch });
      $("[data-set-note]").textContent = "Saved.";
      updateLimitHint(settings);
    } catch (e) { $("[data-set-note]").textContent = "Save failed: " + e.message; }
  }
  async function stopEmulator() {
    $("[data-set-note]").textContent = "Stopping…";
    try { await ask("stop_emulator"); $("[data-set-note]").textContent = "Emulator stopped."; }
    catch (e) { $("[data-set-note]").textContent = "Stop failed: " + e.message; }
    finally { pingHealth(); }
  }

  // ── wiring ──────────────────────────────────────────────────────
  $('[data-action="refresh"]').addEventListener("click", refresh);
  $('[data-action="check-breaks"]').addEventListener("click", checkBreaks);
  $('[data-action="save-settings"]').addEventListener("click", saveSettings);
  $('[data-action="stop-emulator"]').addEventListener("click", stopEmulator);

  await loadCached();
  await pingHealth();
  // A light health ping every 30 s while mounted (never drives GIF).
  timers.push(setInterval(pingHealth, 30_000));

  // ── cleanup ─────────────────────────────────────────────────────
  return () => {
    disposed = true;
    for (const t of timers) clearInterval(t);
    link.remove();
  };
}
