// modules/livedashboard/view.js
//
// Live Dashboard UI controller. Mounted by the shell on the home page
// ABOVE the module-card grid (kind: "home-header"). Loads view.html +
// styles.css, requests dashboard state from the SW, paints 5 widgets,
// wires drill-downs for Callouts + CVP.

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
  let openDrill = null;   // "absences" | "cvp" | "compliance" | "register" | null
  const openDrillState = { registerShowAll: false };   // per-drill local UI state

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
      statusText.textContent = `State error: ${shortErr(e)}`;
    }
  }

  function paint(state) {
    if (!state) return;
    storeInput.value = state.storeNbr || "";
    paintAbsences(state.sources.absences, state.freshness.absences);
    paintCvp(state.sources.cvp, state.freshness.cvp);
    paintCompliance(state.sources.compliance, state.freshness.compliance);
    paintRegister(state.sources.register, state.freshness.register);
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
      setLoadingWidget(w, pill, prim, sec, foot, "fetching from IVR…");
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
        sec.textContent  = "click Refresh to collect from IVR";
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
      setLoadingWidget(w, pill, prim, sec, foot, "fetching from CAS storage…");
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
        sec.textContent  = "click Refresh to pull";
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

  function paintRegister(src, fresh) {
    const w = $("ld-w-register");
    const pill = $("ld-w-register-pill");
    const prim = $("ld-w-register-primary");
    const sec  = $("ld-w-register-secondary");
    const foot = $("ld-w-register-foot");
    if (!w) return;

    const c = src?.cache;
    if (fresh?.inFlight && !c) {
      setLoadingWidget(w, pill, prim, sec, foot, "capturing Power BI report…");
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
        sec.textContent  = "click to pull from Power BI";
        foot.textContent = "no data yet";
      }
      return;
    }
    const counts = c.counts;
    const headlineCount = (counts.r1 ?? 0) + (counts.suspectFlipCount ?? 0);
    const baseSev = headlineCount === 0 ? "ok"
                  : counts.high > 0     ? "fail"
                  : "warn";
    w.dataset.sev = fresh?.isStale ? "stale" : baseSev;
    pill.textContent = fresh?.isStale ? "stale" : sevLabel(baseSev);
    prim.textContent = String(headlineCount);
    const r1Part = `${counts.r1 ?? 0} unmatched`;
    const suspPart = counts.suspectFlipCount > 0 ? ` · ${counts.suspectFlipCount} suspect` : "";
    sec.textContent  = `${r1Part}${suspPart}${counts.high ? ` · ${counts.high} high` : ""}`;
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
      setLoadingWidget(w, pill, prim, sec, foot, "opening go.enviance.com…");
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
        sec.textContent  = "click Refresh; opens Enviance in background";
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
      setLoadingWidget(w, pill, prim, sec, foot, "pulling from Hoops…");
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
        sec.textContent  = "click Refresh to pull from Hoops";
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
    if (kind === "register")     return renderRegisterDrill();
    if (kind === "accident")     return renderAccidentDrill();
  }

  function renderAbsencesDrill() {
    drillTitle.textContent = "Callouts Today — who called out";
    const c = lastState?.sources?.absences?.cache;
    if (!c) {
      drillBody.innerHTML = `<div class="ld-empty">No absence data yet. Click Refresh to collect from IVR.</div>`;
      return;
    }
    const today = c.todayIso;
    const todayRows = (c.records || []).filter((r) => r.absenceDate === today);
    if (!todayRows.length) {
      const captured = c.capturedAt || "—";
      const totalAll = (c.records || []).length;
      drillBody.innerHTML = `
        <div class="ld-empty">
          <strong>No callouts on file for today (${escapeHtml(today || "—")}).</strong>
          <div style="margin-top:6px">IVR pull succeeded but returned no records for the current day${totalAll ? ` (${totalAll} record${totalAll === 1 ? "" : "s"} for other dates in cache)` : ""}.</div>
          <div style="margin-top:4px">Captured ${escapeHtml(String(captured))}.
          If you expect records, the IVR scraper may have landed before the day's first calls came in — click Refresh to retry.</div>
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
        <td>${escapeHtml(r.callDateTime || "")}</td>
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
        ${todayRows.length} record${todayRows.length === 1 ? "" : "s"} for ${escapeHtml(today)} ·
        captured ${escapeHtml(c.capturedAt || "?")}
      </div>
    `;
  }

  function renderAccidentDrill() {
    drillTitle.textContent = "Accident Details";
    const c = lastState?.sources?.accident?.cache;
    const accidentHtml = c?.records?.length
      ? buildAccidentSection(c)
      : `<div class="ld-empty">No accident records yet. Click Refresh to pull from CAS storage.</div>`;
    const recognitionHtml = buildRecognitionSection(lastState?.sources?.recognition);
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
        — source updated ${escapeHtml(c.sourceDataUpdatedOn || "?")},
        captured ${escapeHtml(c.capturedAt || "?")}
      </div>
      ${sections}
    `;
  }

  function buildRecognitionSection(src) {
    const header = `<h4 style="margin:14px 0 6px;font-size:12px;text-transform:uppercase;color:#4a4a4a">Recognition — last 7 days</h4>`;
    const c = src?.cache;
    if (!c?.rolling7d?.length) {
      return `${header}<div class="ld-empty">No recognition data yet. Click Refresh — pulls from the Field_Dashboard Power BI report.</div>`;
    }
    // Oldest → newest reads naturally left-to-right.
    const days  = c.rolling7d.slice().reverse();
    const total = days.reduce((a, r) => a + (r.count || 0), 0);
    const dateCells  = days.map((r) => `<th>${escapeHtml(fmtDateShort(r.dateIso))}</th>`).join("");
    const countCells = days.map((r) => `<td style="text-align:center">${r.count}</td>`).join("");
    return `
      ${header}
      <table class="ld-table">
        <thead>
          <tr>${dateCells}<th style="text-align:right">7d&nbsp;total</th></tr>
        </thead>
        <tbody>
          <tr>${countCells}<td style="text-align:right"><strong>${total}</strong></td></tr>
        </tbody>
      </table>
      <div class="ld-empty" style="margin-top:6px">
        Captured ${escapeHtml(c.capturedAt || "?")}${c.replayed ? " (store-filter replay)" : ""}
      </div>
    `;
  }

  function fmtDateShort(iso) {
    if (!iso) return "—";
    const [y, m, d] = iso.split("-");
    return `${Number(m)}/${Number(d)}/${y}`;
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

  function renderRegisterDrill() {
    drillTitle.textContent = "Register Exceptions — theft + high-risk misses";
    const c = lastState?.sources?.register?.cache;
    if (!c?.findings) {
      drillBody.innerHTML = `
        <div class="ld-empty">
          <strong>No register data yet.</strong>
          <div style="margin-top:6px">Click <em>Refresh</em> to pull from Power BI.
          The first pull opens the report in a background tab; subsequent pulls poll every 6h.</div>
        </div>`;
      return;
    }
    const findings = c.findings || [];
    // SURFACE: R1 unmatched + low-confidence flips (suspect concealed loss)
    const surface = findings.filter((f) => f.displayPriority === "primary");
    surface.sort((a, b) => {
      // High severity first; then largest amount; then date desc
      const sevRank = { high: 0, medium: 1, low: 2 };
      const sr = sevRank[a.severity] - sevRank[b.severity];
      if (sr !== 0) return sr;
      const ar = Math.abs(a.primaryAmountCents) - Math.abs(b.primaryAmountCents);
      if (ar !== 0) return -ar;
      return (b.primaryDate || "").localeCompare(a.primaryDate || "");
    });
    const watch = findings.filter((f) => f.displayPriority === "watch");
    const noise = findings.filter((f) => f.displayPriority === "noise");

    const showAll = openDrillState.registerShowAll === true;
    const visible = showAll ? findings : surface.concat(watch);

    const rowsHtml = visible.map((f) => {
      const sevColor = f.severity === "high" ? "fail" : f.severity === "medium" ? "warn" : "ok";
      const matchSummary = f.matchType === "none"
        ? `<span class="ld-cvp-pct" data-sev="fail" style="font-size:12px">UNMATCHED</span>`
        : f.matchType === "nearby-register-offset"
          ? `<span style="color:#6f6f6f">reg ${escapeHtml(f.matchedAgainst[0]?.registerNbr || "?")} ${escapeHtml(fmtAmount(f.matchedAgainst[0]?.amountCents))} (${escapeHtml(String(f.matchedAgainst[0]?.daysApart))}d)</span>`
          : `<span style="color:#6f6f6f">same reg, ${escapeHtml(String(f.matchedAgainst[0]?.daysApart))}d apart</span>`;
      const confTxt = f.matchType === "none" ? "—" : `${Math.round((f.flipConfidence || 0) * 100)}%`;
      const ops = (f.primaryOperators || []).map((o) => escapeHtml(o.operatorId)).join(", ") || "—";
      return `
        <tr>
          <td>${escapeHtml(f.primaryDate)}</td>
          <td>${escapeHtml(f.primaryRegister)}</td>
          <td><span class="ld-cvp-pct" data-sev="${sevColor}" style="font-size:12px">${escapeHtml(fmtAmount(f.primaryAmountCents))}</span></td>
          <td>${matchSummary}</td>
          <td>${escapeHtml(confTxt)}</td>
          <td>${escapeHtml(f.severity)}</td>
          <td>${ops}</td>
        </tr>`;
    }).join("");

    const captured = c.capturedAt ? new Date(c.capturedAt).toLocaleString() : "?";
    const stale = c.replayed ? " (live replay)" : " (capture)";

    drillBody.innerHTML = `
      <div class="ld-empty" style="margin-bottom:6px">
        <strong>${surface.length}</strong> primary
        ${watch.length ? `· ${watch.length} watch` : ""}
        ${noise.length ? `· ${noise.length} likely-flip (hidden)` : ""}
        — ${c.cellCount ?? c.discrepancies?.length ?? "?"} cells, ${c.shiftCount ?? 0} shifts
        · ${escapeHtml(captured)}${stale}
        <label style="margin-left:12px;font-size:11px;cursor:pointer">
          <input type="checkbox" id="ld-reg-show-all" ${showAll ? "checked" : ""}> show all
        </label>
      </div>
      <table class="ld-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Reg</th>
            <th>Amount</th>
            <th>Match</th>
            <th>Flip&nbsp;Conf</th>
            <th>Sev</th>
            <th>Operator(s)</th>
          </tr>
        </thead>
        <tbody>${rowsHtml || `<tr><td colspan="7" class="ld-empty" style="text-align:center;padding:16px">No findings to surface — nothing flagged as theft or high-risk miss. ${noise.length ? `Toggle "show all" to see ${noise.length} likely flips.` : ""}</td></tr>`}</tbody>
      </table>
    `;

    // Wire show-all toggle
    const toggle = $("ld-reg-show-all");
    if (toggle) toggle.addEventListener("change", (ev) => {
      openDrillState.registerShowAll = ev.target.checked;
      renderRegisterDrill();
    });
  }

  function fmtAmount(cents) {
    if (cents == null) return "—";
    const sign = cents < 0 ? "-" : "+";
    return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
  }

  function renderComplianceDrill() {
    drillTitle.textContent = "Compliance Due Soon — task list (click row to open in Enviance)";
    const c = lastState?.sources?.compliance?.cache;
    if (!c?.tasks?.length) {
      drillBody.innerHTML = `<div class="ld-empty">No compliance tasks yet. Click Refresh — opens go.enviance.com in a background tab.</div>`;
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
          <td>${escapeHtml(t.dueDate || "?")}</td>
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
        captured ${escapeHtml(c.capturedAt || "?")}${c.fromReplay ? " (live replay)" : " (from page bootstrap)"}
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
      drillBody.innerHTML = `<div class="ld-empty">No CVP data yet. Click Refresh to pull from Hoops.</div>`;
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

  // ── Refresh + store change ─────────────────────────────────────
  async function onRefreshClick() {
    refreshBtn.disabled = true;
    refreshBtn.textContent = "Refreshing…";
    statusText.textContent = "Refreshing CVP + Absences…";
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
      if (r.register?.ok)   lines.push(`Register ${r.register.counts?.r1 ?? 0} unmatched / ${r.register.counts?.suspectFlipCount ?? 0} suspect`);
      else                  lines.push(`Register: ${shortErr(r.register?.error)}`);
      if (r.accident?.ok)   lines.push(`Accident ${r.accident.counts?.withMissing ?? 0} with missing / ${r.accident.counts?.highPriority ?? 0} high`);
      else                  lines.push(`Accident: ${shortErr(r.accident?.error)}`);
      if (r.recognition?.ok) {
        const total7d = (r.recognition.rolling7d || []).reduce((a, x) => a + (x.count || 0), 0);
        lines.push(`Recognition ${total7d}/7d`);
      } else                lines.push(`Recognition: ${shortErr(r.recognition?.error)}`);
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
    refreshBtn.removeEventListener("click", onRefreshClick);
    storeInput.removeEventListener("change", onStoreCommit);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    unsubSourceComplete();
    link.remove();
  };
}
