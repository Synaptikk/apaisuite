// modules/digitaldashboard/view.js
//
// Single-store (1458) GIF dashboard. Everything comes through the SW handlers
// in service.js, which front the local gif-daemon; since 2026-10-09 the daemon
// is fed by the GIF Companion phone, so a summary read is cheap (cached phone
// readings) and the view refreshes itself every minute while it is open.
//
// Panels: KPI tiles · staffing (board pickers vs picks in GIF, lib/staffing.js)
// · hours by due time · picks-per-hour chart · digital vs store help
// (lib/store_roster.js) · express · break watch · settings.

import { clockText, parseSlot } from "./lib/gif_metrics.js";
import { staffingLine, paceLine, hourLabel } from "./lib/staffing.js";

const n = (x) => (x == null || Number.isNaN(x) ? "—" : Number(x).toLocaleString("en-US"));
const pct = (x) => (x == null ? "—" : `${Number(x).toFixed(1)}%`);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ago = (t) => {
  if (!t) return "";
  const s = Math.round((Date.now() - new Date(t).getTime()) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.floor(s / 3600)} h ago`;
};
const slotShort = (slot) => String(slot).replace(/\s+/g, "").replace("-", "–");

export async function mount(host, container) {
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

  // The SW dispatcher wraps a plain handler result as { ok:true, data } but
  // passes a handler that already returns { ok, … } through flat.
  async function ask(type, payload = {}, opts) {
    const r = await host.messaging.sendRaw(type, payload, opts);
    return (r && r.ok === true && Object.prototype.hasOwnProperty.call(r, "data")) ? r.data : r;
  }

  let summary = null, watch = null, store = null, settings = null;
  let busy = false, disposed = false;
  const timers = [];

  // ── status + notes ─────────────────────────────────────────────
  function note(msg, kind = "info") {
    const el = $("[data-note]");
    if (!msg) { el.hidden = true; return; }
    el.hidden = false; el.textContent = msg; el.className = `status-strip status-strip-${kind}`;
  }

  function setStatus(h) {
    const el = $("[data-status]");
    let text = "Connecting…", cls = "pill-checking";
    if (h && !h.ok) { text = "Offline"; cls = "pill-fail"; }
    else if (h?.source === "phone") {
      const p = h.phone || {};
      if (p.status?.code === "NEEDS_SIGNIN") { text = "GIF needs sign-in"; cls = "pill-warn"; }
      else if (p.lastSeenSec == null || p.lastSeenSec > 180) { text = "Phone not reporting"; cls = "pill-fail"; }
      else if (p.status?.state === "error") { text = "Phone hit a snag"; cls = "pill-warn"; }
      else { text = "Live"; cls = "pill-ok"; }
    } else if (h?.ok) {
      text = h.emulator === "up" ? "Live" : "Starting…"; cls = h.emulator === "up" ? "pill-ok" : "pill-checking";
    }
    el.className = `pill ${cls}`;
    el.textContent = text;
    el.title = h?.phone?.status?.error || "Live GIF data from the companion phone";
  }

  function paintFreshness() {
    const el = $("[data-asof]");
    if (!summary?.asOf) { el.textContent = ""; return; }
    el.textContent = `Updated ${ago(summary.asOf)}`;
    el.classList.toggle("dd-stale", Date.now() - new Date(summary.asOf).getTime() > 6 * 60_000);
  }

  // ── tiles ──────────────────────────────────────────────────────
  function paintTiles() {
    const s = summary, k = s.storeKpis || {}, comp = s.completed || {};
    const tile = (key, v, sub) => {
      $(`[data-tile="${key}"]`).textContent = v;
      const subEl = $(`[data-tile-sub="${key}"]`); if (subEl && sub != null) subEl.textContent = sub;
    };
    const pph = s.pph;
    $('[data-tile-lbl="pph"]').textContent = pph?.full ? "Picks / hr · last 60 min" : "Picks / hr";
    tile("pph", pph ? n(pph.perHour) : "—",
      pph ? (pph.full ? `avg ${n(comp.avgPerHour)} / closed hour` : `pace over the last ${pph.spanMin} min`) : "needs two readings");
    tile("day", n(s.dayPicked), k.dayQty ? `of ${n(k.dayQty)} due today` : comp.peak ? `peak ${slotShort(comp.peak.slot)} ${n(comp.peak.qtyPicked)}` : "");
    const upcomingQty = (s.upcoming || []).reduce((t, u) => t + (u.qty || 0), 0);
    tile("ready", n(s.readyToPick), upcomingQty ? `+ ${n(upcomingQty)} upcoming` : "");
    tile("ontime", pct(k.onTimePickPct), k.preSubPct != null ? `pre-sub ${pct(k.preSubPct)} · post-sub ${pct(k.postSubPct)}` : "");
    tile("rate", k.avgPickRate != null ? n(Math.round(k.avgPickRate)) : "—");
  }

  // ── staffing ───────────────────────────────────────────────────
  function paintStaffing() {
    const plan = summary.staffing;
    const verdict = $("[data-staff-verdict]");
    const box = $("[data-staffing]");
    if (!plan) { verdict.hidden = true; box.innerHTML = `<p class="dd-empty">Nothing left to pick in GIF.</p>`; return; }
    verdict.hidden = false;
    // A due hour falling behind right now outranks the board check.
    // lead with the first due time where adding pickers still helps; else a late/tight one
    const pace = summary.pace || [];
    const behind = pace.find((r) => r.status === "short") || pace.find((r) => r.status === "late" || r.status === "tight");
    const warn = behind || plan.verdict !== "ok";
    verdict.className = "status-strip dd-verdict " + (behind ? "status-strip-warn" : plan.noGrid ? "status-strip-info" : warn ? "status-strip-warn" : "status-strip-ok");
    // who's on the board this hour but not in a pick walk (break watch) — usually the first fix
    const idle = (watch?.suspects || []).filter((x) => x.idleMin == null || x.idleMin >= 5);
    const idleNote = idle.length ? ` · On the board but not picking: ${idle.slice(0, 6).map((x) => x.name).join(", ")}${idle.length > 6 ? ` +${idle.length - 6}` : ""}` : "";
    verdict.textContent = (behind ? paceLine(behind) : staffingLine(plan).replace(/^Staffing: /, "")) + ((behind || warn) ? idleNote : "");
    if (plan.noGrid) { box.innerHTML = ""; }
    else {
      // one row per due time: the orders picked now count GIF's live pickers,
      // the next hour only once started, later hours their scheduled pickers
      const when = (r) => r.pastDue ? "past due"
        : r.kind === "later" ? `${r.scheduled} scheduled`
        : `due ${r.label.replace(/^by /, "")}${r.kind === "next" ? (r.started ? " · started" : " · not started") : ""}`;
      const rows = plan.rows.map((r) => `
        <tr class="${r.add || r.pastDue ? "dd-row-short" : ""}">
          <th scope="row">${esc((r.slots || []).map(slotShort).join(", ") || "Express")} orders</th>
          <td>${esc(when(r))}</td>
          <td class="dd-num">${n(r.left)}${r.expressExpected ? ` <span class="dd-muted" title="express still expected to drop in">(+${n(r.expressExpected)} exp.)</span>` : ""}</td>
          <td class="dd-num">${r.pastDue ? `<span class="badge badge-danger">past due</span>` : r.add ? `<span class="badge badge-warn">add ${r.add}</span>` : r.late ? `<span class="badge badge-warn">a few min late</span>` : `<span class="dd-ok">covered</span>`}</td>
        </tr>`).join("");
      box.innerHTML = `
        <table class="data-table data-table-compact dd-table">
          <thead><tr><th>Orders</th><th>When</th><th class="dd-num">Left</th><th class="dd-num">Add</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
    }
    $("[data-staff-note]").textContent =
      `Each picker picks ~${plan.rate} items/hr ` +
      `${plan.rateFromGif ? "— GIF's live average per person today" : `— default ${plan.rate}/hr × ${Math.round(plan.util * 100)}% until GIF's live rate is read`}. ` +
      `Orders open 2 h before their hour and are due 30 min before it (3pm orders: 1:00–2:30). ` +
      `The orders due next count everyone GIF shows picking; the hour after only once it's started, with the pickers the first one doesn't need; ` +
      `hours further out compare the board's scheduled pickers for the hour they're picked in with one hour of picking. ` +
      (plan.expressPerHour ? `Includes ~${n(plan.expressPerHour)} express items/hr still expected. ` : `No express reserve yet — none closed today to average. `) +
      `Only orders already in GIF count — later hours keep filling up.`;
  }

  // ── hours by due time ──────────────────────────────────────────
  function paintHours() {
    const s = summary;
    const paceBy = Object.fromEntries((s.pace || []).map((r) => [r.slot, r]));
    const paceBadge = (r) => !r ? ""
      : r.status === "late" ? `<span class="badge badge-danger">past due</span>`
      : r.status === "short" ? `<span class="badge badge-warn" title="${esc(paceLine(r))}">~${n(r.short)} short · add ${r.add}</span>`
      : r.status === "tight" ? `<span class="badge badge-warn" title="${esc(paceLine(r))}">a few min late</span>`
      : r.status === "on track" ? `<span class="badge badge-success" title="${esc(paceLine(r))}">on track</span>` : "";
    const open = (s.open || []).map((h) => {
      const done = h.total ? Math.min(100, Math.round((h.picked / h.total) * 100)) : 0;
      const exp = h.expressQty != null ? `<span class="badge badge-info">Express ${n(h.expressQty)}</span>` : "";
      const p = paceBy[h.slot];
      return `<tr>
        <th scope="row">${esc(slotShort(h.slot))}${p ? `<span class="dd-due">due ${esc(p.due)}${p.minutesLeft > 0 ? ` · ${p.minutesLeft} min` : ""}</span>` : ""}</th>
        <td><div class="dd-bar" title="${done}% picked"><span style="width:${done}%"></span></div></td>
        <td class="dd-num">${n(h.picked)} / ${n(h.total)}</td>
        <td class="dd-num">${n(h.left)} left ${exp}</td>
        <td class="dd-num">${paceBadge(p)}</td>
      </tr>`;
    }).join("");
    const up = (s.upcoming || []).map((u) => `<tr class="dd-row-muted">
        <th scope="row">${esc(slotShort(u.slot))}</th>
        <td><span class="dd-muted">upcoming</span></td>
        <td class="dd-num">—</td>
        <td class="dd-num">${n(u.qty)} to pick</td>
        <td></td>
      </tr>`).join("");
    const closed = (s.completedHours || []).slice().sort((a, b) => (parseSlot(a.slot)?.start ?? 0) - (parseSlot(b.slot)?.start ?? 0));
    const done = closed.length
      ? `<p class="dd-closed"><span class="dd-muted">Completed:</span> ${closed.map((c) => `${esc(slotShort(c.slot))} <b>${n(c.qtyPicked)}</b>`).join(" · ")}</p>`
      : "";
    $("[data-hours]").innerHTML = open || up
      ? `<table class="data-table data-table-compact dd-table dd-hours"><tbody>${open}${up}</tbody></table>${done}`
      : `<p class="dd-empty">No open hours in GIF.</p>${done}`;
  }

  // ── chart: picks by order-due hour ─────────────────────────────
  // GIF's own per-slot figures: closed slots (qty picked), open slots (picked
  // so far + what is left) and upcoming slots (left to pick). Meaningful from
  // the first reading, unlike clock-hour bars that need an hour of history
  // (those still feed Digital Metrics' Pick Hours through service.js).
  function paintChart() {
    const s = summary, chart = $("[data-chart]");
    const bars = [
      ...(s.completedHours || []).map((c) => ({ slot: c.slot, done: c.qtyPicked || 0, left: 0, kind: "closed" })),
      ...(s.open || []).map((h) => ({ slot: h.slot, done: h.picked || 0, left: Math.max(0, (h.total ?? 0) - (h.picked ?? 0)), kind: "open" })),
      ...(s.upcoming || []).map((u) => ({ slot: u.slot, done: 0, left: u.qty || 0, kind: "upcoming" })),
    ].map((b) => ({ ...b, start: parseSlot(b.slot)?.start ?? 0 })).sort((a, b) => a.start - b.start);
    const avg = s.completed?.avgPerHour;
    $("[data-chart-sub]").textContent = avg != null ? `Closed hours average ${n(avg)}` : "";
    if (!bars.length) { chart.innerHTML = `<p class="dd-empty">No hours in GIF yet.</p>`; return; }

    const W = Math.max(320, Math.min(760, (chart.clientWidth || 560))), H = 200;
    const L = 40, R = 8, T = 18, B = 26;
    const max = Math.max(...bars.map((b) => b.done + b.left), avg || 0, 1);
    const nice = Math.ceil(max / 500) * 500;
    const y = (v) => T + (H - T - B) * (1 - v / nice);
    const slotW = (W - L - R) / bars.length, bw = Math.min(46, slotW * 0.62);
    const short = (slot) => slotShort(slot).split("–")[0].replace(/(am|pm)$/i, (m) => m[0].toLowerCase());
    const grid = [0, nice / 2, nice].map((v) => `
      <line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="dd-ch-grid"/>
      <text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="dd-ch-axis">${n(v)}</text>`).join("");
    const cols = bars.map((b, i) => {
      const cx = L + slotW * i + slotW / 2, x = cx - bw / 2;
      const top = y(b.done + b.left), mid = y(b.done), base = y(0);
      const done = b.done ? `<rect x="${x}" y="${mid}" width="${bw}" height="${base - mid}" rx="3" class="dd-ch-${b.kind === "closed" ? "done" : "now"}"><title>${esc(b.slot)}: ${n(b.done)} picked</title></rect>` : "";
      const left = b.left ? `<rect x="${x + 0.5}" y="${top + 0.5}" width="${bw - 1}" height="${Math.max(0, mid - top - 1)}" rx="3" class="dd-ch-left"><title>${esc(b.slot)}: ${n(b.left)} left to pick</title></rect>` : "";
      const label = `<text x="${cx}" y="${top - 5}" text-anchor="middle" class="dd-ch-val">${n(b.kind === "closed" ? b.done : b.done + b.left)}</text>`;
      return `${left}${done}${label}<text x="${cx}" y="${H - 8}" text-anchor="middle" class="dd-ch-axis">${esc(short(b.slot))}</text>`;
    }).join("");
    const avgLine = avg != null ? `<line x1="${L}" x2="${W - R}" y1="${y(avg)}" y2="${y(avg)}" class="dd-ch-avg"/>` : "";
    chart.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Items per order-due hour">${grid}${avgLine}${cols}</svg>
      <div class="dd-legend"><span><i class="dd-ch-done"></i>picked (closed hour)</span><span><i class="dd-ch-now"></i>picked so far</span><span><i class="dd-ch-left"></i>left to pick</span>${avg != null ? `<span><i class="dd-ch-avgkey"></i>closed-hour average</span>` : ""}</div>`;
  }

  // ── express ────────────────────────────────────────────────────
  function paintExpress() {
    const live = summary.express;
    const slots = live?.slots || [];
    if (!slots.length) { $("[data-express]").innerHTML = `<p class="dd-empty">No express orders read yet today.</p>`; return; }
    const rows = slots.map((x) => `<tr>
        <th scope="row">${esc(slotShort(x.slot))}</th>
        <td class="dd-num">${n(x.items)}</td>
        <td class="dd-num">${n(x.orders)}</td>
        <td>${x.final ? `<span class="badge badge-neutral">final</span>` : `<span class="badge badge-info">open · ${n(x.remaining)} left</span>`}</td>
      </tr>`).join("");
    const avg = live.avgItemsPerHour != null
      ? `<p class="dd-footnote">Average per closed hour: ${n(live.avgItemsPerHour)} items · ${n(live.avgOrdersPerHour)} orders (${live.closedCount} h). Counts are a floor — picks between readings can hide drop-ins.</p>`
      : `<p class="dd-footnote">Counts are a floor — picks between readings can hide drop-ins.</p>`;
    $("[data-express]").innerHTML = `<table class="data-table data-table-compact dd-table">
        <thead><tr><th>Hour</th><th class="dd-num">Items in</th><th class="dd-num">Orders</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table>${avg}`;
  }

  // ── digital vs store help ──────────────────────────────────────
  function paintSplit() {
    const box = $("[data-split]");
    if (!store) return;
    if (store.error) { box.innerHTML = `<p class="dd-empty">Couldn't count: ${esc(store.error)}</p>`; return; }
    const t = store.totals || {};
    const help = (store.rows || []).filter((r) => r.code !== "Digital" && r.code !== "Exceptions");
    const digitalApprox = t.storeTotal != null ? Math.max(0, t.storeTotal - (t.storeHelpPicks || 0)) : null;
    $("[data-split-sub]").textContent = store.asOf ? `Counted ${ago(store.asOf)}` : "";
    const helpRows = help.filter((r) => r.picks != null || r.status === "picking").slice(0, 12).map((r) => `<tr>
        <th scope="row">${esc(r.name)}</th>
        <td>${r.status === "picking" ? `<span class="badge badge-success">picking</span>` : `<span class="dd-muted">${esc(r.status || "")}</span>`}</td>
        <td class="dd-num">${r.picks != null ? n(r.picks) : `<span class="dd-muted">counting…</span>`}</td>
      </tr>`).join("");
    box.innerHTML = `
      <div class="dd-split">
        <div><span class="dd-split-v">${n(t.digitalPicks ?? digitalApprox)}</span><span class="dd-split-l">Digital picks${t.digitalPicks == null && digitalApprox != null ? " (approx.)" : ""}</span></div>
        <div><span class="dd-split-v">${n(t.storeHelpPicks)}</span><span class="dd-split-l">Store help picks · ${t.storeHelpAssociates ?? 0} people</span></div>
        <div><span class="dd-split-v">${n(t.storeTotal)}</span><span class="dd-split-l">Store total</span></div>
      </div>
      ${t.storeHelpPending ? `<p class="dd-footnote">${t.storeHelpPending} store-help picker${t.storeHelpPending === 1 ? "" : "s"} still being counted, so digital is approximate until they are.</p>` : ""}
      ${helpRows ? `<table class="data-table data-table-compact dd-table"><thead><tr><th>Store help</th><th></th><th class="dd-num">Picks</th></tr></thead><tbody>${helpRows}</tbody></table>` : `<p class="dd-empty">No store-help pickers today.</p>`}`;
  }

  // ── breaks ─────────────────────────────────────────────────────
  function paintBreaks() {
    const el = $("[data-breaks]");
    if (!watch) return;
    if (watch.error) { el.innerHTML = `<p class="dd-empty">Couldn't check: ${esc(watch.error)}</p>`; return; }
    if (!watch.scheduledCount) { el.innerHTML = `<p class="dd-empty">${esc(watch.note || "No one on the board to pick this hour.")}</p>`; return; }
    const over = (watch.suspects || []).filter((s) => s.over);
    const head = `<p class="dd-footnote">${watch.scheduledCount} scheduled to pick this hour · checked ${ago(watch.checkedAt)}</p>`;
    if (!over.length) { el.innerHTML = `<div class="status-strip status-strip-ok">Everyone scheduled is within ${watch.limitMin ?? 18} min.</div>${head}`; return; }
    const rows = over.map((s) => `<tr>
        <th scope="row">${esc(s.name)}</th>
        <td class="dd-num"><span class="badge badge-warn">${s.idleMin} min</span></td>
        <td class="dd-num">last pick ${clockText(s.lastSeen)}</td>
      </tr>`).join("");
    el.innerHTML = `<table class="data-table data-table-compact dd-table"><thead><tr><th>Associate</th><th class="dd-num">Out</th><th class="dd-num"></th></tr></thead><tbody>${rows}</tbody></table>${head}`;
  }

  // ── long-break log (daemon /breaklog, fed by every watch run) ────
  let breakLog = null, breakLogDay = "";
  const hm = (ms) => (ms == null ? "—" : clockText(new Date(ms).getHours() * 60 + new Date(ms).getMinutes()));
  function paintBreakLog() {
    const el = $("[data-breaklog]");
    if (!breakLog) return;
    if (breakLog.error) { el.innerHTML = `<p class="dd-empty">Couldn't load the log: ${esc(breakLog.error)}</p>`; return; }
    const sel = $("[data-breaklog-day]");
    const days = [...new Set([breakLog.today, ...(breakLog.days || [])].filter(Boolean))];
    sel.innerHTML = days.map((d) => `<option value="${esc(d)}"${d === breakLog.day ? " selected" : ""}>${d === breakLog.today ? "Today" : esc(d)}</option>`).join("");
    sel.hidden = days.length < 2;
    const head = container.querySelector(".dd-breaklog-head h3");
    if (head) head.textContent = breakLog.day === breakLog.today ? "Today's long breaks" : `Long breaks ${breakLog.day}`;
    const eps = breakLog.episodes || [];
    if (!eps.length) { el.innerHTML = `<p class="dd-empty">No long breaks logged${breakLog.day === breakLog.today ? " yet today" : " that day"}.</p>`; return; }
    const rows = eps.map((e) => {
      const open = e.status === "open";
      const min = open || e.cleared == null || e.lastSeenActiveAt == null ? e.longestMin
        : Math.max(e.longestMin ?? 0, Math.round((e.cleared - e.lastSeenActiveAt) / 60000));
      return `<tr${open ? ' class="dd-row-short"' : ""}>
        <th scope="row">${esc(e.name)}</th>
        <td class="dd-num">${hm(e.lastSeenActiveAt)}</td>
        <td class="dd-num">${hm(e.firstFlaggedAt)}</td>
        <td class="dd-num">${open ? '<span class="badge badge-warn">still out</span>' : hm(e.cleared)}</td>
        <td class="dd-num">${min == null ? "—" : `${min} min`}</td>
      </tr>`;
    }).join("");
    const open = eps.filter((e) => e.status === "open").length;
    el.innerHTML = `<table class="data-table data-table-compact dd-table"><thead><tr><th>Associate</th><th class="dd-num">Went inactive</th><th class="dd-num">Flagged</th><th class="dd-num">Back</th><th class="dd-num">Minutes</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="dd-footnote">${eps.length} logged${open ? ` · ${open} still out` : ""}${breakLog.lastAt ? ` · watch ran ${ago(breakLog.lastAt)}` : ""}</p>`;
  }
  async function loadBreakLog(day = breakLogDay) {
    try { breakLog = await ask("break_log", { day: day || undefined }, { timeoutMs: 20_000 }); }
    catch (e) { breakLog = { error: e?.message || "try again" }; }
    if (!disposed) paintBreakLog();
  }

  function paintSummary() {
    if (!summary || disposed) return;
    // One panel choking on an odd (e.g. older cached) summary must not blank the rest.
    for (const paint of [paintFreshness, paintTiles, paintStaffing, paintHours, paintChart, paintExpress]) {
      try { paint(); } catch (e) { console.warn(`[digitaldashboard] ${paint.name} failed:`, e?.message ?? e); }
    }
  }

  // ── data ───────────────────────────────────────────────────────
  async function loadCached() {
    const [cs, cw, cst, st] = await Promise.all([
      ask("cached_summary").catch(() => null),
      ask("cached_watch").catch(() => null),
      ask("cached_store").catch(() => null),
      ask("get_settings").catch(() => null),
    ]);
    if (cs?.data) { summary = cs.data; paintSummary(); }
    if (cw) { watch = cw; paintBreaks(); }
    if (cst?.data) { store = cst.data; paintSplit(); }
    if (st) { settings = st; fillSettings(st); }
  }

  async function pingHealth() {
    const h = await ask("health").catch((e) => ({ ok: false, error: e.message }));
    if (!disposed) setStatus(h);
    return h;
  }

  async function refresh({ quiet = false } = {}) {
    if (busy) return;
    busy = true;
    const btn = $('[data-action="refresh"]');
    btn.disabled = true;
    if (!quiet) note("");
    try {
      summary = await ask("summary", { maxAge: 120, wait: 60 }, { timeoutMs: 150_000 });
      paintSummary();
      if (summary?.stale) note("Showing the last reading; the phone hasn't sent a newer one yet.", "warn");
      else if (!quiet) note("");
    } catch (e) {
      if (!quiet) note(e?.message || "Refresh failed — try again.", "error");
    } finally { busy = false; btn.disabled = false; pingHealth(); }
  }

  async function withButton(sel, label, fn) {
    const btn = $(sel); const was = btn.textContent;
    btn.disabled = true; btn.textContent = label;
    try { await fn(); } finally { btn.disabled = false; btn.textContent = was; }
  }

  const checkBreaks = () => withButton('[data-action="check-breaks"]', "Checking…", async () => {
    try { watch = await ask("check_breaks", { maxAge: 60, wait: 150 }, { timeoutMs: 240_000 }); }
    catch (e) { watch = { error: e?.message || "try again" }; }
    paintBreaks();
    loadBreakLog();
  });

  const refreshStore = () => withButton('[data-action="refresh-store"]', "Counting…", async () => {
    try { store = await ask("store", { pass: true, budget: 5, wait: 150 }, { timeoutMs: 240_000 }); }
    catch (e) { store = { error: e?.message || "try again" }; }
    paintSplit();
  });

  // ── settings ───────────────────────────────────────────────────
  function fillSettings(s) {
    for (const key of ["daemonUrl", "channel", "sampleMin", "reAlertMin"]) {
      const el = $(`[data-set="${key}"]`); if (el) el.value = s[key] ?? "";
    }
    for (const key of ["autoSample", "listen", "autoBreakAlert"]) {
      const el = $(`[data-set="${key}"]`); if (el) el.checked = !!s[key];
    }
    $("[data-break-limit]").textContent = `Scheduled pickers out of a pick walk over ${s.limitMin ?? 18} min`;
  }
  async function saveSettings() {
    const patch = {};
    for (const key of ["daemonUrl", "channel"]) patch[key] = $(`[data-set="${key}"]`).value.trim();
    for (const key of ["sampleMin", "reAlertMin"]) patch[key] = Number($(`[data-set="${key}"]`).value) || undefined;
    for (const key of ["autoSample", "listen", "autoBreakAlert"]) patch[key] = $(`[data-set="${key}"]`).checked;
    try {
      settings = await ask("set_settings", { patch });
      $("[data-set-note]").textContent = "Saved.";
      fillSettings(settings);
    } catch (e) { $("[data-set-note]").textContent = "Save failed: " + e.message; }
  }

  // ── wiring ─────────────────────────────────────────────────────
  $('[data-action="refresh"]').addEventListener("click", () => refresh());
  $('[data-action="check-breaks"]').addEventListener("click", checkBreaks);
  $('[data-action="refresh-store"]').addEventListener("click", refreshStore);
  $("[data-breaklog-day]").addEventListener("change", (ev) => {
    breakLogDay = ev.target.value === breakLog?.today ? "" : ev.target.value;
    loadBreakLog();
  });
  $('[data-action="save-settings"]').addEventListener("click", saveSettings);

  await loadCached();
  pingHealth();
  refresh({ quiet: true });
  loadBreakLog();
  // Phone-fed summaries are cheap: refresh every minute, health + "x min ago" every 30 s.
  timers.push(setInterval(() => refresh({ quiet: true }), 60_000));
  timers.push(setInterval(() => loadBreakLog(), 60_000));   // the watch runs every 3 min
  timers.push(setInterval(() => { pingHealth(); paintFreshness(); }, 30_000));

  return () => {
    disposed = true;
    for (const t of timers) clearInterval(t);
    link.remove();
  };
}
