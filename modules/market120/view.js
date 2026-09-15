// modules/market120/view.js
//
// Full-page dashboard mount. Loads view.html, wires the Refresh buttons,
// subscribes to source_complete broadcasts, and re-renders on each update.

import { computeAlerts, fmtAlertValue, hasRealKpis } from "./lib/alerts.js";
import { hbarSvg, donutSvg, CHART_COLORS } from "./lib/charts.js";
import { summarize as summarizeIsa, storeSummary as isaStoreSummary } from "./lib/isa_review.js";

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
  const btnAll       = container.querySelector('[data-action="refresh-all"]');
  const btnClearance = container.querySelector('[data-action="refresh-clearance"]');
  const btnIsa       = container.querySelector('[data-action="refresh-isa"]');
  const btnStores    = container.querySelector('[data-action="refresh-stores"]');

  // 4. Wire click handlers.
  btnAll.addEventListener("click", () => runPull("pull_all", [btnAll, btnClearance, btnIsa, btnStores]));
  btnClearance.addEventListener("click", () => runPull("pull_clearance", [btnClearance]));
  btnIsa.addEventListener("click", () => runPull("pull_isa", [btnIsa]));
  if (btnStores) btnStores.addEventListener("click", () => runPull("pull_stores", [btnStores]));

  // Store drill-down: WoW rows expand inline. Delegated on the tbody because
  // its rows are re-rendered on every paint.
  const wowBody = container.querySelector("[data-wow-body]");
  let openStore = null;
  let lastDetail = null;
  let detailSeq = 0;
  let detailInFlight = null;
  wowBody?.addEventListener("click", onWowClick);
  wowBody?.addEventListener("keydown", onWowKey);

  // ISA review: interactive panel under the ISA tiles (delegated — its body
  // is re-rendered on every change).
  const isaBody = container.querySelector("[data-isa-body]");
  const isaScope = container.querySelector("[data-isa-scope]");
  const isa = {
    review: null, sum: null, days: 14, presets: [7, 14, 28],
    reasons: new Set(), sort: { key: "dollars", dir: 1 },
    openStore: null, detail: new Map(), detailSeq: 0, busy: false,
  };
  isaBody?.addEventListener("click", onIsaClick);
  isaBody?.addEventListener("keydown", onIsaKey);

  // 5. Initial paint from persisted state.
  await paint();

  // 6. Re-paint when any source completes (background alarms, other tabs, etc.).
  const unsub = host.messaging.on("source_complete", () => { paint(); });

  // ── Helpers ─────────────────────────────────────────────────────
  async function runPull(type, buttons) {
    setBusy(buttons, true);
    try {
      await host.messaging.send(type);
    } catch (e) {
      console.warn(`[market120] ${type} failed:`, e?.message ?? e);
    } finally {
      setBusy(buttons, false);
      await paint();
    }
  }

  function setBusy(buttons, busy) {
    for (const btn of buttons) {
      btn.disabled = busy;
      const spinner = btn.querySelector(".btn-spinner");
      if (spinner) spinner.hidden = !busy;
    }
  }

  async function paint() {
    let state;
    try {
      state = await host.messaging.send("get_state");
    } catch (e) {
      console.warn("[market120] get_state failed:", e?.message ?? e);
      return;
    }

    paintFamily("clearance", state.clearance);
    paintFamily("isa",       state.isa);
    paintAlerts(state);
    paintDebug(state);
    await paintIsaReview();
    await paintWoW();
  }

  // Week-over-week store table. Fetched separately from get_state so the
  // history computation stays isolated from the KPI-family state shape.
  async function paintWoW() {
    const body = container.querySelector("[data-wow-body]");
    const meta = container.querySelector("[data-wow-meta]");
    const freshEl = container.querySelector('[data-freshness="stores"]');
    if (!body) return;

    let res;
    try {
      res = await host.messaging.send("get_wow");
    } catch (e) {
      console.warn("[market120] get_wow failed:", e?.message ?? e);
      return;
    }

    if (freshEl) {
      const { text, state } = renderFreshness(res.freshness);
      freshEl.textContent = text;
      freshEl.dataset.state = state;
    }

    // Render the report-style breakdown (insights, KPIs, charts) from the
    // same payload — it rides along on get_wow to save a round-trip.
    paintBreakdown(res.breakdown);

    const wow = res.wow || {};
    const rows = wow.rows || [];

    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="7" class="mkt120-empty">No store snapshot captured yet. Click Refresh to record this week's baseline.</td></tr>`;
      openStore = null;
      lastDetail = null;
      if (meta) meta.textContent = "";
      return;
    }

    if (meta) {
      if (wow.priorWeek) {
        meta.textContent = `Comparing ${wow.currentWeek} vs ${wow.priorWeek} · ${rows.length} stores · ${wow.weekCount} weeks on record.`;
      } else {
        meta.textContent = `${wow.currentWeek} baseline · ${rows.length} stores. Week-over-week deltas appear after next week's snapshot.`;
      }
    }

    body.innerHTML = rows.map((r) => `
      <tr data-store="${escapeHtml(r.store)}" tabindex="0" role="button" aria-expanded="false" title="Show store detail"${r.isNew ? ' class="mkt120-wow-new"' : ""}>
        <td class="mkt120-wow-store">#${escapeHtml(r.store)}${r.isNew ? ' <span class="mkt120-wow-badge">new</span>' : ""}</td>
        <td class="num">${money(r.dollars)}</td>
        <td class="num ${deltaClass(r.dDollars)}">${deltaMoney(r.dDollars)}</td>
        <td class="num ${deltaClass(r.dDollars)}">${pctText(r.pctDollars)}</td>
        <td class="num">${int(r.units)}</td>
        <td class="num ${deltaClass(r.dUnits)}">${deltaInt(r.dUnits)}</td>
        <td class="num ${deltaClass(r.dUnits)}">${pctText(r.pctUnits)}</td>
      </tr>`).join("");

    // Keep an open store detail open across repaints (e.g. after Refresh).
    if (openStore) {
      const tr = body.querySelector(`tr[data-store="${CSS.escape(openStore)}"]`);
      if (!tr) {
        openStore = null;
        lastDetail = null;
      } else {
        insertDetailRow(tr, openStore);
        if (lastDetail?.store === openStore) renderStoreDetail(lastDetail, { loading: detailInFlight === openStore });
        else if (detailInFlight !== openStore) loadDetail(openStore);
      }
    }
  }

  // Report-style Market 120 breakdown: exec insights, KPI grid, and two
  // inline-SVG charts. Driven entirely off the persisted breakdown snapshot.
  function paintBreakdown(bd) {
    const section = container.querySelector("[data-breakdown-section]");
    if (!section) return;
    if (!bd || !bd.market120) { section.hidden = true; return; }
    section.hidden = false;

    const m = bd.market120;
    const nat = bd.national;

    const asOf = container.querySelector("[data-breakdown-asof]");
    if (asOf) {
      asOf.textContent = bd.capturedAt ? `as of ${new Date(bd.capturedAt).toLocaleString("en-US")}` : "";
    }

    // Executive insights (top). These are our own HTML strings (only <b> tags).
    const insList = container.querySelector("[data-insights-list]");
    if (insList) insList.innerHTML = (bd.insights || []).map((i) => `<li>${i}</li>`).join("");

    // KPI grid.
    const kpiWrap = container.querySelector("[data-bd-kpis]");
    if (kpiWrap) {
      const cards = [
        ["Market 120 C/D $", money(m.dollars), bd.pctDollars != null ? `${bd.pctDollars.toFixed(1)}% of national` : "market total"],
        ["Market 120 C/D Units", int(m.units), bd.pctUnits != null ? `${bd.pctUnits.toFixed(1)}% of national` : "market total"],
        ["Market 120 Stores", int(m.storeCount), "reporting"],
        ["Deleted $ (Mkt 120)", money(m.delDol), `${bd.delShareDol.toFixed(0)}% of C/D $`],
      ];
      if (nat) {
        cards.push(["National C/D $", money(nat.dollars), "all markets"]);
        cards.push(["National C/D Units", int(nat.units), "all markets"]);
      }
      kpiWrap.innerHTML = cards.map(([label, val, sub]) => `
        <div class="mkt120-bd-kpi">
          <div class="mkt120-bd-kpi-label">${escapeHtml(label)}</div>
          <div class="mkt120-bd-kpi-val">${escapeHtml(val)}</div>
          <div class="mkt120-bd-kpi-sub"><span class="mkt120-chip">${escapeHtml(sub)}</span></div>
        </div>`).join("");
    }

    // Top-stores horizontal bar chart.
    const storesEl = container.querySelector("[data-chart-stores]");
    if (storesEl) {
      const data = (bd.topStores || []).map((s) => ({ label: "#" + s.store, value: Math.round(s.dollars) }));
      storesEl.innerHTML = hbarSvg(data, { color: CHART_COLORS.blue, fmt: (v) => "$" + (v / 1000).toFixed(0) + "K" });
    }

    // Clearance vs Deleted donut.
    const splitEl = container.querySelector("[data-chart-split]");
    if (splitEl) {
      const data = [
        { label: "Clearance $", value: Math.round(m.clrDol), color: CHART_COLORS.spark },
        { label: "Deleted $", value: Math.round(m.delDol), color: CHART_COLORS.blue },
      ];
      splitEl.innerHTML = donutSvg(data, { centerLabel: money(m.dollars), fmt: (v) => money(v) });
    }

    // Bottom-line summary.
    const blList = container.querySelector("[data-bottomline-list]");
    if (blList) {
      const top3 = (bd.topStores || []).slice(0, 3).map((s) => "#" + s.store).join(", ");
      const lines = [
        `Market 120 = <b>${money(m.dollars)}</b> C/D exposure${bd.pctDollars != null ? ` (${bd.pctDollars.toFixed(1)}% national)` : ""}, concentrated in deleted inventory.`,
        `Focus stores: ${top3 || "—"} — highest $ impact.`,
        `Deleted drives <b>${bd.delShareDol.toFixed(0)}%</b> of C/D dollars — prioritise deletion-reason review over clearance markdown depth.`,
        `Next: reconcile category concentration to Market 120 and track the week-over-week movers below.`,
      ];
      blList.innerHTML = lines.map((l) => `<li>${l}</li>`).join("");
    }
  }

  // ── ISA review ─────────────────────────────────────────────
  async function paintIsaReview() {
    if (!isaBody) return;
    let res;
    try { res = await host.messaging.send("get_isa_review"); }
    catch (e) { console.warn("[market120] get_isa_review failed:", e?.message ?? e); return; }
    const prevWindow = isa.review?.window;
    isa.review = res.review || null;
    isa.days = res.settings?.days || isa.days;
    isa.presets = res.presets || isa.presets;
    if (isa.review) {
      const w = isa.review.window;
      if (!prevWindow || prevWindow.from !== w.from || prevWindow.to !== w.to) isa.detail.clear();
      for (const r of [...isa.reasons]) if (!isa.review.reasons.includes(r)) isa.reasons.delete(r);
      if (isa.openStore && !isa.review.stores.includes(isa.openStore)) isa.openStore = null;
    }
    renderIsa();
  }

  const isaReasonList = () => (isa.reasons.size ? [...isa.reasons] : null);

  function renderIsa() {
    const rv = isa.review;
    if (isaScope) {
      isaScope.textContent = rv
        ? `Market ${rv.market} · all adjustment reasons · ${fmtRange(rv.window)} (${rv.window.days} days, data through ${fmtDay(rv.dataThrough)}) · ` +
          `Stolen Adj $ is fiscal year to date since ${fmtDay(rv.fyFrom)} · read directly from Power BI, not the reports' saved filters`
        : "";
    }
    if (!rv) {
      isaBody.innerHTML = `<p class="mkt120-empty">No ISA review loaded yet. Click Refresh on ISA Activity — it reads Market 120 from Power BI in a background tab.</p>`;
      return;
    }
    const reasons = isaReasonList();
    const sum = summarizeIsa(rv, { reasons });
    isa.sum = sum;
    const parts = [];

    parts.push(`<div class="mkt120-isa-controls">
      <div class="mkt120-isa-seg" role="group" aria-label="Review window">${isa.presets.map((d) =>
        `<button class="mkt120-isa-segbtn" data-isa-action="days" data-days="${d}" aria-pressed="${d === rv.window.days}"${isa.busy ? " disabled" : ""}>${d} days</button>`).join("")}</div>
      <span class="mkt120-sd-meta">${isa.busy ? "Loading from Power BI…" : `${escapeHtml(fmtRange(rv.window))} · data through ${escapeHtml(fmtDay(rv.dataThrough))} · pulled ${escapeHtml(new Date(rv.capturedAt).toLocaleString("en-US"))}`}</span>
    </div>`);

    const maxReason = Math.max(1, ...sum.byReason.map((r) => Math.abs(r.dollars)));
    parts.push(`<div class="mkt120-isa-chips" role="group" aria-label="Adjustment reasons">
      <button class="mkt120-isa-chip" data-isa-action="all-reasons" aria-pressed="${isa.reasons.size === 0}"><span>All reasons</span></button>
      ${sum.byReason.map((r) => `<button class="mkt120-isa-chip" data-isa-action="reason" data-reason="${escapeHtml(r.reason)}" aria-pressed="${isa.reasons.has(r.reason)}" title="${escapeHtml(int(r.lines))} lines · ${escapeHtml(int(r.qty))} units">
        <span>${escapeHtml(r.reason)}</span><b>${escapeHtml(smoney(r.dollars))}</b><i style="width:${Math.max(3, Math.round((Math.abs(r.dollars) / maxReason) * 100))}%"></i></button>`).join("")}
    </div>`);

    const stolenFy = (sum.brFyByType || []).find((t) => t.type === "Stolen");
    const stolenWin = (sum.brWindowByType || []).find((t) => t.type === "Stolen");
    const cards = [
      ["Adjusted $", smoney(sum.total), reasons ? reasons.join(", ") : "all reasons"],
      ["Adjusted units", int(sum.qty), `${int(sum.lines)} lines`],
      ["Avg per store", sum.storeAvg == null ? "—" : smoney(sum.storeAvg), `${sum.stores.length} stores`],
      ["Stolen $ (window)", stolenWin ? smoney(stolenWin.dollars) : "—", rv.br?.window ? "Backroom Adjustments" : "Backroom Adjustments unavailable"],
      ["Stolen $ (FY)", stolenFy ? smoney(stolenFy.dollars) : "—", `since ${fmtDay(rv.fyFrom)}`],
    ];
    parts.push(`<div class="mkt120-sd-cards">${cards.map(([label, val, sub]) => `
      <div class="mkt120-sd-card"><div class="mkt120-sd-label">${escapeHtml(label)}</div><div class="mkt120-sd-val">${escapeHtml(val)}</div><div class="mkt120-sd-sub">${escapeHtml(sub)}</div></div>`).join("")}</div>`);

    parts.push(`<div class="mkt120-sd-head"><h3>Daily adjusted $</h3><span class="mkt120-sd-meta">${LOOKBACK_LABEL} · review window highlighted</span></div>
      <div class="mkt120-isa-trend">${trendSvg(sum.trend, rv.window)}</div>`);

    parts.push(`<div class="mkt120-sd-grid">` +
      isaRollup("Top categories", sum.topCats, (x) => `${x.cat || "—"} · D${x.dept}`) +
      isaRollup("Top departments", sum.topDepts, (x) => `Dept ${x.dept || "—"}`) +
      `</div>`);

    const stores = sortIsaStores(sum.stores);
    const maxStore = Math.max(1, ...stores.map((s) => Math.abs(s.dollars)));
    const th = (key, label, num = true) => {
      const on = isa.sort.key === key;
      return `<th class="${num ? "num " : ""}mkt120-isa-sort" data-isa-action="sort" data-key="${key}" aria-sort="${on ? (isa.sort.dir === 1 ? "ascending" : "descending") : "none"}" title="Sort">${label}${on ? (isa.sort.dir === 1 ? " ▲" : " ▼") : ""}</th>`;
    };
    parts.push(`<div class="mkt120-sd-head"><h3>Stores</h3><span class="mkt120-sd-meta">click a column to sort · click a store for categories, sources, items and stolen detail</span></div>
      <div class="mkt120-wow-table-wrap"><table class="mkt120-wow-table mkt120-isa-stores">
        <thead><tr>${th("store", "Store", false)}${th("dollars", "Adjusted $")}<th aria-hidden="true"></th><th>Largest reason</th>${th("qty", "Units")}${th("stolenWindow", "Stolen (window)")}${th("stolenFy", "Stolen (FY)")}</tr></thead>
        <tbody>${stores.map((s) => isaStoreRow(s, maxStore)).join("") || `<tr><td colspan="7" class="mkt120-empty">No stores for the selected reasons.</td></tr>`}</tbody>
      </table></div>`);

    isaBody.innerHTML = parts.join("");
    if (isa.openStore) renderIsaStoreDetail(isa.openStore);
  }

  const LOOKBACK_LABEL = "last 6 weeks";

  function sortIsaStores(stores) {
    const { key, dir } = isa.sort;
    const val = (s) => (key === "store" ? Number(s.store) : (s[key] ?? 0));
    return [...stores].sort((a, b) => (val(a) - val(b)) * dir);
  }

  function isaStoreRow(s, max) {
    const top = Object.entries(s.byReason).sort((a, b) => a[1] - b[1])[0];
    const open = isa.openStore === s.store;
    return `<tr data-isa-store="${escapeHtml(s.store)}" tabindex="0" role="button" aria-expanded="${open}" title="Show store detail">
        <td class="mkt120-wow-store">#${escapeHtml(s.store)} <span class="mkt120-sd-meta">rank ${s.rank}</span></td>
        <td class="num">${escapeHtml(smoney(s.dollars))}</td>
        <td class="mkt120-sd-barcell"><div class="mkt120-sd-bar" style="width:${Math.max(2, Math.round((Math.abs(s.dollars) / max) * 100))}%"></div></td>
        <td>${top ? `${escapeHtml(top[0])} <span class="mkt120-sd-meta">${escapeHtml(smoney(top[1]))}</span>` : "—"}</td>
        <td class="num">${escapeHtml(int(s.qty))}</td>
        <td class="num">${s.stolenWindow == null ? "—" : escapeHtml(smoney(s.stolenWindow))}</td>
        <td class="num">${s.stolenFy == null ? "—" : escapeHtml(smoney(s.stolenFy))}</td>
      </tr>` +
      (open ? `<tr class="mkt120-wow-detail-row" data-isa-detail-for="${escapeHtml(s.store)}"><td colspan="7"><div class="mkt120-sd" data-isa-sd><p class="mkt120-empty">Loading store detail…</p></div></td></tr>` : "");
  }

  function isaRollup(title, rows, label, { units = true } = {}) {
    const max = Math.max(1, ...rows.map((x) => Math.abs(x.dollars)));
    return `<div class="mkt120-wow-table-wrap"><table><thead><tr><th>${escapeHtml(title)}</th><th class="num">$</th>${units ? `<th class="num">Units</th>` : ""}<th aria-hidden="true"></th></tr></thead><tbody>` +
      (rows.slice(0, 10).map((x) => `<tr><td>${escapeHtml(label(x))}</td><td class="num">${escapeHtml(smoney(x.dollars))}</td>` +
        (units ? `<td class="num">${escapeHtml(int(x.qty))}</td>` : "") +
        `<td class="mkt120-sd-barcell"><div class="mkt120-sd-bar" style="width:${Math.max(2, Math.round((Math.abs(x.dollars) / max) * 100))}%"></div></td></tr>`).join("") ||
        `<tr><td colspan="4" class="mkt120-empty">None</td></tr>`) +
      `</tbody></table></div>`;
  }

  function onIsaClick(e) {
    const el = e.target.closest("[data-isa-action]");
    if (el && isaBody.contains(el)) {
      const action = el.dataset.isaAction;
      if (action === "days") {
        const d = Number(el.dataset.days);
        if (!isa.busy && d !== isa.review?.window?.days) reloadIsa(d);
      } else if (action === "reason") {
        const r = el.dataset.reason;
        if (isa.reasons.has(r)) isa.reasons.delete(r); else isa.reasons.add(r);
        renderIsa();
      } else if (action === "all-reasons") {
        isa.reasons.clear();
        renderIsa();
      } else if (action === "sort") {
        const key = el.dataset.key;
        isa.sort = { key, dir: isa.sort.key === key ? -isa.sort.dir : 1 };
        renderIsa();
      } else if (action === "detail-refresh") {
        if (isa.openStore) loadIsaStoreDetail(isa.openStore, { refresh: true });
      }
      return;
    }
    const tr = e.target.closest("tr[data-isa-store]");
    if (tr && isaBody.contains(tr)) toggleIsaStore(tr.dataset.isaStore);
  }

  function onIsaKey(e) {
    if ((e.key === "Enter" || e.key === " ") && e.target.matches?.("tr[data-isa-store]")) {
      e.preventDefault();
      toggleIsaStore(e.target.dataset.isaStore);
    }
  }

  function toggleIsaStore(store) {
    isa.openStore = isa.openStore === store ? null : store;
    renderIsa();
    if (isa.openStore) {
      loadIsaStoreDetail(store);
      isaBody.querySelector(`tr[data-isa-store="${CSS.escape(store)}"]`)?.focus();
    }
  }

  async function reloadIsa(days) {
    isa.busy = true;
    renderIsa();
    try { await host.messaging.send("pull_isa", { days }); }
    catch (e) { console.warn("[market120] pull_isa failed:", e?.message ?? e); }
    finally { isa.busy = false; await paint(); }
  }

  // Storage-cached detail is instant; otherwise the SW reads Power BI.
  async function loadIsaStoreDetail(store, { refresh = false } = {}) {
    const seq = ++isa.detailSeq;
    const prior = isa.detail.get(store);
    if (prior?.detail && !refresh) { renderIsaStoreDetail(store); return; }
    isa.detail.set(store, { detail: prior?.detail || null, error: null, loading: true });
    renderIsaStoreDetail(store);
    let res;
    try { res = await host.messaging.send("get_isa_store_detail", { store, refresh }); }
    catch (e) { res = { detail: prior?.detail || null, detailError: String(e?.message ?? e) }; }
    isa.detail.set(store, { detail: res.detail || prior?.detail || null, error: res.detailError || null, loading: false });
    if (seq === isa.detailSeq && isa.openStore === store) renderIsaStoreDetail(store);
  }

  function renderIsaStoreDetail(store) {
    const el = isaBody?.querySelector(`tr[data-isa-detail-for="${CSS.escape(store)}"] [data-isa-sd]`);
    if (!el || !isa.review || !isa.sum) return;
    const reasons = isaReasonList();
    const ss = isaStoreSummary(isa.review, store, { reasons });
    const row = isa.sum.stores.find((s) => s.store === store);
    const parts = [];

    const reasonRows = row ? Object.entries(row.byReason).map(([reason, dollars]) => ({ reason, dollars })).sort((a, b) => a.dollars - b.dollars) : [];
    parts.push(`<div class="mkt120-sd-grid">
      ${isaRollup("By reason", reasonRows, (x) => x.reason, { units: false })}
      <div><div class="mkt120-sd-meta">Daily adjusted $ · ${LOOKBACK_LABEL}</div><div class="mkt120-isa-trend">${trendSvg(ss.trend, isa.review.window, { height: 110 })}</div></div>
    </div>`);
    parts.push(`<div class="mkt120-sd-grid">` +
      isaRollup("Top categories", ss.topCats, (x) => `${x.cat || "—"} · D${x.dept}`) +
      isaRollup("Adjustment source", ss.sources, (x) => x.source || "—", { units: false }) +
      `</div>`);

    const d = isa.detail.get(store);
    const head = (meta) => `<div class="mkt120-sd-head"><h3>Top items</h3><span class="mkt120-sd-meta">${meta}</span>` +
      `<button class="btn btn-secondary btn-sm" data-isa-action="detail-refresh"${d?.loading ? " disabled" : ""}>${d?.loading ? "Loading…" : "Refresh detail"}</button></div>`;

    if (!d?.detail) {
      parts.push(head(""));
      parts.push(d?.error && !d.loading
        ? `<p class="mkt120-debug-error">${escapeHtml(d.error)}</p>`
        : `<p class="mkt120-empty">Reading this store's adjustment lines from Power BI…</p>`);
    } else {
      const det = d.detail;
      const items = det.items.items.filter((it) => !reasons || reasons.includes(it.reason)).slice(0, 25);
      parts.push(head(`${escapeHtml(int(det.items.itemCount))} items · ${escapeHtml(int(det.items.lines))} lines · ${escapeHtml(smoney(det.items.total))} · pulled ${escapeHtml(new Date(det.capturedAt).toLocaleString("en-US"))}${d.loading ? " · refreshing…" : ""}`));
      if (d.error) parts.push(`<p class="mkt120-debug-error">${escapeHtml(d.error)}</p>`);
      parts.push(`<div class="mkt120-wow-table-wrap"><table><thead><tr><th>Item</th><th>Description</th><th>Category</th><th>Reason</th><th>Source</th><th>Dates</th><th class="num">Units</th><th class="num">$</th></tr></thead><tbody>` +
        (items.map((it) => `<tr><td>${escapeHtml(it.item)}</td><td>${escapeHtml(it.desc)}</td><td>${escapeHtml(it.cat)} <span class="mkt120-sd-meta">D${escapeHtml(it.dept)}</span></td>` +
          `<td>${escapeHtml(it.reason)}</td><td>${escapeHtml(it.sources)}</td>` +
          `<td>${escapeHtml(fmtDay(it.firstDate))}${it.lastDate && it.lastDate !== it.firstDate ? `–${escapeHtml(fmtDay(it.lastDate))}` : ""}</td>` +
          `<td class="num">${escapeHtml(int(it.qty))}</td><td class="num">${escapeHtml(smoney(it.dollars))}</td></tr>`).join("") ||
          `<tr><td colspan="8" class="mkt120-empty">No items for the selected reasons.</td></tr>`) +
        `</tbody></table></div>`);

      const st = det.stolen;
      parts.push(`<div class="mkt120-sd-head"><h3>Stolen — Backroom Adjustments</h3><span class="mkt120-sd-meta">fiscal year since ${escapeHtml(fmtDay(det.fyFrom))}` +
        (st ? ` · ${escapeHtml(smoney(st.total))} · ${escapeHtml(int(st.qty))} units · last ${escapeHtml(fmtDay(st.lastDate))}` : "") + `</span></div>`);
      if (!st) {
        parts.push(`<p class="mkt120-debug-error">${escapeHtml(det.stolenError || "Stolen detail unavailable.")}</p>`);
      } else {
        parts.push(`<div class="mkt120-sd-grid">` +
          isaRollup("Adjusted by user", st.byUser, (x) => x.user) +
          isaRollup("Stolen by category", st.byCategory, (x) => x.cat) +
          `</div>`);
        parts.push(`<div class="mkt120-wow-table-wrap"><table><thead><tr><th>Item</th><th>Description</th><th>Category</th><th>Users</th><th>Last</th><th class="num">Units</th><th class="num">$</th></tr></thead><tbody>` +
          (st.items.slice(0, 15).map((it) => `<tr><td>${escapeHtml(it.item)}</td><td>${escapeHtml(it.desc)}</td><td>${escapeHtml(it.cat)}</td><td>${escapeHtml(it.users)}</td>` +
            `<td>${escapeHtml(fmtDay(it.lastDate))}</td><td class="num">${escapeHtml(int(it.qty))}</td><td class="num">${escapeHtml(smoney(it.dollars))}</td></tr>`).join("") ||
            `<tr><td colspan="7" class="mkt120-empty">No stolen adjustments this fiscal year.</td></tr>`) +
          `</tbody></table></div>`);
      }
    }
    el.innerHTML = parts.join("");
  }

  function trendSvg(points, window, { height = 130 } = {}) {
    if (!points.length) return `<p class="mkt120-empty">No daily data.</p>`;
    const DAYMS = 86_400_000;
    const start = Date.parse(`${points[0].date}T00:00:00Z`);
    const end = Date.parse(`${points.at(-1).date}T00:00:00Z`);
    const days = Math.round((end - start) / DAYMS) + 1;
    const byDate = new Map(points.map((p) => [p.date, p.dollars]));
    const max = Math.max(1, ...points.map((p) => Math.abs(p.dollars)));
    const W = 640, H = height, pad = 12, base = H - 18, bw = (W - 2 * pad) / days;
    let bars = "";
    for (let i = 0; i < days; i++) {
      const date = new Date(start + i * DAYMS).toISOString().slice(0, 10);
      const v = byDate.get(date) || 0;
      const h = Math.round((Math.abs(v) / max) * (base - 6));
      const inWin = date >= window.from && date < window.to;
      bars += `<rect class="${inWin ? "in" : "out"}" x="${(pad + i * bw + 1).toFixed(1)}" y="${base - h}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${h}"><title>${escapeHtml(fmtDay(date))}: ${escapeHtml(smoney(v))}</title></rect>`;
    }
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily adjusted dollars">${bars}` +
      `<text class="lbl" x="${pad}" y="${H - 4}">${escapeHtml(fmtDay(points[0].date))}</text>` +
      `<text class="lbl" x="${W - pad}" y="${H - 4}" text-anchor="end">${escapeHtml(fmtDay(points.at(-1).date))}</text></svg>`;
  }

  function fmtDay(ymdStr) {
    if (!ymdStr) return "—";
    return new Date(`${ymdStr}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  }
  // Windows are [from, to): show the last included day.
  function fmtRange(w) {
    const last = new Date(Date.parse(`${w.to}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    return `${fmtDay(w.from)}–${fmtDay(last)}`;
  }
  function smoney(v) {
    const x = Math.round(Number(v) || 0);
    return `${x < 0 ? "−" : ""}$${Math.abs(x).toLocaleString("en-US")}`;
  }

  // ── Store drill-down ───────────────────────────────────────
  function onWowClick(e) {
    if (e.target.closest("[data-sd-refresh]")) {
      if (openStore) loadDetail(openStore, { refresh: true });
      return;
    }
    const tr = e.target.closest("tr[data-store]");
    if (tr && wowBody.contains(tr)) toggleStore(tr.dataset.store);
  }

  function onWowKey(e) {
    if ((e.key === "Enter" || e.key === " ") && e.target.matches?.("tr[data-store]")) {
      e.preventDefault();
      toggleStore(e.target.dataset.store);
    }
  }

  function detailRowFor(store) {
    return wowBody?.querySelector(`tr[data-detail-for="${CSS.escape(store)}"]`) || null;
  }

  function closeDetail() {
    if (!openStore) return;
    detailRowFor(openStore)?.remove();
    wowBody.querySelector(`tr[data-store="${CSS.escape(openStore)}"]`)?.setAttribute("aria-expanded", "false");
    openStore = null;
    lastDetail = null;
    detailSeq++;
  }

  function insertDetailRow(tr, store) {
    tr.setAttribute("aria-expanded", "true");
    tr.insertAdjacentHTML("afterend",
      `<tr class="mkt120-wow-detail-row" data-detail-for="${escapeHtml(store)}"><td colspan="7">` +
      `<div class="mkt120-sd" data-sd><p class="mkt120-empty">Loading store detail…</p></div></td></tr>`);
  }

  function toggleStore(store) {
    if (openStore === store) { closeDetail(); return; }
    closeDetail();
    const tr = wowBody.querySelector(`tr[data-store="${CSS.escape(store)}"]`);
    if (!tr) return;
    openStore = store;
    insertDetailRow(tr, store);
    loadDetail(store);
  }

  // First read is storage-only (instant). Item detail comes from Tableau only
  // when nothing is cached for the store, or on "Refresh detail".
  async function loadDetail(store, { refresh = false } = {}) {
    const seq = ++detailSeq;
    const current = () => seq === detailSeq && openStore === store;
    const request = async (payload) => {
      if (payload.fetch || payload.refresh) detailInFlight = store;
      try { return await host.messaging.send("get_store_detail", { store, ...payload }); }
      finally { if (payload.fetch || payload.refresh) detailInFlight = null; }
    };

    if (refresh && lastDetail?.store === store) renderStoreDetail(lastDetail, { loading: true });
    let res;
    try {
      res = await request(refresh ? { refresh: true } : {});
      if (!current()) return;
      lastDetail = res;
      if (res.detail || refresh) { renderStoreDetail(res); return; }

      renderStoreDetail(res, { loading: true });
      res = await request({ fetch: true });
      if (!current()) return;
      lastDetail = res;
      renderStoreDetail(res);
    } catch (e) {
      if (current()) renderDetailError(store, e);
    }
  }

  function renderDetailError(store, e) {
    const el = detailRowFor(store)?.querySelector("[data-sd]");
    if (el) el.innerHTML = `<p class="mkt120-debug-error">Could not load store detail: ${escapeHtml(e?.message ?? e)}</p>`;
  }

  function renderStoreDetail(res, { loading = false } = {}) {
    const el = detailRowFor(res.store)?.querySelector("[data-sd]");
    if (!el) return;
    const r = res.row;
    const ctx = res.context;
    const d = res.detail;
    const parts = [];

    if (r) {
      const doc = d?.split?.deletedOnClearance;
      const cards = [
        ["Total C/D $", money(r.dollars), ctx ? `#${ctx.rank} of ${ctx.storeCount} · ${ctx.shareOfMarket.toFixed(1)}% of market` : ""],
        ["Total C/D Units", int(r.units), ""],
        ["Clearance $", money(r.clrDol), r.clrQty != null ? `${int(r.clrQty)} units` : ""],
        ["Deleted $", money(r.delDol), r.delQty != null ? `${int(r.delQty)} units · deleted-only` : "deleted-only"],
      ];
      if (doc) cards.push(["Deleted-on-Clearance $", money(doc.dollars), `${int(doc.items)} items · included in Clearance $`]);
      if (ctx?.marketAvg != null) cards.push(["vs Market Avg", deltaMoney(r.dollars - ctx.marketAvg), `avg ${money(ctx.marketAvg)} / store`]);
      parts.push(`<div class="mkt120-sd-cards">${cards.map(([label, val, sub]) => `
        <div class="mkt120-sd-card">
          <div class="mkt120-sd-label">${escapeHtml(label)}</div>
          <div class="mkt120-sd-val">${escapeHtml(val)}</div>
          ${sub ? `<div class="mkt120-sd-sub">${escapeHtml(sub)}</div>` : ""}
        </div>`).join("")}</div>`);
    } else {
      parts.push(`<p class="mkt120-empty">Store totals appear after the next Refresh.</p>`);
    }

    const hist = res.history || [];
    if (hist.length) {
      parts.push(`<div class="mkt120-sd-head"><h3>Weekly history</h3>` +
        `<span class="mkt120-sd-meta">${hist.length === 1 ? "baseline week — history builds weekly" : `${hist.length} weeks on record`}</span></div>` +
        `<div class="mkt120-sd-history">${hist.map((h) =>
          `<span class="mkt120-chip">${escapeHtml(h.week)} · ${escapeHtml(money(h.dollars))} · ${escapeHtml(int(h.units))} units</span>`).join("")}</div>`);
    }

    const head = (meta) => `<div class="mkt120-sd-head"><h3>Item detail</h3>` +
      `<span class="mkt120-sd-meta">${meta}</span>` +
      `<button class="btn btn-secondary btn-sm" data-sd-refresh${loading ? " disabled" : ""}>${loading ? "Loading…" : "Refresh detail"}</button></div>`;

    if (!d) {
      parts.push(head(""));
      if (loading) parts.push(`<p class="mkt120-empty">Reading this store's items from Tableau in a background tab…</p>`);
      else if (res.detailError) parts.push(`<p class="mkt120-debug-error">${escapeHtml(res.detailError)}</p>`);
    } else {
      parts.push(head(`${escapeHtml(int(d.itemCount))} items · pulled ${escapeHtml(new Date(d.capturedAt).toLocaleString("en-US"))}${loading ? " · refreshing…" : ""}`));
      if (res.detailError) parts.push(`<p class="mkt120-debug-error">${escapeHtml(res.detailError)}</p>`);

      const rollup = (title, rows, label) => {
        const max = rows[0]?.dollars || 1;
        return `<div class="mkt120-wow-table-wrap"><table><thead><tr><th>${title}</th><th class="num">$</th><th class="num">Units</th><th class="num">Items</th><th aria-hidden="true"></th></tr></thead><tbody>` +
          rows.slice(0, 10).map((x) => `<tr><td>${escapeHtml(label(x))}</td>` +
            `<td class="num">${escapeHtml(money(x.dollars))}</td><td class="num">${escapeHtml(int(x.units))}</td><td class="num">${escapeHtml(int(x.items))}</td>` +
            `<td class="mkt120-sd-barcell"><div class="mkt120-sd-bar" style="width:${Math.max(2, Math.round((x.dollars / max) * 100))}%"></div></td></tr>`).join("") +
          `</tbody></table></div>`;
      };
      parts.push(`<div class="mkt120-sd-grid">` +
        rollup("Top departments", d.depts, (x) => `Dept ${x.dept || "—"}`) +
        rollup("Top locations", d.locations, (x) => x.loc || "—") +
        `</div>`);

      const TYPE = { clearance: "Clearance", deleted: "Deleted", both: "Deleted on clearance", other: "—" };
      parts.push(`<div class="mkt120-sd-meta">Top ${d.topItems.length} items by C/D $</div>` +
        `<div class="mkt120-wow-table-wrap"><table><thead><tr><th>Item</th><th>Description</th><th>Dept</th><th>Location</th><th>Type</th><th class="num">Units</th><th class="num">$</th></tr></thead><tbody>` +
        d.topItems.map((it) => `<tr><td>${escapeHtml(it.item)}</td><td>${escapeHtml(it.desc)}</td><td>${escapeHtml(it.dept)}</td><td>${escapeHtml(it.loc)}</td>` +
          `<td class="mkt120-sd-type-${escapeHtml(it.type)}">${escapeHtml(TYPE[it.type] || it.type)}</td>` +
          `<td class="num">${escapeHtml(int(it.units))}</td><td class="num">${escapeHtml(money(it.dollars))}</td></tr>`).join("") +
        `</tbody></table></div>`);
    }

    el.innerHTML = parts.join("");
  }

  // ── WoW formatting helpers ─────────────────────────────────
  function money(n) { return "$" + Math.round(Number(n) || 0).toLocaleString("en-US"); }
  function int(n)   { return Math.round(Number(n) || 0).toLocaleString("en-US"); }
  function deltaMoney(n) {
    if (n == null) return "—";
    const s = n > 0 ? "+" : n < 0 ? "−" : "";
    return s + "$" + Math.abs(Math.round(n)).toLocaleString("en-US");
  }
  function deltaInt(n) {
    if (n == null) return "—";
    const s = n > 0 ? "+" : n < 0 ? "−" : "";
    return s + Math.abs(Math.round(n)).toLocaleString("en-US");
  }
  function pctText(p) {
    if (p == null) return "—";
    const s = p > 0 ? "+" : p < 0 ? "−" : "";
    return s + Math.abs(p).toFixed(1) + "%";
  }
  // For shrink metrics, a WEEK-OVER-WEEK INCREASE is bad (red), a decrease is
  // good (green). Zero/na is neutral.
  function deltaClass(n) {
    if (n == null || n === 0) return "mkt120-delta-flat";
    return n > 0 ? "mkt120-delta-up" : "mkt120-delta-down";
  }

  function paintAlerts(state) {
    const listEl = container.querySelector("[data-alert-list]");
    if (!listEl) return;
    const alerts = computeAlerts(state);
    if (!alerts.length) {
      if (!hasRealKpis(state)) {
        listEl.innerHTML = `<p class="mkt120-empty">No real KPIs captured yet. Click Refresh; alerts will populate once at least one metric has been extracted from a live report.</p>`;
      } else {
        listEl.innerHTML = `<p class="mkt120-alert-ok">✓ All captured metrics within thresholds.</p>`;
      }
      return;
    }
    // Order crit first, then warn; within severity, keep insertion order.
    alerts.sort((a, b) => (a.sev === "crit" ? -1 : 1) - (b.sev === "crit" ? -1 : 1));
    listEl.innerHTML = alerts.map(a => `
      <div class="mkt120-alert mkt120-alert-${a.sev} mkt120-alert-family-${a.family}">
        <span class="mkt120-alert-badge">${a.sev === "crit" ? "CRIT" : "WARN"}</span>
        <span class="mkt120-alert-body"><strong>${escapeHtml(a.label)}</strong> exceeded ${a.sev === "crit" ? "critical" : "warning"} threshold</span>
        <span class="mkt120-alert-metric">${escapeHtml(fmtAlertValue(a.value, a.unit))} vs ${escapeHtml(fmtAlertValue(a.threshold, a.unit))}</span>
      </div>
    `).join("");
  }

  function paintDebug(state) {
    const section = container.querySelector("[data-debug-section]");
    const body    = container.querySelector("[data-debug-body]");
    if (!section || !body) return;
    // Show debug on a hard error OR a partial capture (source succeeded but
    // one or more KPIs came back null — e.g. ISA Total Adjusted $). The
    // partial case is where seenDescriptors helps identify the real measure.
    const clearanceErr = state.clearance?.debug && !state.clearance.debug.ok;
    const isaErr       = state.isa?.debug && !state.isa.debug.ok;
    const clearancePartial = hasNullKpi(state.clearance);
    const isaPartial       = hasNullKpi(state.isa);
    const showClearance = clearanceErr || clearancePartial;
    const showIsa       = isaErr || isaPartial;
    if (!showClearance && !showIsa) { section.hidden = true; body.innerHTML = ""; return; }
    section.hidden = false;
    const lines = [];
    if (showClearance && state.clearance?.debug) lines.push(renderDebug("Clearance / Deleted (Tableau)", state.clearance.debug));
    if (showIsa && state.isa?.debug)             lines.push(renderDebug("ISA Activity (Power BI)",       state.isa.debug));
    body.innerHTML = lines.join("") || "<p class=\"mkt120-empty\">A KPI is missing but no capture debug was stored. Re-run Refresh.</p>";
  }

  // A source is "partial" when it has a KPI payload but at least one metric
  // value is null/undefined — capture worked, extraction of that one didn't.
  function hasNullKpi(family) {
    const kpis = family?.kpis;
    if (!kpis || kpis.stub) return false;
    return Object.entries(kpis).some(([k, v]) => k !== "capturedAt" && k !== "stub" && (v === null || v === undefined));
  }

  function renderDebug(label, dbg) {
    const parts = [];
    parts.push(`<div class="mkt120-debug-block">`);
    parts.push(`<strong>${escapeHtml(label)}</strong>`);
    if (dbg.errorClass) parts.push(` — <code>${escapeHtml(dbg.errorClass)}</code>`);
    if (dbg.error) {
      parts.push(`<br><span class="mkt120-debug-error">${escapeHtml(String(dbg.error))}</span>`);
    } else if (dbg.ok) {
      parts.push(`<br><span class="mkt120-debug-note">Capture OK, but a KPI value is missing — expand below and check <code>seenDescriptors</code> for the real measure name.</span>`);
    }
    if (dbg.subErrors) {
      parts.push(`<ul>`);
      for (const [k, v] of Object.entries(dbg.subErrors)) {
        parts.push(`<li><code>${escapeHtml(k)}</code>: ${escapeHtml(String(v))}</li>`);
      }
      parts.push(`</ul>`);
    }
    if (dbg.debug) {
      parts.push(`<details><summary>Capture debug</summary><pre>${escapeHtml(JSON.stringify(dbg.debug, null, 2))}</pre></details>`);
    }
    parts.push(`</div>`);
    return parts.join("");
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function paintFamily(family, data) {
    const kpis = data.kpis || {};
    const familyEl = container.querySelector(`[data-family="${family}"]`);
    if (!familyEl) return;

    // Stub payloads (Pass 1) should render as "—" so users don't mistake
    // the placeholder zeros for real numbers.
    const treatAsEmpty = kpis.stub === true;

    // Self-heal stale "false zero" payloads. The Clearance/Deleted family
    // renders as server-side PNG tiles, so a real capture can never legitimately
    // yield an all-zero dollar set — that only happened when an older, buggy
    // parser wrote {0,0,0}. If we detect that shape, render "—" instead of a
    // misleading $0, regardless of what's cached from before the parser fix.
    const dollarVals = Object.entries(kpis)
      .filter(([k]) => k.endsWith("_dollars"))
      .map(([, v]) => v);
    const allZeroDollars = dollarVals.length > 0 && dollarVals.every((v) => v === 0);

    for (const tile of familyEl.querySelectorAll("[data-metric]")) {
      const key = tile.dataset.metric;
      const raw = (treatAsEmpty || allZeroDollars) ? null : kpis[key];
      const valueEl = tile.querySelector(".mkt120-kpi-value");
      if (raw === undefined || raw === null) {
        valueEl.textContent = "—";
      } else {
        valueEl.textContent = formatByMetric(key, raw);
      }
    }

    const freshnessEl = container.querySelector(`[data-freshness="${family}"]`);
    if (freshnessEl) {
      const { text, state } = renderFreshness(data.freshness);
      freshnessEl.textContent = text;
      freshnessEl.dataset.state = state;
    }
  }

  function formatByMetric(key, value) {
    if (typeof value !== "number") return String(value);
    if (key.endsWith("_qty")) {
      return value.toLocaleString("en-US");
    }
    if (key.endsWith("_dollars")) {
      return (value < 0 ? "−$" : "$") + Math.abs(value).toLocaleString("en-US", { maximumFractionDigits: 0 });
    }
    return value.toLocaleString("en-US");
  }

  function renderFreshness(f) {
    if (!f) return { text: "no capture yet", state: "" };
    if (f.inFlight) return { text: "refreshing…", state: "pending" };
    // Known limitation (e.g. PNG-tile Tableau workbook): neutral, not an error.
    if (f.lastUnavailable) return { text: "unavailable", state: "unavailable" };
    if (f.lastError) return { text: "error — see console", state: "error" };
    if (f.lastSuccess) {
      const age = Date.now() - new Date(f.lastSuccess).getTime();
      return { text: humanAge(age) + " ago", state: f.isStale ? "stale" : "ok" };
    }
    return { text: "no capture yet", state: "" };
  }

  function humanAge(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60)   return `${s}s`;
    const m = Math.round(s / 60);
    if (m < 60)   return `${m}m`;
    const h = Math.round(m / 60);
    if (h < 48)   return `${h}h`;
    return `${Math.round(h / 24)}d`;
  }

  // 7. Cleanup — MUST be called by shell when navigating away.
  return () => {
    unsub();
    wowBody?.removeEventListener("click", onWowClick);
    wowBody?.removeEventListener("keydown", onWowKey);
    isaBody?.removeEventListener("click", onIsaClick);
    isaBody?.removeEventListener("keydown", onIsaKey);
    link.remove();
  };
}
