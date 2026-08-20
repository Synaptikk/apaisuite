// modules/market120/view.js
//
// Full-page dashboard mount. Loads view.html, wires the Refresh buttons,
// subscribes to source_complete broadcasts, and re-renders on each update.

import { computeAlerts, fmtAlertValue, hasRealKpis } from "./lib/alerts.js";
import { hbarSvg, donutSvg, CHART_COLORS } from "./lib/charts.js";

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
      <tr${r.isNew ? ' class="mkt120-wow-new"' : ""}>
        <td class="mkt120-wow-store">#${escapeHtml(r.store)}${r.isNew ? ' <span class="mkt120-wow-badge">new</span>' : ""}</td>
        <td class="num">${money(r.dollars)}</td>
        <td class="num ${deltaClass(r.dDollars)}">${deltaMoney(r.dDollars)}</td>
        <td class="num ${deltaClass(r.dDollars)}">${pctText(r.pctDollars)}</td>
        <td class="num">${int(r.units)}</td>
        <td class="num ${deltaClass(r.dUnits)}">${deltaInt(r.dUnits)}</td>
        <td class="num ${deltaClass(r.dUnits)}">${pctText(r.pctUnits)}</td>
      </tr>`).join("");
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
      return "$" + value.toLocaleString("en-US", { maximumFractionDigits: 0 });
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
    link.remove();
  };
}
