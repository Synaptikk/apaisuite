// modules/livedashboard/view.js
//
// Live Dashboard UI controller. Mounted by the shell on the home page
// ABOVE the module-card grid (kind: "home-header"). Loads view.html +
// styles.css, requests dashboard state from the SW, paints 5 widgets,
// wires drill-downs for Callouts + CVP.

import { wmWeek } from "../../shared/wmweek.js";
import { withWeekday } from "../../shared/dates.js";
import { explainVideoGap } from "./lib/sources/auror.js";
import { aurorExceptionsEmail } from "./lib/auror_email.js";

export async function mount(host, container) {
  // 1. Inject CSS
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = host.url("styles.css");
  link.dataset.module = host.id;
  document.head.appendChild(link);

  // 2. Load markup
  try {
    const resp = await fetch(host.url("view.html"));
    container.innerHTML = await resp.text();
  } catch (e) {
    container.innerHTML = `<div class="state-error">Failed to load Live Dashboard: ${String(e?.message ?? e)}</div>`;
    return () => { link.remove(); };
  }

  const $ = (id) => container.querySelector("#" + id);
  const statusText = $("ld-status-text");
  const refreshBtn = $("ld-refresh-btn");
  const storeInput = $("ld-store-input");
  const drillEl    = $("ld-drill");
  const drillTitle = $("ld-drill-title");
  const drillBody  = $("ld-drill-body");
  const drillClose = $("ld-drill-close");

  let lastState = null;   // most recent full state; drill-downs read from this
  let openDrill = null;   // "absences" | "cvp" | "compliance" | "auror" | null

  // ── State load + paint ──────────────────────────────────────────
  async function reload() {
    try {
      const resp = await host.messaging.send("get_dashboard_state");
      const state = resp?.data ?? resp;
      lastState = state;
      paint(state);
      // If a drill-down is open, re-render it with fresh data
      if (openDrill) renderDrill(openDrill);
      statusText.textContent = state.storeNbr
        ? `Loaded · store ${state.storeNbr}`
        : "Enter your store number above to load data";
    } catch (e) {
      console.warn("[livedashboard] state load failed", e); statusText.textContent = "Couldn't load the dashboard.";
    }
  }

  function paint(state) {
    if (!state) return;
    storeInput.value = state.storeNbr || "";
    paintAbsences(state.sources.absences, state.freshness.absences);
    paintCvp(state.sources.cvp, state.freshness.cvp);
    paintCompliance(state.sources.compliance, state.freshness.compliance);
    paintAuror(state.sources.auror, state.freshness.auror);
    paintAccident(state.sources.accident, state.freshness.accident);
  }

  function paintAbsences(src, fresh) {
    const w = $("ld-w-absences");
    const pill = $("ld-w-absences-pill");
    const prim = $("ld-w-absences-primary");
    const sec  = $("ld-w-absences-secondary");
    const foot = $("ld-w-absences-foot");

    const c = src?.cache;
    if (fresh?.inFlight && !c) {
      setLoadingWidget(w, pill, prim, sec, foot, "loading…");
      return;
    }
    if (!c) {
      if (fresh?.lastError) {
        w.dataset.sev = "error";
        pill.textContent = "error";
        prim.textContent = "—";
        sec.textContent  = fresh.lastError;
        foot.textContent = freshFoot(fresh);
      } else {
        w.dataset.sev = "unknown";
        pill.textContent = "never";
        prim.textContent = "—";
        sec.textContent  = "click Refresh";
        foot.textContent = "no data yet";
      }
      return;
    }
    // Cache present — paint data. Demote any lastError to a footer hint.
    const counts = c.counts || {};
    const baseSev = counts.maxDeptCount >= 3 ? "fail"
                  : counts.callouts >= 5     ? "warn"
                  : counts.callouts > 0      ? "ok"
                  : "ok";
    w.dataset.sev = fresh?.isStale ? "stale" : baseSev;
    pill.textContent = fresh?.isStale ? "stale" : sevLabel(baseSev);
    prim.textContent = String(counts.callouts ?? 0);
    sec.textContent  = `${counts.tardies ?? 0} tardy${counts.maxDept ? ` · ${counts.maxDeptCount} in ${counts.maxDept}` : ""}`;
    foot.textContent = freshFootWithError(fresh);
  }

  function setLoadingWidget(w, pill, prim, sec, foot, msg) {
    w.dataset.sev = "pending";
    if (pill) pill.textContent = "loading";
    if (prim) prim.textContent = "…";
    if (sec)  sec.textContent  = msg;
    if (foot) foot.textContent = "first load";
  }

  // Footer line that combines "updated Xago" with a "last attempt failed"
  // hint when the most recent pull errored but a prior successful cache
  // is being shown. Keeps the data visible while signaling the issue.
  function freshFootWithError(fresh) {
    const base = freshFoot(fresh);
    if (!fresh?.lastError) return base;
    const short = String(fresh.lastError).split("\n")[0].slice(0, 70);
    return `${base} · ⚠ ${short}`;
  }

  function paintAccident(src, fresh) {
    const w = $("ld-w-accident");
    const pill = $("ld-w-accident-pill");
    const prim = $("ld-w-accident-primary");
    const sec  = $("ld-w-accident-secondary");
    const foot = $("ld-w-accident-foot");
    if (!w) return;

    const c = src?.cache;
    if (fresh?.inFlight && !c) {
      setLoadingWidget(w, pill, prim, sec, foot, "loading…");
      return;
    }
    if (!c?.counts) {
      if (fresh?.lastError) {
        w.dataset.sev = "error";
        pill.textContent = "error";
        prim.textContent = "—";
        sec.textContent  = fresh.lastError;
        foot.textContent = freshFoot(fresh);
      } else {
        w.dataset.sev = "unknown";
        pill.textContent = "never";
        prim.textContent = "—";
        sec.textContent  = "click Refresh";
        foot.textContent = "no data yet";
      }
      return;
    }
    const counts = c.counts;
    const baseSev = counts.highPriority > 0 ? "fail"
                  : counts.withMissing > 0  ? "warn"
                  : counts.total > 0        ? "ok"
                  : "ok";
    w.dataset.sev = fresh?.isStale ? "stale" : baseSev;
    pill.textContent = fresh?.isStale ? "stale" : sevLabel(baseSev);
    prim.textContent = String(counts.withMissing ?? 0);
    sec.textContent  = `${counts.highPriority ?? 0} high · ${counts.agingOpen ?? 0} aging ≥14d · ${counts.total ?? 0} total`;
    foot.textContent = freshFootWithError(fresh);
  }

  function paintAuror(src, fresh) {
    const w = $("ld-w-auror");
    const pill = $("ld-w-auror-pill");
    const prim = $("ld-w-auror-primary");
    const sec  = $("ld-w-auror-secondary");
    const foot = $("ld-w-auror-foot");
    if (!w) return;

    const c = src?.cache;
    if (fresh?.inFlight && !c) {
      setLoadingWidget(w, pill, prim, sec, foot, "loading…");
      return;
    }
    if (!c?.counts) {
      if (fresh?.lastError) {
        w.dataset.sev = "error";
        pill.textContent = "error";
        prim.textContent = "—";
        sec.textContent  = fresh.lastError;
        foot.textContent = freshFoot(fresh);
      } else {
        w.dataset.sev = "unknown";
        pill.textContent = "never";
        prim.textContent = "—";
        sec.textContent  = "click Refresh (sign in to Auror first)";
        foot.textContent = "no data yet";
      }
      return;
    }
    const counts = c.counts;
    const baseSev = (counts.flagged ?? 0) === 0 ? "ok"
                  : counts.flagged >= 3         ? "fail"
                  : "warn";
    w.dataset.sev = fresh?.isStale ? "stale" : baseSev;
    pill.textContent = fresh?.isStale ? "stale" : sevLabel(baseSev);
    prim.textContent = String(counts.flagged ?? 0);
    sec.textContent  = `${counts.missingVideo ?? 0} short on video · ${counts.missingStatement ?? 0} no stmt · ${counts.missingPhoto ?? 0} no photo`;
    foot.textContent = freshFootWithError(fresh);
  }

  function paintCompliance(src, fresh) {
    const w = $("ld-w-compliance");
    const pill = $("ld-w-compliance-pill");
    const prim = $("ld-w-compliance-primary");
    const sec  = $("ld-w-compliance-secondary");
    const foot = $("ld-w-compliance-foot");
    if (!w) return;

    const c = src?.cache;
    if (fresh?.inFlight && !c) {
      setLoadingWidget(w, pill, prim, sec, foot, "loading…");
      return;
    }
    if (!c) {
      if (fresh?.lastError) {
        w.dataset.sev = "error";
        pill.textContent = "error";
        prim.textContent = "—";
        sec.textContent  = fresh.lastError;
        foot.textContent = freshFoot(fresh);
      } else {
        w.dataset.sev = "unknown";
        pill.textContent = "never";
        prim.textContent = "—";
        sec.textContent  = "click Refresh";
        foot.textContent = "no data yet";
      }
      return;
    }
    const counts = c.counts || {};
    // Headline = overdue + due within 5 days. Plain "overdue" alone hid
    // tasks coming due tomorrow — user explicitly wants those surfaced.
    const needsAttention = (counts.overdue ?? 0) + (counts.dueSoon ?? 0);
    const baseSev = counts.overdue > 0 ? (counts.worstOverdueDays >= 7 ? "fail" : "warn")
                  : counts.dueSoon >= 1 ? "warn"
                  : "ok";
    w.dataset.sev = fresh?.isStale ? "stale" : baseSev;
    pill.textContent = fresh?.isStale ? "stale" : sevLabel(baseSev);
    prim.textContent = String(needsAttention);
    sec.textContent  = `${counts.overdue ?? 0} overdue · ${counts.dueSoon ?? 0} due ≤5d · ${counts.total ?? 0} total`;
    foot.textContent = freshFootWithError(fresh);
  }

  function paintCvp(src, fresh) {
    const w = $("ld-w-cvp");
    const pill = $("ld-w-cvp-pill");
    const prim = $("ld-w-cvp-primary");
    const sec  = $("ld-w-cvp-secondary");
    const foot = $("ld-w-cvp-foot");

    const c = src?.cache;
    if (fresh?.inFlight && !c) {
      setLoadingWidget(w, pill, prim, sec, foot, "loading…");
      return;
    }
    if (!c?.currentWeek) {
      if (fresh?.lastError) {
        w.dataset.sev = "error";
        pill.textContent = "error";
        prim.textContent = "—";
        sec.textContent  = fresh.lastError;
        foot.textContent = freshFoot(fresh);
      } else {
        w.dataset.sev = "unknown";
        pill.textContent = "never";
        prim.textContent = "—";
        sec.textContent  = "click Refresh";
        foot.textContent = "no data yet";
      }
      return;
    }
    const cw = c.currentWeek;
    const pct = cw.sellThruPctTy;
    const baseSev = sevForCvp(pct);
    w.dataset.sev = fresh?.isStale ? "stale" : baseSev;
    pill.textContent = fresh?.isStale ? "stale" : sevLabel(baseSev);
    prim.textContent = pct == null ? "—" : `${pct.toFixed(1)}%`;
    const ly  = cw.sellThruPctLy;
    const dir = (pct != null && ly != null)
      ? (pct - ly >= 0 ? `▲ ${(pct - ly).toFixed(1)} vs LY` : `▼ ${(ly - pct).toFixed(1)} vs LY`)
      : "";
    sec.textContent = `${cw.wmWeekTextLong || cw.wmWeekText || ""} · ${dir}`;
    foot.textContent = freshFootWithError(fresh);
  }

  function sevForCvp(pct) {
    if (pct == null || Number.isNaN(pct)) return "unknown";
    if (pct >= 55) return "ok";
    if (pct >= 45) return "warn";
    return "fail";
  }

  function sevLabel(sev) {
    return ({ ok: "ok", warn: "watch", fail: "alert", unknown: "—", pending: "pending", stale: "stale" })[sev] || "—";
  }

  function freshFoot(fresh) {
    if (!fresh) return "never refreshed";
    if (fresh.lastSuccess) return `updated ${fmtAgo(new Date(fresh.lastSuccess).getTime())}`;
    if (fresh.lastAttempt) return `attempted ${fmtAgo(new Date(fresh.lastAttempt).getTime())}`;
    return "never refreshed";
  }
  function fmtAgo(ms) {
    if (!ms) return "—";
    const diff = Date.now() - ms;
    if (diff < 60_000)    return `${Math.max(1, Math.round(diff/1000))}s ago`;
    if (diff < 3_600_000) return `${Math.round(diff/60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.round(diff/3_600_000)}h ago`;
    return `${Math.round(diff/86_400_000)}d ago`;
  }
  function shortErr(e) {
    return String(e?.message ?? e).slice(0, 160);
  }
  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  // ── Drill-downs ─────────────────────────────────────────────────
  function openDrillFor(kind) {
    openDrill = kind;
    drillEl.hidden = false;
    // Update aria-expanded on widgets
    for (const w of container.querySelectorAll(".ld-widget[data-drill]")) {
      const wk = w.dataset.drill;
      if (wk) w.setAttribute("aria-expanded", wk === kind ? "true" : "false");
    }
    renderDrill(kind);
  }
  function closeDrill() {
    openDrill = null;
    drillEl.hidden = true;
    for (const w of container.querySelectorAll(".ld-widget[data-drill]")) {
      w.setAttribute("aria-expanded", "false");
    }
  }
  function renderDrill(kind) {
    if (kind === "absences")     return renderAbsencesDrill();
    if (kind === "cvp")          return renderCvpDrill();
    if (kind === "compliance")   return renderComplianceDrill();
    if (kind === "auror")        return renderAurorDrill();
    if (kind === "accident")     return renderAccidentDrill();
  }

  function renderAbsencesDrill() {
    drillTitle.textContent = "Callouts Today — who called out";
    const c = lastState?.sources?.absences?.cache;
    if (!c) {
      drillBody.innerHTML = `<div class="ld-empty">No data yet. Click Refresh.</div>`;
      return;
    }
    const today = c.todayIso;
    const todayRows = (c.records || []).filter((r) => r.absenceDate === today);
    if (!todayRows.length) {
      const captured = c.capturedAt || "—";
      drillBody.innerHTML = `
        <div class="ld-empty">
          <strong>No callouts on file for today (${escapeHtml(today ? withWeekday(today) : "—")}).</strong>
          <div style="margin-top:4px">Updated ${escapeHtml(withWeekday(String(captured)))}.</div>
        </div>`;
      return;
    }
    // Sort: callouts first (alphabetical), then tardies
    todayRows.sort((a, b) => {
      const at = /tardy/i.test(a.absenceType) ? 1 : 0;
      const bt = /tardy/i.test(b.absenceType) ? 1 : 0;
      if (at !== bt) return at - bt;
      return (a.associate || "").localeCompare(b.associate || "");
    });
    const rows = todayRows.map((r) => `
      <tr>
        <td>${escapeHtml(r.associate)}</td>
        <td>${escapeHtml(r.dept)}</td>
        <td>${escapeHtml(r.job)}</td>
        <td>${escapeHtml(r.absenceType)}</td>
        <td>${escapeHtml(r.absenceReason)}</td>
        <td>${escapeHtml(r.callDateTime ? withWeekday(r.callDateTime) : "")}</td>
        <td>${escapeHtml(r.confirmation || "")}</td>
      </tr>
    `).join("");
    drillBody.innerHTML = `
      <table class="ld-table">
        <thead>
          <tr>
            <th>Associate</th><th>Dept</th><th>Job</th><th>Type</th>
            <th>Reason</th><th>Called</th><th>Conf #</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="ld-empty" style="margin-top:6px">
        ${todayRows.length} record${todayRows.length === 1 ? "" : "s"} for ${escapeHtml(withWeekday(today))} ·
        captured ${escapeHtml(withWeekday(c.capturedAt || "?"))}
      </div>
    `;
  }

  function renderAccidentDrill() {
    drillTitle.textContent = "Accident Details";
    const c = lastState?.sources?.accident?.cache;
    const accidentHtml = c?.records?.length
      ? buildAccidentSection(c)
      : `<div class="ld-empty">No data yet. Click Refresh.</div>`;
    const recognitionHtml = buildRecognitionSection(
      lastState?.sources?.recognition,
      lastState?.freshness?.recognition,
    );
    drillBody.innerHTML = accidentHtml + recognitionHtml;
  }

  function buildAccidentSection(c) {
    const records = c.records.slice().sort((a, b) => {
      // Highest priority first, then most days open
      if ((b.priorityScore ?? 0) !== (a.priorityScore ?? 0)) return (b.priorityScore ?? 0) - (a.priorityScore ?? 0);
      return (b.daysOpen ?? 0) - (a.daysOpen ?? 0);
    });

    const sectionTitle = {
      BodilyInjury:               "Bodily Injury",
      GarageKeeperPropertyDamage: "Garage Keeper / Property Damage",
    };
    const grouped = { BodilyInjury: [], GarageKeeperPropertyDamage: [] };
    for (const r of records) grouped[r.reportType]?.push(r);

    const sections = ["BodilyInjury", "GarageKeeperPropertyDamage"].map((type) => {
      const rows = grouped[type];
      if (!rows.length) return "";
      const trs = rows.map((r) => {
        const sev = r.priorityScore >= 7 ? "fail" : r.priorityScore >= 4 ? "warn" : "ok";
        const missingList = (r.missingItems || []).map((m) => prettyEvidence(m)).join(", ") || "—";
        return `
          <tr>
            <td>${escapeHtml(r.referenceNbr)}</td>
            <td>${escapeHtml(r.claimant)}</td>
            <td>${r.daysOpen != null ? r.daysOpen : "?"}d</td>
            <td><span class="ld-cvp-pct" data-sev="${sev}" style="font-size:12px">${r.priorityScore}</span></td>
            <td>${escapeHtml(missingList)}</td>
            <td>${escapeHtml(r.evidenceStatus)}</td>
            <td>${escapeHtml(r.enhancedExport)}</td>
          </tr>`;
      }).join("");
      return `
        <h4 style="margin:12px 0 6px;font-size:12px;text-transform:uppercase;color:#4a4a4a">${escapeHtml(sectionTitle[type])} (${rows.length})</h4>
        <table class="ld-table">
          <thead>
            <tr><th>Ref&nbsp;#</th><th>Claimant</th><th>Open</th><th>Score</th><th>Missing</th><th>Status</th><th>Enh&nbsp;Exp</th></tr>
          </thead>
          <tbody>${trs}</tbody>
        </table>`;
    }).join("");

    return `
      <div class="ld-empty">
        ${c.counts.withMissing} with missing evidence ·
        ${c.counts.highPriority} high priority (score ≥7) ·
        ${c.counts.agingOpen} aging ≥14 days
        — source updated ${escapeHtml(withWeekday(c.sourceDataUpdatedOn || "?"))},
        captured ${escapeHtml(withWeekday(c.capturedAt || "?"))}
      </div>
      ${sections}
    `;
  }

  function buildRecognitionSection(src, fresh) {
    const header = `<h4 style="margin:14px 0 6px;font-size:12px;text-transform:uppercase;color:#4a4a4a">Safety Observations — last 7 days</h4>`;
    const c = src?.cache;
    if (!c?.rolling7d?.length) {
      if (fresh?.inFlight) {
        return `${header}<div class="ld-empty">Loading…</div>`;
      }
      if (fresh?.lastError) {
        return `${header}<div class="ld-empty">⚠ Safety observations pull failed: ${escapeHtml(String(fresh.lastError).slice(0, 160))}</div>`;
      }
      return `${header}<div class="ld-empty">No data yet. Click Refresh.</div>`;
    }
    // Oldest → newest reads naturally left-to-right.
    const days = c.rolling7d.slice().reverse();
    // engagement7d is absent on caches written before the two-series pull;
    // fall back to a zero row rather than mis-labelling recognition as both.
    const engDays = (c.engagement7d || []).slice().reverse();
    const engByDate = new Map(engDays.map((r) => [r.dateIso, r.count || 0]));
    const hasEngagement = !!c.engagement7d;

    const sum = (arr) => arr.reduce((a, r) => a + (r.count || 0), 0);
    const recTotal = sum(days);
    const engTotal = sum(engDays);

    // The source lands yesterday's data, so the current day's slot is always
    // zero — which reads as "nobody logged anything" rather than "not in yet".
    // Mark it instead of printing a count nobody should act on.
    const todayIso = isoTodayLocal();
    const isToday  = (iso) => iso === todayIso;
    const NOT_LIVE = `<td style="text-align:center;color:#8a8a8a" title="Current day — not live">—</td>`;

    const dateCells = days
      .map((r) => `<th>${escapeHtml(fmtDateShort(r.dateIso))}${isToday(r.dateIso) ? "&nbsp;*" : ""}</th>`)
      .join("");
    const seriesRow = (label, cells, total, strong) => `
      <tr>
        <td style="white-space:nowrap">${label}</td>
        ${cells}
        <td style="text-align:right">${strong ? `<strong>${total}</strong>` : total}</td>
      </tr>`;
    const recCells = days
      .map((r) => (isToday(r.dateIso) ? NOT_LIVE : `<td style="text-align:center">${r.count}</td>`))
      .join("");
    const engCells = days
      .map((r) => (isToday(r.dateIso) ? NOT_LIVE : `<td style="text-align:center">${engByDate.get(r.dateIso) ?? 0}</td>`))
      .join("");
    const allCells = days
      .map((r) => (isToday(r.dateIso)
        ? NOT_LIVE
        : `<td style="text-align:center"><strong>${(r.count || 0) + (engByDate.get(r.dateIso) ?? 0)}</strong></td>`))
      .join("");

    // Self-describing first line, so a pasted block still says which store and
    // when it was captured once it's out of the dashboard's context.
    const weekText = wmWeekRangeLabel(days);
    const copyLabel = [
      lastState?.storeNbr ? `Store ${lastState.storeNbr}` : null,
      "Safety Observations — last 7 days",
      weekText || null,
      c.capturedAt ? `(captured ${withWeekday(c.capturedAt.slice(0, 10))})` : null,
    ].filter(Boolean).join(" · ");

    const dataHeader = `<h4 style="margin:14px 0 6px;font-size:12px;text-transform:uppercase;color:#4a4a4a">Safety Observations — last 7 days${weekText ? ` · ${escapeHtml(weekText)}` : ""}</h4>`;

    return `
      <div data-ld-copy-scope>
      ${headerWithCopy(dataHeader, copyLabel)}
      <table class="ld-table">
        <thead>
          <tr><th></th>${dateCells}<th style="text-align:right">7d&nbsp;total</th></tr>
        </thead>
        <tbody>
          ${seriesRow("Recognition", recCells, recTotal, !hasEngagement)}
          ${hasEngagement ? seriesRow("Engagement", engCells, engTotal, false) : ""}
          ${hasEngagement ? seriesRow("<strong>Total</strong>", allCells, recTotal + engTotal, true) : ""}
        </tbody>
      </table>
      <div class="ld-empty" style="margin-top:6px">
        * ${escapeHtml(fmtDateShort(todayIso))} is the current day — not live; the 7d totals cover the six completed days.
      </div>
      <div class="ld-empty" style="margin-top:2px">
        Updated ${escapeHtml(withWeekday(c.capturedAt || "?"))}${c.capturedAt ? ` (${escapeHtml(fmtAgo(new Date(c.capturedAt).getTime()))})` : ""}
        ${fresh?.isStale ? " · <strong>stale</strong>" : ""}
        ${fresh?.lastError ? ` · ⚠ last pull failed: ${escapeHtml(String(fresh.lastError).slice(0, 120))}` : ""}
      </div>
      </div>
    `;
  }

  // Renders a section heading with a Copy button on the right. The button's
  // data-ld-copy value becomes the first line of the copied text.
  function headerWithCopy(headerHtml, copyLabel) {
    const buttons = `<span style="float:right;font-weight:400">
      <button type="button" class="btn btn-sm" data-ld-copy data-ld-copy-builder="safety-obs-chat"
        title="Copy as short lines — for a Workvivo chat or a text message">Copy for chat</button>
      <button type="button" class="btn btn-sm" data-ld-copy="${escapeHtml(copyLabel)}"
        title="Copy as tab-separated cells — for Excel or Sheets">Copy as table</button>
    </span>`;
    // Inject before the heading's closing tag so the buttons sit on its line.
    return headerHtml.replace(/<\/h4>\s*$/, `${buttons}</h4>`);
  }

  function fmtDateShort(iso) {
    if (!iso) return "—";
    const [y, m, d] = iso.split("-");
    return withWeekday(`${Number(m)}/${Number(d)}/${y}`, iso);
  }

  function isoTodayLocal() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  // A rolling 7-day window is not a fiscal week, so it can straddle two of
  // them. Take the first and last day in chronological order rather than
  // sorting the numbers — across the fiscal-year boundary the weeks run
  // 52 → 1, and a numeric sort would render that backwards as "WK 1–52".
  function wmWeekRangeLabel(daysOldestFirst) {
    if (!daysOldestFirst?.length) return "";
    const first = wmWeek(daysOldestFirst[0].dateIso);
    const last  = wmWeek(daysOldestFirst[daysOldestFirst.length - 1].dateIso);
    if (!first || !last) return "";
    return first.week === last.week ? `WK ${first.week}` : `WK ${first.week}–${last.week}`;
  }

  function prettyEvidence(field) {
    const map = {
      customerStatement:       "Customer Statement",
      witnessStatement:        "Witness Statement",
      video:                   "Video",
      photos:                  "Photos",
      evidenceCollectionSheet: "Evidence Collection Sheet",
    };
    return map[field] || field;
  }

  function renderAurorDrill() {
    drillTitle.textContent = "Auror Exceptions — events missing evidence";
    const c = lastState?.sources?.auror?.cache;
    if (!c?.records) {
      drillBody.innerHTML = `
        <div class="ld-empty">
          <strong>No Auror evidence data yet.</strong>
          <div style="margin-top:6px">Sign in to Auror, then click <em>Refresh</em>.</div>
        </div>`;
      return;
    }
    const flagged = (c.records || []).filter((r) => r.missing.length > 0);
    flagged.sort((a, b) => (b.occurredAt || "").localeCompare(a.occurredAt || ""));

    const rowsHtml = flagged.map((r) => {
      const missingBits = r.missing.map((m) => ({
        photo:     "Photo",
        statement: "Statement",
        // explainVideoGap names the absent angle when the clip file names allow
        // it, and falls back to the bare count when they don't.
        video:     `Video (${explainVideoGap(r).short})`,
      }[m] || m));
      const sev = r.missing.length >= 2 ? "fail" : "warn";
      return `
        <tr>
          <td>${escapeHtml(withWeekday((r.occurredAt || "").slice(0, 10)))}</td>
          <td><a href="https://app.us.auror.co/event/${encodeURIComponent(r.eventId)}" target="_blank" rel="noopener">${escapeHtml(r.title || "e" + r.eventId)}</a></td>
          <td>${escapeHtml(r.people || "—")}</td>
          <td>${r.totalValue != null ? "$" + Number(r.totalValue).toFixed(2) : "—"}</td>
          <td><span class="ld-cvp-pct" data-sev="${sev}" style="font-size:12px">${escapeHtml(missingBits.join(", "))}</span></td>
        </tr>`;
    }).join("");

    const captured = c.capturedAt ? withWeekday(new Date(c.capturedAt).toLocaleString(), c.capturedAt) : "?";
    drillBody.innerHTML = `
      <div class="ld-empty" style="margin-bottom:6px">
        <strong>${flagged.length}</strong> of ${c.records.length} events in the last ${c.days ?? "?"} days
        are missing required evidence (photo, statement, or the 3 video clips: theft, door, office)
        · store ${escapeHtml(c.storeNbr || "?")} · ${escapeHtml(captured)}
      </div>
      <table class="ld-table">
        <thead>
          <tr><th>Date</th><th>Event</th><th>People</th><th>Value</th><th>Missing</th></tr>
        </thead>
        <tbody>${rowsHtml || `<tr><td colspan="5" class="ld-empty" style="text-align:center;padding:16px">Every event in the window has a photo, a statement, and 3+ video clips. 🎉</td></tr>`}</tbody>
      </table>
      <div class="ld-empty" style="margin-top:6px; display:flex; gap:8px; align-items:center; flex-wrap:wrap">
        <span style="flex:1 1 auto">Click an event to open it in Auror.</span>
        <button type="button" class="btn btn-sm" data-ld-copy data-ld-copy-builder="auror-exceptions-email"
          title="Copy an email-ready report that spells out which clip each event is missing">Copy for email</button>
        <button type="button" class="btn btn-sm" data-ld-email="auror-exceptions"
          title="Open a new Outlook draft with the report">Open in Outlook</button>
      </div>
    `;
  }

  function renderComplianceDrill() {
    drillTitle.textContent = "Compliance Due Soon";
    const c = lastState?.sources?.compliance?.cache;
    if (!c?.tasks?.length) {
      drillBody.innerHTML = `<div class="ld-empty">No data yet. Click Refresh.</div>`;
      return;
    }
    const rowHtml = c.tasks.map((t, i) => {
      const sev = t.isOverdue ? (-t.daysUntilDue >= 7 ? "fail" : "warn")
                : t.isDueSoon ? "warn"
                : "ok";
      const dueDesc = t.daysUntilDue == null ? "?"
        : t.daysUntilDue < 0  ? `${-t.daysUntilDue}d overdue`
        : t.daysUntilDue === 0 ? "today"
        : t.daysUntilDue === 1 ? "tomorrow"
        : `${t.daysUntilDue}d`;
      return `
        <tr class="ld-row-clickable" data-task-idx="${i}" title="Open in Enviance">
          <td><span class="ld-cvp-pct" data-sev="${sev}" style="font-size:12px">${escapeHtml(dueDesc)}</span></td>
          <td>${escapeHtml(t.dueDate ? withWeekday(t.dueDate) : "?")}</td>
          <td>${escapeHtml(t.taskName)}</td>
          <td>${escapeHtml(t.category)}</td>
          <td>${escapeHtml(t.facility)}</td>
        </tr>
      `;
    }).join("");
    drillBody.innerHTML = `
      <table class="ld-table">
        <thead>
          <tr><th>Due</th><th>Date</th><th>Task</th><th>Cat</th><th>Facility</th></tr>
        </thead>
        <tbody>${rowHtml}</tbody>
      </table>
      <div class="ld-empty" style="margin-top:6px">
        ${c.tasks.length} task${c.tasks.length === 1 ? "" : "s"} ·
        updated ${escapeHtml(withWeekday(c.capturedAt || "?"))}
        · click a row to open in Enviance
      </div>
    `;
    // Wire row clicks → focus/open Enviance tab
    drillBody.querySelectorAll("tr.ld-row-clickable").forEach((tr) => {
      tr.addEventListener("click", async () => {
        statusText.textContent = "Opening Enviance…";
        try {
          await host.messaging.send("focus_enviance_tab");
          statusText.textContent = "Enviance tab focused.";
        } catch (e) {
          statusText.textContent = `Open failed: ${shortErr(e)}`;
        }
      });
    });
  }

  function renderCvpDrill() {
    drillTitle.textContent = "CVP Sell Through — by category";
    const c = lastState?.sources?.cvp?.cache;
    if (!c?.byCategory) {
      // Older cache (pre-breakdown) — show what we have
      if (c?.currentWeek) {
        drillBody.innerHTML = `
          <div class="ld-empty">Breakdown not in cache yet — click Refresh to pull Fresh/Food/GM.</div>
          ${renderCvpRow({ id: "headline", label: "Headline" }, c.currentWeek)}
        `;
        return;
      }
      drillBody.innerHTML = `<div class="ld-empty">No data yet. Click Refresh.</div>`;
      return;
    }
    const ordered = ["headline", "fresh", "food", "gm"];
    const html = ordered.map((id) => {
      const cat = c.byCategory[id];
      if (!cat) return "";
      const label = ({ headline: "Headline", fresh: "Fresh", food: "Food", gm: "GM" })[id];
      if (!cat.ok) {
        return `
          <div class="ld-cvp-row">
            <div class="ld-cvp-label">${label}</div>
            <div class="ld-cvp-pct">—</div>
            <div class="ld-error" style="grid-column: span 2">${escapeHtml(cat.error || cat.errorClass || "no data")}</div>
          </div>`;
      }
      return renderCvpRow({ id, label }, cat.currentWeek);
    }).join("");
    drillBody.innerHTML = html || `<div class="ld-empty">No category data available.</div>`;
  }

  function renderCvpRow(cat, cw) {
    if (!cw) {
      return `
        <div class="ld-cvp-row">
          <div class="ld-cvp-label">${cat.label}</div>
          <div class="ld-cvp-pct">—</div>
          <div class="ld-empty" style="grid-column: span 2">no rows</div>
        </div>`;
    }
    const pct = cw.sellThruPctTy;
    const ly  = cw.sellThruPctLy;
    const sev = sevForCvp(pct);
    const barPct = pct == null ? 0 : Math.max(0, Math.min(100, pct));
    const dir = (pct != null && ly != null)
      ? (pct - ly >= 0
          ? `▲ ${(pct - ly).toFixed(1)} vs LY ${ly.toFixed(1)}%`
          : `▼ ${(ly - pct).toFixed(1)} vs LY ${ly.toFixed(1)}%`)
      : "";
    const total = cw.cvpTotalQtyTy;
    return `
      <div class="ld-cvp-row">
        <div class="ld-cvp-label">${cat.label}</div>
        <div class="ld-cvp-pct" data-sev="${sev}">${pct == null ? "—" : pct.toFixed(1) + "%"}</div>
        <div class="ld-cvp-bar-track" title="${pct == null ? "no data" : pct.toFixed(1) + "%"}">
          <div class="ld-cvp-bar-fill" data-sev="${sev}" style="width:${barPct}%"></div>
        </div>
        <div class="ld-cvp-meta">${dir}${total != null ? ` · ${total.toLocaleString()} units` : ""}</div>
      </div>
    `;
  }

  // ── Click handlers ──────────────────────────────────────────────
  function onWidgetClick(ev) {
    const w = ev.currentTarget;
    const kind = w.dataset.drill;
    if (!kind) return;
    if (openDrill === kind) { closeDrill(); return; }
    openDrillFor(kind);
  }
  for (const w of container.querySelectorAll(".ld-widget[data-drill]:not([disabled])")) {
    w.addEventListener("click", onWidgetClick);
  }
  drillClose.addEventListener("click", closeDrill);

  // ── Copy-to-clipboard (delegated) ───────────────────────────────
  //
  // drillBody.innerHTML is replaced on every render, so this is delegated
  // rather than bound per button. To make any drill table copyable: wrap it in
  // [data-ld-copy-scope] and add a <button data-ld-copy="<heading line>">.
  drillBody.addEventListener("click", onDrillCopy);

  // Named builders produce a purpose-shaped string from state instead of
  // scraping the DOM. Without a builder a button falls back to table TSV.
  const COPY_BUILDERS = {
    "safety-obs-chat": () => safetyObsChatText(lastState),
    "auror-exceptions-email": () => aurorExceptionsEmail(lastState?.sources?.auror?.cache).body,
  };

  async function onDrillCopy(ev) {
    const mail = ev.target.closest("[data-ld-email]");
    if (mail) { onOpenOutlook(mail); return; }
    const btn = ev.target.closest("[data-ld-copy]");
    if (!btn) return;
    const builder = COPY_BUILDERS[btn.dataset.ldCopyBuilder];
    let text;
    if (builder) {
      text = builder();
    } else {
      const scope = btn.closest("[data-ld-copy-scope]") || drillBody;
      const table = scope.querySelector("table");
      if (!table) return;
      const heading = btn.dataset.ldCopy || "";
      const body = tsvFromTable(table);
      text = heading ? `${heading}\n${body}` : body;
    }
    if (!text) return;
    const ok = await copyText(text);
    flashButton(btn, ok ? "Copied ✓" : "Copy failed");
  }

  // Same deeplink closinglist uses. Outlook's compose URL is the only route
  // that survives without a mail client registered; over ~8k it silently
  // truncates, so fall back to the clipboard and say so.
  function onOpenOutlook(btn) {
    const { subject, body } = aurorExceptionsEmail(lastState?.sources?.auror?.cache);
    if (!body) { flashButton(btn, "Nothing to send"); return; }
    const url = `https://outlook.office.com/mail/deeplink/compose` +
      `?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    // A full month of exceptions is ~9k once URL-encoded, so the body does not
    // fit a compose deeplink and never will at this size. Rather than fail,
    // put the report on the clipboard and open a draft that already has the
    // subject and recipients line ready, so it is one Ctrl+V from sent.
    if (url.length > 8000) {
      const subjectOnly = `https://outlook.office.com/mail/deeplink/compose?subject=${encodeURIComponent(subject)}`;
      copyText(body).then((ok) => {
        if (ok) host.tabs.create({ url: subjectOnly });
        flashButton(btn, ok ? "Draft opened — press Ctrl+V" : "Copy failed");
      });
      return;
    }
    host.tabs.create({ url });
    flashButton(btn, "Opening Outlook…");
  }

  // Chat-shaped: one short line per day, no leading-space alignment and no
  // tabs. Workvivo/Sendbird collapses runs of whitespace and has no monospace,
  // so a padded or tab-separated grid arrives as mush — especially on mobile,
  // where a 9-column row wraps. Newlines survive; that's what we lean on.
  function safetyObsChatText(state) {
    const c = state?.sources?.recognition?.cache;
    if (!c?.rolling7d?.length) return "";
    const days   = c.rolling7d.slice().reverse();   // oldest → newest
    const engMap = new Map((c.engagement7d || []).map((r) => [r.dateIso, r.count || 0]));
    const hasEng = !!c.engagement7d;

    const weekText = wmWeekRangeLabel(days);
    const todayIso = isoTodayLocal();
    const header = [
      "Safety Observations",
      state.storeNbr ? `Store ${state.storeNbr}` : null,
      weekText || null,
    ].filter(Boolean).join(" — ");

    const lines = [`${header} (last 7 days)`];
    let recTotal = 0, engTotal = 0;
    for (const d of days) {
      if (d.dateIso === todayIso) {
        // Never print a bare 0 for today — it reads as "nobody logged
        // anything" when it means "the source hasn't landed it yet".
        lines.push(`${fmtDayLabel(d.dateIso)}: Current Day - Not Live`);
        continue;
      }
      const rec = d.count || 0;
      const eng = engMap.get(d.dateIso) ?? 0;
      recTotal += rec;
      engTotal += eng;
      lines.push(`${fmtDayLabel(d.dateIso)}: ${hasEng ? `${rec} rec, ${eng} eng` : `${rec}`}`);
    }
    lines.push(hasEng
      ? `Total: ${recTotal} recognition + ${engTotal} engagement = ${recTotal + engTotal}`
      : `Total: ${recTotal}`);
    return lines.join("\n");
  }

  function fmtDayLabel(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    const dt = new Date(y, m - 1, d);   // local, so the weekday matches the date
    return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dt.getDay()]} ${m}/${d}`;
  }

  // Tab-separated: pastes as real cells in Excel/Sheets and still reads as an
  // aligned block in an email or Workvivo post.
  function tsvFromTable(table) {
    // textContent, not innerText: innerText returns the RENDERED text, so the
    // headers' CSS text-transform:uppercase would paste "7D TOTAL" instead of
    // the "7d total" that's actually in the markup. &nbsp; → space so the
    // pasted cells don't carry U+00A0 into Excel.
    const cell = (c) => (c.textContent || "").replace(/ /g, " ").trim();
    return [...table.querySelectorAll("tr")]
      .map((tr) => [...tr.querySelectorAll("th,td")].map(cell).join("\t"))
      .join("\n");
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Clipboard API needs a focused document; fall back to the old path so a
      // background-focused shell tab still copies.
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        return ok;
      } catch {
        return false;
      }
    }
  }

  function flashButton(btn, msg) {
    if (btn.dataset.ldFlashing) return;
    const original = btn.textContent;
    btn.dataset.ldFlashing = "1";
    btn.textContent = msg;
    setTimeout(() => {
      btn.textContent = original;
      delete btn.dataset.ldFlashing;
    }, 1400);
  }

  // ── Refresh + store change ─────────────────────────────────────
  async function onRefreshClick() {
    // Deliberately NOT on `bootstrap`, which fires whenever the dashboard is
    // opened — that is module_opened wearing a different hat.
    host.usage.record("refresh_all");
    refreshBtn.disabled = true;
    refreshBtn.textContent = "Refreshing…";
    statusText.textContent = "Refreshing…";
    try {
      const resp = await host.messaging.send("refresh_all");
      const r = resp?.data ?? resp;
      const lines = [];
      if (r.cvp?.ok) {
        const hp = r.cvp.byCategory?.headline?.currentWeek?.sellThruPctTy;
        lines.push(`CVP ${hp == null ? "?" : hp.toFixed(1)}%`);
      } else lines.push(`CVP: ${shortErr(r.cvp?.error)}`);
      if (r.absences?.ok) lines.push(`Absences ${r.absences.counts?.callouts ?? 0}`);
      else                lines.push(`Absences: ${shortErr(r.absences?.error)}`);
      if (r.compliance?.ok) lines.push(`Compliance ${r.compliance.counts?.overdue ?? 0} overdue / ${r.compliance.counts?.dueSoon ?? 0} soon`);
      else                  lines.push(`Compliance: ${shortErr(r.compliance?.error)}`);
      if (r.auror?.ok)      lines.push(`Auror ${r.auror.counts?.flagged ?? 0} missing evidence`);
      else                  lines.push(`Auror: ${shortErr(r.auror?.error)}`);
      if (r.accident?.ok)   lines.push(`Accident ${r.accident.counts?.withMissing ?? 0} with missing / ${r.accident.counts?.highPriority ?? 0} high`);
      else                  lines.push(`Accident: ${shortErr(r.accident?.error)}`);
      if (r.recognition?.ok) {
        const sum7d = (s) => (s || []).reduce((a, x) => a + (x.count || 0), 0);
        const rec = sum7d(r.recognition.rolling7d);
        const eng = sum7d(r.recognition.engagement7d);
        lines.push(`Safety Obs ${rec + eng} this week`);
      } else                lines.push(`Safety Obs: ${shortErr(r.recognition?.error)}`);
      statusText.textContent = lines.join(" · ");
    } catch (e) {
      statusText.textContent = `Refresh failed: ${shortErr(e)}`;
    } finally {
      refreshBtn.disabled = false;
      refreshBtn.textContent = "Refresh";
      await reload();
    }
  }
  refreshBtn.addEventListener("click", onRefreshClick);

  async function onStoreCommit() {
    const v = (storeInput.value || "").trim();
    if (!v) return;
    const prevStore = lastState?.storeNbr;
    if (v === prevStore) return;   // no-op when unchanged
    refreshBtn.disabled = true;
    storeInput.disabled = true;
    statusText.textContent = `Switching to store ${v}…`;
    // Optimistic widget paint: clear the CVP cache view to "loading"
    setWidgetLoading("ld-w-cvp", `pulling CVP for ${v}…`);
    try {
      const resp = await host.messaging.send("set_store", { storeNbr: v });
      const r = resp?.data ?? resp;
      if (!r?.ok) {
        statusText.textContent = `Bad store: ${r?.error || "unknown"}`;
        return;
      }
      const cvp = r.cvp;
      if (cvp?.ok) {
        const hp = cvp.byCategory?.headline?.currentWeek?.sellThruPctTy;
        statusText.textContent = `Store → ${r.settings.storeNbr}${hp == null ? "" : ` · CVP ${hp.toFixed(1)}%`}`;
      } else {
        statusText.textContent = `Store → ${r.settings.storeNbr} · CVP pull: ${shortErr(cvp?.error)}`;
      }
      await reload();
    } catch (e) {
      statusText.textContent = `Set store failed: ${shortErr(e)}`;
    } finally {
      refreshBtn.disabled = false;
      storeInput.disabled = false;
    }
  }
  storeInput.addEventListener("change", onStoreCommit);
  storeInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); onStoreCommit(); }
  });

  // Temporary "loading…" treatment for a widget while a fresh pull runs.
  // Doesn't mutate cache state — just paints over the value until reload().
  function setWidgetLoading(widgetId, msg) {
    const w = $(widgetId);
    if (!w) return;
    w.dataset.sev = "pending";
    const pill = w.querySelector(".ld-widget-pill");
    const prim = w.querySelector(".ld-widget-primary");
    const sec  = w.querySelector(".ld-widget-secondary");
    if (pill) pill.textContent = "loading";
    if (prim) prim.textContent = "…";
    if (sec)  sec.textContent  = msg;
  }

  // Subscribe to source_complete broadcasts → live repaint without click
  const unsubSourceComplete = host.messaging.on("source_complete", (msg) => {
    statusText.textContent = `${msg.payload?.sourceId}: ${msg.payload?.ok ? "ok" : "fail"}`;
    reload();
  });

  // When the user returns to this tab (e.g., after signing into Hoops in
  // another tab), re-run bootstrap. Any source with a stale lastError
  // will retry per shouldBootstrap's lastError-forces-retry rule. Same
  // for sources whose lastSuccess crossed the 12h global cap while the
  // tab was hidden.
  async function onVisibilityChange() {
    if (document.hidden) return;
    try {
      await host.messaging.send("bootstrap");
      // Reload once bootstrap returns (it's fire-and-forget on the SW side,
      // but the resp tells us how many sources were triggered). Real data
      // arrives via source_complete broadcasts, which trigger another reload.
      await reload();
    } catch (e) {
      // Quiet — bootstrap failure shouldn't block the user.
      console.warn("[livedashboard view] bootstrap on visibility failed:", e?.message);
    }
  }
  document.addEventListener("visibilitychange", onVisibilityChange);

  // Initial paint
  await reload();

  // Cleanup
  return () => {
    for (const w of container.querySelectorAll(".ld-widget[data-drill]:not([disabled])")) {
      w.removeEventListener("click", onWidgetClick);
    }
    drillClose.removeEventListener("click", closeDrill);
    drillBody.removeEventListener("click", onDrillCopy);
    refreshBtn.removeEventListener("click", onRefreshClick);
    storeInput.removeEventListener("change", onStoreCommit);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    unsubSourceComplete();
    link.remove();
  };
}
