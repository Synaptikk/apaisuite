// modules/sparkscango/view.js
//
// UI controller for Spark & Scan & Go. Renders the 4 tabs and the
// investigation drawer. All heavy lifting is in the SW; view is stateless
// beyond the currently-selected tab and the last dashboard state snapshot.

import { PAGES, STATUS_UNRESOLVED } from "./lib/pages_registry.js";
import { pickStrategy, runInvestigation, STRATEGY } from "./lib/investigation_bridge.js";

export async function mount(host, container) {
  const link = document.createElement("link");
  link.rel  = "stylesheet";
  link.href = host.url("styles.css");
  link.dataset.module = host.id;
  document.head.appendChild(link);

  try {
    container.innerHTML = await (await fetch(host.url("view.html"))).text();
  } catch (e) {
    container.innerHTML = `<div class="state-error">Failed to load view: ${escapeHtml(String(e?.message ?? e))}</div>`;
    return () => link.remove();
  }

  const $ = (id) => container.querySelector("#" + id);

  const els = {
    status:      $("ssg-status"),
    refreshBtn:  $("ssg-refresh"),
    tabs:        Array.from(container.querySelectorAll(".ssg-tab")),
    panes: {
      overview:          $("ssg-pane-overview"),
      scango_exceptions: $("ssg-pane-scango_exceptions"),
      spark_exceptions:  $("ssg-pane-spark_exceptions"),
      audits:            $("ssg-pane-audits"),
    },
    drawer:      $("ssg-drawer"),
    drawerTitle: $("ssg-drawer-title"),
    drawerBody:  $("ssg-drawer-body"),
    drawerClose: $("ssg-drawer-close"),
  };

  let state = null;   // last get_dashboard_state result
  let currentTab = "overview";

  // ── Tabs ────────────────────────────────────────────────────────
  function selectTab(tabId) {
    currentTab = tabId;
    for (const t of els.tabs) {
      const active = t.dataset.tab === tabId;
      t.classList.toggle("is-active", active);
      t.setAttribute("aria-selected", String(active));
    }
    for (const [id, pane] of Object.entries(els.panes)) {
      const active = id === tabId;
      pane.classList.toggle("is-active", active);
      pane.hidden = !active;
    }
    renderCurrentTab();
  }
  for (const t of els.tabs) {
    t.addEventListener("click", () => selectTab(t.dataset.tab));
  }

  // ── Refresh ─────────────────────────────────────────────────────
  async function refreshAll() {
    host.usage.record("refresh_all");
    els.refreshBtn.disabled = true;
    els.refreshBtn.textContent = "Refreshing…";
    els.status.textContent = "Refreshing all sources…";
    els.status.className = "ssg-status";
    try {
      const resp = await host.messaging.send("refresh_all");
      const r = resp?.data ?? resp;
      const summary = summarizeRefresh(r);
      els.status.textContent = summary.text;
      els.status.className   = `ssg-status ${summary.cls}`;
    } catch (e) {
      els.status.textContent = `Refresh failed: ${e?.message ?? e}`;
      els.status.className = "ssg-status err";
    } finally {
      els.refreshBtn.disabled = false;
      els.refreshBtn.textContent = "Refresh all";
      await reloadState();
    }
  }
  els.refreshBtn.addEventListener("click", refreshAll);

  function summarizeRefresh(r) {
    const items = ["scango_exceptions","spark_exceptions","scango_audits","spark_audits"];
    let ok = 0, discovery = 0, err = 0;
    for (const k of items) {
      const v = r?.[k];
      if (v?.ok) ok++;
      else if (v?.errorClass === STATUS_UNRESOLVED) discovery++;
      else err++;
    }
    if (discovery === items.length) return { text: "All sources await Power BI discovery — see docs/SPARKSCANGO_CHECKPOINT.md", cls: "warn" };
    if (ok === items.length)         return { text: "All sources refreshed.", cls: "ok" };
    return { text: `${ok} ok · ${discovery} awaiting discovery · ${err} error`, cls: err ? "err" : "warn" };
  }

  // ── State fetch ─────────────────────────────────────────────────
  async function reloadState() {
    try {
      const resp = await host.messaging.send("get_dashboard_state");
      state = resp?.data ?? resp;
    } catch (e) {
      state = { error: String(e?.message ?? e) };
    }
    renderCurrentTab();
  }

  // ── SW broadcasts ───────────────────────────────────────────────
  const unsubSourceComplete = host.messaging.on("source_complete", () => {
    reloadState().catch(() => {});
  });

  // ── Rendering ───────────────────────────────────────────────────
  function renderCurrentTab() {
    const pane = els.panes[currentTab];
    if (!pane) return;
    if (!state) {
      pane.innerHTML = loadingCard("Loading dashboard state…");
      return;
    }
    if (state.error) {
      pane.innerHTML = errorCard("Could not load state", state.error);
      return;
    }
    switch (currentTab) {
      case "overview":          return renderOverview(pane);
      case "scango_exceptions": return renderExceptionsTab(pane, "scango_exceptions");
      case "spark_exceptions":  return renderExceptionsTab(pane, "spark_exceptions");
      case "audits":            return renderAuditsTab(pane);
    }
  }

  function renderOverview(pane) {
    const parts = [];
    parts.push(`
      <div class="ssg-state info">
        <div class="ssg-state-title">Module scaffold ready — awaiting Power BI discovery</div>
        <div class="ssg-state-detail">
          Adapter contracts, investigation bridge, filter/state UI, and the SparkFraud shared-service seam are in place.
          Populate <code>modules/sparkscango/lib/pages_registry.js</code> from a live probe (see <code>dev/ssg_powerbi_probe.js</code> or
          <code>docs/SPARKSCANGO_CHECKPOINT.md</code>) to unblock the four data pulls.
        </div>
      </div>
    `);
    parts.push(`<h3 style="margin:16px 0 6px;font-size:13px">Source status</h3>`);
    parts.push(`<div class="ssg-kpi-grid">`);
    for (const [key, p] of Object.entries(PAGES)) {
      const fr = state.freshness?.[key];
      const lastError = fr?.lastError ? ` (${escapeHtml(fr.lastError)})` : "";
      const badge = p.status === STATUS_UNRESOLVED ? "Discovery required" : (fr?.lastSuccess ? "Ready" : "No data");
      parts.push(`
        <div class="ssg-kpi">
          <div class="ssg-kpi-label">${escapeHtml(p.label)}</div>
          <div class="ssg-kpi-value">${escapeHtml(badge)}</div>
          <div class="ssg-kpi-sub">Page <code>${escapeHtml(p.pageId.slice(0, 8))}…</code>${lastError}</div>
        </div>
      `);
    }
    parts.push(`</div>`);
    parts.push(`<h3 style="margin:16px 0 6px;font-size:13px">Recent exceptions</h3>`);
    parts.push(`<div class="ssg-state">No exception rows to display — adapters not yet returning data.</div>`);
    pane.innerHTML = parts.join("");
  }

  function renderExceptionsTab(pane, sourceId) {
    const cache = state.caches?.[sourceId];
    const fr = state.freshness?.[sourceId];
    const page = PAGES[sourceId];

    // Unresolved page — clearest possible state
    if (page.status === STATUS_UNRESOLVED) {
      const openQs = (page.openQuestions || []).map((q) => `<li>${escapeHtml(q)}</li>`).join("");
      pane.innerHTML = `
        <div class="ssg-state warn">
          <div class="ssg-state-title">Discovery required</div>
          <div class="ssg-state-detail">
            This adapter needs the Power BI report probed live to identify the
            <code>Select[].Name</code> mappings, body markers, and page/product routing.
            Run <code>dev/ssg_powerbi_probe.js</code> in an authenticated Edge tab on:
            <br><a href="${escapeHtml(page.url)}" target="_blank" rel="noopener">${escapeHtml(page.url)}</a>
            <br>Paste the sanitized output into <code>modules/sparkscango/lib/pages_registry.js</code>.
          </div>
        </div>
        <div>
          <h4 style="margin:12px 0 4px;font-size:12px;color:#6f6f6f;text-transform:uppercase">Open questions</h4>
          <ul style="font-size:12px;color:#333">${openQs}</ul>
        </div>
      `;
      return;
    }
    if (fr?.lastErrorClass === "NOT_IMPLEMENTED") {
      pane.innerHTML = errorCard("Adapter not yet wired", "Page resolved but pull_" + sourceId + " implementation is pending.");
      return;
    }
    if (!cache?.rows?.length) {
      pane.innerHTML = `<div class="ssg-state">No exception rows in cache. Click Refresh all above.</div>`;
      return;
    }
    pane.innerHTML = renderExceptionTable(cache.rows, sourceId);
    for (const tr of pane.querySelectorAll("tr[data-row-idx]")) {
      tr.addEventListener("click", () => {
        const idx = Number(tr.dataset.rowIdx);
        openDrawer(cache.rows[idx]);
      });
    }
  }

  function renderExceptionTable(rows, sourceId) {
    // Minimal columns until adapter surfaces confirmed field set. When
    // pages_registry.selectNames is populated, the adapter's normalized
    // row will fill in more.
    const head = `
      <tr>
        <th>Time</th><th>Store</th><th>Type</th>
        <th>Order/Trip</th><th>Driver</th><th>Shopper/Txn</th>
        <th>Source status</th>
      </tr>`;
    const body = rows.map((r, i) => `
      <tr data-row-idx="${i}">
        <td>${escapeHtml(fmtTime(r.eventTimestamp, r.eventTimezone))}</td>
        <td>${escapeHtml(r.storeNbr ?? "—")}</td>
        <td>${escapeHtml(r.exceptionType || "—")}</td>
        <td>${escapeHtml(r.orderId || r.tripId || "—")}</td>
        <td>${escapeHtml(r.driverName || r.driverId || "—")}</td>
        <td>${escapeHtml(r.shopperId || r.transactionId || "—")}</td>
        <td>${escapeHtml(r.sourceStatus || "—")}</td>
      </tr>
    `).join("");
    return `
      <div class="muted tiny" style="margin-bottom:6px">${rows.length} row${rows.length === 1 ? "" : "s"} · click to investigate</div>
      <table class="ssg-table"><thead>${head}</thead><tbody>${body}</tbody></table>
    `;
  }

  function renderAuditsTab(pane) {
    const spark  = state.caches?.spark_audits;
    const scango = state.caches?.scango_audits;
    const anyResolved = PAGES.spark_audits.status !== STATUS_UNRESOLVED
                     || PAGES.scango_audits.status !== STATUS_UNRESOLVED;
    if (!anyResolved) {
      pane.innerHTML = `<div class="ssg-state warn">
        <div class="ssg-state-title">Both audit adapters await discovery</div>
        <div class="ssg-state-detail">See exceptions tabs for probe steps.</div>
      </div>`;
      return;
    }
    const cards = [];
    for (const [key, cache] of [["spark_audits", spark], ["scango_audits", scango]]) {
      const p = PAGES[key];
      if (p.status === STATUS_UNRESOLVED) {
        cards.push(`<div class="ssg-state warn"><div class="ssg-state-title">${escapeHtml(p.label)}</div><div class="ssg-state-detail">Discovery required.</div></div>`);
        continue;
      }
      if (!cache?.metrics?.length) {
        cards.push(`<div class="ssg-state"><div class="ssg-state-title">${escapeHtml(p.label)}</div><div class="ssg-state-detail">No metrics in cache.</div></div>`);
        continue;
      }
      cards.push(`<h3>${escapeHtml(p.label)}</h3><div class="ssg-kpi-grid">${
        cache.metrics.map((m) => `
          <div class="ssg-kpi">
            <div class="ssg-kpi-label">${escapeHtml(m.nameDisplay || m.name)}</div>
            <div class="ssg-kpi-value">${escapeHtml(formatMetric(m))}</div>
          </div>
        `).join("")
      }</div>`);
    }
    pane.innerHTML = cards.join("");
  }

  function formatMetric(m) {
    if (m.value == null) return "—";
    switch (m.unit) {
      case "percent":  return `${Number(m.value).toFixed(1)}%`;
      case "currency": return `$${Number(m.value).toFixed(2)}`;
      case "ratio":    return Number(m.value).toFixed(2);
      case "count":
      case "other":
      default:         return String(m.value);
    }
  }

  // ── Drawer ──────────────────────────────────────────────────────
  async function openDrawer(row) {
    els.drawer.hidden = false;
    els.drawerTitle.textContent = `${row.source === "spark" ? "Spark" : "Scan & Go"} exception${row.exceptionId ? ` #${row.exceptionId}` : ""}`;
    const decision = pickStrategy(row);
    els.drawerBody.innerHTML = renderDrawerLoading(row, decision);

    // For Scan & Go rows with no Spark identifiers, we show source-only.
    if (decision.strategy === STRATEGY.NONE) {
      els.drawerBody.innerHTML = renderDrawerBody(row, {
        ok: true, strategy: decision.strategy, ids: decision.ids,
        candidates: [], reason: decision.reason,
        sourceFacts: sourceFactsOf(row),
        matchedFacts: null, inferences: null,
      });
      return;
    }
    try {
      const result = await runInvestigation(host, row);
      els.drawerBody.innerHTML = renderDrawerBody(row, result);
    } catch (e) {
      els.drawerBody.innerHTML = errorCard("Investigation failed", String(e?.message ?? e));
    }
  }
  els.drawerClose.addEventListener("click", () => { els.drawer.hidden = true; });

  function renderDrawerLoading(row, decision) {
    return `
      <div class="ssg-drawer-section">
        <h4>Chosen strategy</h4>
        <div>${escapeHtml(decision.strategy)}${decision.strategy === STRATEGY.NONE ? " — " + escapeHtml(decision.reason || "") : ""}</div>
      </div>
      <div class="ssg-drawer-section">
        <h4>Source facts</h4>
        ${renderFactsList(sourceFactsOf(row))}
      </div>
      ${decision.strategy !== STRATEGY.NONE ? `<div class="ssg-drawer-section"><div class="ssg-state info">Running lookup…</div></div>` : ""}
    `;
  }

  function renderDrawerBody(row, result) {
    const parts = [];
    parts.push(`<div class="ssg-drawer-section"><h4>Chosen strategy</h4><div>${escapeHtml(result.strategy)}${result.reason ? ` — ${escapeHtml(result.reason)}` : ""}</div></div>`);
    parts.push(`<div class="ssg-drawer-section"><h4>Source facts</h4>${renderFactsList(result.sourceFacts || sourceFactsOf(row))}</div>`);
    if (result.matchedFacts) {
      parts.push(`<div class="ssg-drawer-section"><h4>Matched facts</h4>${renderFactsList(result.matchedFacts)}</div>`);
    }
    if (result.inferences) {
      parts.push(`<div class="ssg-drawer-section"><h4>Inferences</h4>${renderFactsList(result.inferences)}</div>`);
    }
    if (result.candidates?.length) {
      parts.push(`<div class="ssg-drawer-section"><h4>Candidates</h4>${result.candidates.map(renderCandidate).join("")}</div>`);
    } else if (result.ok === false) {
      parts.push(`<div class="ssg-drawer-section"><div class="ssg-state warn">${escapeHtml(result.reason || "Lookup returned no candidates.")}</div></div>`);
    }
    return parts.join("");
  }

  function renderCandidate(c) {
    const label = c?.confidence || "—";
    return `<div class="ssg-state">
      <div><strong>${escapeHtml(label)}</strong>${c?.trip?.driver?.fullName ? ` · ${escapeHtml(c.trip.driver.fullName)}` : ""}</div>
      <div class="tiny">${escapeHtml((c?.rationale || []).join(" · "))}</div>
    </div>`;
  }

  function renderFactsList(facts) {
    const entries = Object.entries(facts || {});
    if (!entries.length) return `<div class="muted tiny">No facts.</div>`;
    return `<dl class="ssg-facts">${entries.map(([k, v]) =>
      `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd>`
    ).join("")}</dl>`;
  }

  function sourceFactsOf(row) {
    const f = {};
    const push = (k, v) => { if (v != null && v !== "") f[k] = v; };
    push("Exception ID",   row.exceptionId);
    push("Exception type", row.exceptionType);
    push("Store",          row.storeNbr);
    push("Order",          row.orderId);
    push("Trip",           row.tripId);
    push("Driver",         row.driverName || row.driverId);
    push("Transaction",    row.transactionId);
    push("Receipt",        row.receiptId);
    push("Register",       row.registerNbr);
    push("Shopper",        row.shopperId);
    push("Source status",  row.sourceStatus);
    if (row.eventTimestamp) f["Event time"] = new Date(row.eventTimestamp).toISOString();
    return f;
  }

  // ── State cards ─────────────────────────────────────────────────
  function loadingCard(msg) {
    return `<div class="ssg-state info">${escapeHtml(msg)}</div>`;
  }
  function errorCard(title, detail) {
    return `<div class="ssg-state err">
      <div class="ssg-state-title">${escapeHtml(title)}</div>
      <div class="ssg-state-detail">${escapeHtml(detail)}</div>
    </div>`;
  }
  function fmtTime(ms, tz) {
    if (!ms) return "—";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: tz || undefined, dateStyle: "short", timeStyle: "short",
      }).format(new Date(ms));
    } catch { return new Date(ms).toISOString(); }
  }
  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]
    ));
  }

  // ── Boot ────────────────────────────────────────────────────────
  await reloadState();
  selectTab("overview");

  return () => {
    els.refreshBtn.removeEventListener("click", refreshAll);
    els.drawerClose.removeEventListener("click", () => {});
    unsubSourceComplete?.();
    link.remove();
  };
}

export default { mount };
