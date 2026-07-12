// modules/claimsbuddy/view.js
//
// ClaimsBuddy UI controller. Mounted by the shell on #/claimsbuddy.
// Adapted from donor extension/app.js (~700 lines). All rendering logic
// preserved verbatim; changes limited to:
//   - Exports mount(host, container) per docs/ARCHITECTURE.md::2
//   - Container-scoped DOM helper $ (replaces document.querySelector)
//   - All IDs prefixed cb- to avoid collisions with other modules' DOM
//   - Click-delegation handler attached to container (not document)
//   - Stylesheet injected via host.url("styles.css")
//   - VEE features show an "Install bridge" prompt when native host isn't
//     registered yet (cross-extension: the donor's bridge works if the user
//     already installed it; otherwise we point them at modules/claimsbuddy/
//     native_host/setup.cmd in this folder)

import { normalizeStore }            from "./lib/store.js";
import { fetchCasReport }            from "./lib/cas.js";
import { fetchVeeReport }            from "./lib/vee.js";
import { fetchClearSightOpenClaims } from "./lib/clearsight.js";
import { syncUsers, hasUsers, getDbMeta, getClaimsForStore, enrichCasRow } from "./lib/db.js";

const CLEARSIGHT_SPA_URL = "https://www.riskonnectclearsight.com/Walmart/StormsPackages/Storms.Wrapper/#/";

export async function mount(host, container) {
  // ── 1. Inject stylesheet ────────────────────────────────────────────
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = host.url("styles.css");
  link.dataset.module = host.id;
  document.head.appendChild(link);

  // ── 2. Load markup ──────────────────────────────────────────────────
  try {
    const resp = await fetch(host.url("view.html"));
    container.innerHTML = await resp.text();
  } catch (e) {
    container.innerHTML = `<div class="state-error">Failed to load ClaimsBuddy view: ${String(e?.message ?? e)}</div>`;
    return async () => { link.remove(); };
  }

  // ── 3. Module-scoped DOM helper ─────────────────────────────────────
  const $ = (sel) => container.querySelector(sel);

  const els = {
    store:        $("#cb-store"),
    load:         $("#cb-btn-load"),
    status:       $("#cb-status-line"),
    storeSummary: $("#cb-store-summary"),
    pillCas:      $("#cb-pill-cas"),
    pillVee:      $("#cb-pill-vee"),
    pillCs:       $("#cb-pill-clearsight"),
    evResults:    $("#cb-results"),
    pillCasDb:    $("#cb-pill-cas-db"),
    pillDf:       $("#cb-pill-datafile"),
    dbLastSync:   $("#cb-db-last-sync"),
    btnSync:      $("#cb-btn-sync-users"),
    clResults:    $("#cb-claims-results"),
  };

  // ── Tab switching ─────────────────────────────────────────────────
  let activeTab = "evidence";
  for (const btn of container.querySelectorAll(".tab-btn")) {
    btn.addEventListener("click", () => {
      activeTab = btn.dataset.tab;
      for (const b of container.querySelectorAll(".tab-btn")) {
        b.classList.toggle("active", b === btn);
        b.setAttribute("aria-selected", String(b === btn));
      }
      for (const p of container.querySelectorAll(".tab-panel")) {
        p.classList.toggle("hidden", p.id !== `cb-tab-${activeTab}`);
      }
    });
  }

  // ── Restore state ─────────────────────────────────────────────────
  chrome.storage.local.get("claimsbuddy.lastStore").then((g) => {
    if (g["claimsbuddy.lastStore"]) els.store.value = g["claimsbuddy.lastStore"];
  });

  refreshSyncBadge();

  // ── Event wiring ──────────────────────────────────────────────────
  els.load.addEventListener("click", run);
  els.store.addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
  els.btnSync.addEventListener("click", doSyncUsers);

  // Delegated handler for claimant-name → ClearSight hand-off.
  //   1. Copy ref# to clipboard.
  //   2. Activate the existing ClearSight tab (or open a new one).
  //   3. Ping the content script to focus the Quick Search input.
  //   4. User hits Ctrl+V Enter — claim opens.
  // Scoped to container so detaching the module removes it cleanly.
  container.addEventListener("click", async (e) => {
    const a = e.target.closest(".claim-copy");
    if (!a) return;
    e.preventDefault();
    const ref = a.dataset.ref;
    if (!ref) return;

    const orig = a.textContent;
    a.classList.add("claim-copy-flash");

    try {
      await navigator.clipboard.writeText(ref);
      a.textContent = `${ref} → ClearSight`;
      await openInClearSight(ref);
    } catch (err) {
      console.warn("[ClaimsBuddy] claim open failed", err);
      a.textContent = `${ref} copied`;
    } finally {
      setTimeout(() => {
        a.textContent = orig;
        a.classList.remove("claim-copy-flash");
      }, 1500);
    }
  });

  async function openInClearSight(ref) {
    const tabs = await chrome.tabs.query({
      url: "https://www.riskonnectclearsight.com/Walmart/StormsPackages/Storms.Wrapper/*",
    });
    let tab = tabs[0];
    let coldOpen = false;
    if (tab) {
      await chrome.tabs.update(tab.id, { active: true });
      if (tab.windowId !== chrome.windows.WINDOW_ID_NONE) {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
    } else {
      tab = await chrome.tabs.create({ url: CLEARSIGHT_SPA_URL });
      coldOpen = true;
    }

    const sendFocus = async () => {
      try {
        await chrome.tabs.sendMessage(tab.id, { action: "focus_search", ref });
      } catch (err) {
        console.debug("[ClaimsBuddy] focus_search message failed (clipboard still has ref)", err);
      }
    };
    if (coldOpen) {
      setTimeout(sendFocus, 4000);
    } else {
      await sendFocus();
    }
  }

  // ── Sync adjuster roster ──────────────────────────────────────────
  async function doSyncUsers() {
    els.btnSync.disabled = true;
    els.dbLastSync.textContent = "Syncing…";
    try {
      const meta = await syncUsers();
      els.dbLastSync.textContent = `Synced ${meta.userCount} adjusters — ${fmtTime(meta.lastSync)}`;
    } catch (err) {
      els.dbLastSync.textContent = `Sync failed: ${err.message}`;
    } finally {
      els.btnSync.disabled = false;
    }
  }

  async function refreshSyncBadge() {
    const meta = await getDbMeta();
    if (meta) {
      els.dbLastSync.textContent = `${meta.userCount} adjusters cached — ${fmtTime(meta.lastSync)}`;
    }
  }

  // ── Main load ─────────────────────────────────────────────────────
  async function run() {
    let store;
    try {
      store = normalizeStore(els.store.value);
    } catch (err) {
      setStatus(err.message, "error");
      return;
    }
    chrome.storage.local.set({ "claimsbuddy.lastStore": store.short });
    els.load.disabled = true;
    setStatus(`Loading store ${store.short}…`);
    els.storeSummary.classList.add("hidden");

    // Fetch CAS once up front so both tabs share the same data AND we can
    // surface a store-level summary right under the picker.
    let casShared = null;
    try {
      casShared = await fetchCasReport(store);
    } catch (err) {
      console.warn("[ClaimsBuddy] CAS prefetch failed", err);
    }
    renderStoreSummary(casShared);

    await Promise.all([
      runEvidence(store, casShared),
      runClaimsDashboard(store, casShared),
    ]);

    els.load.disabled = false;
    setStatus("");
  }

  function renderStoreSummary(cas) {
    if (!cas) {
      els.storeSummary.classList.add("hidden");
      return;
    }
    const open    = (cas.bodilyInjury?.length ?? 0)
                  + (cas.garageKeeper?.length ?? 0)
                  + (cas.openClaims?.length    ?? 0);
    const closed  =  cas.closedPaidClaims?.length ?? 0;
    const charges = cas.chargesByRef ?? new Map();
    let pending = 0;
    const seen = new Set();
    for (const r of [
      ...(cas.bodilyInjury ?? []),
      ...(cas.garageKeeper ?? []),
      ...(cas.openClaims   ?? []),
    ]) {
      if (seen.has(r.referenceNbr)) continue;
      seen.add(r.referenceNbr);
      pending += charges.get(r.referenceNbr) ?? 0;
    }
    els.storeSummary.textContent =
      `${open} open claim${open === 1 ? "" : "s"} · ${fmtCurrency(pending)} pending` +
      (closed > 0 ? ` · ${closed} closed (FY27)` : "");
    els.storeSummary.classList.remove("hidden");
  }

  // ── Evidence tab ──────────────────────────────────────────────────
  async function runEvidence(store, casShared) {
    setPill("cas", "busy", "CAS: fetching…");
    setPill("vee", "busy", "VEE: fetching…");
    setPill("clearsight", "busy", "ClearSight: fetching…");

    const casPromise = casShared
      ? Promise.resolve(casShared)
      : fetchCasReport(store);

    const [casRes, veeRes, csRes] = await Promise.allSettled([
      casPromise,
      fetchVeeReport(store),
      fetchClearSightOpenClaims(store, (s) => setPill("clearsight", "busy", `ClearSight: ${s}`)),
    ]);

    reportPill("cas",        casRes, (d) => `CAS: ${d.bodilyInjury.length + d.garageKeeper.length + (d.openClaims?.length ?? 0)} claims`);
    reportPill("vee",        veeRes, (d) => d.offHomeStore
      ? `VEE: home store only (${d.homeStore}) — using cache`
      : `VEE: ${d.records?.length ?? 0} transfers`);
    reportClearSightPill(csRes);

    renderEvidence({
      cas: casRes.status === "fulfilled" ? casRes.value : null,
      vee: veeRes.status === "fulfilled" ? veeRes.value : null,
      cs:  csRes.status  === "fulfilled" ? csRes.value  : null,
    });
  }

  // ── Claims Dashboard tab ─────────────────────────────────────────
  async function runClaimsDashboard(store, casShared) {
    setPillDb("cas",      "busy", "CAS: fetching…");
    setPillDb("datafile", "busy", "DataFile: fetching…");

    const casPromise = casShared
      ? Promise.resolve(casShared)
      : fetchCasReport(store);

    const [casRes, dfRes] = await Promise.allSettled([
      casPromise,
      getClaimsForStore(store.short),
    ]);

    reportPillDb("cas",      casRes, (d) => `CAS: ${d.bodilyInjury.length + d.garageKeeper.length + (d.openClaims?.length ?? 0)} claims`);
    reportPillDb("datafile", dfRes,  (d) => `DataFile: ${d.claims.length} claims`);

    const cas = casRes.status === "fulfilled" ? casRes.value : null;
    const df  = dfRes.status  === "fulfilled" ? dfRes.value  : null;
    await renderClaimsDashboard(cas, df);
  }

  async function renderClaimsDashboard(cas, df) {
    els.clResults.innerHTML = "";

    if (!cas && !df) {
      els.clResults.innerHTML = `<div class="muted">No data — check the source pills above.</div>`;
      return;
    }

    const allCas = cas ? [...cas.bodilyInjury, ...cas.garageKeeper] : [];
    const byRef  = df?.byRef ?? new Map();

    const enriched = await Promise.all(
      allCas.map(async (row) => {
        const { dbClaim, adjuster } = await enrichCasRow(row, byRef);
        return { cas: row, db: dbClaim, adj: adjuster };
      })
    );

    const missing  = enriched.filter((r) => r.cas.status === "Inefficient");
    const others   = enriched.filter((r) => r.cas.status !== "Inefficient");

    others.sort((a, b) => {
      const da = a.db?.["Date of Loss"] ?? "";
      const db = b.db?.["Date of Loss"] ?? "";
      return db.localeCompare(da);
    });

    if (missing.length > 0) {
      els.clResults.appendChild(sectionHeader(`⚠ Missing Evidence — ${missing.length} claim${missing.length !== 1 ? "s" : ""}`, "warn"));
      els.clResults.appendChild(buildClaimsTable(missing, cas?.chargesByRef));
      const divider = document.createElement("div");
      divider.className = "section-divider";
      els.clResults.appendChild(divider);
    }

    const allLabel = missing.length > 0
      ? `All Other Claims — ${others.length}`
      : `All Claims — ${enriched.length}`;
    els.clResults.appendChild(sectionHeader(allLabel, ""));
    els.clResults.appendChild(buildClaimsTable(others.length > 0 ? others : enriched, cas?.chargesByRef));
  }

  function buildClaimsTable(rows, chargesByRef) {
    const charges = chargesByRef ?? new Map();
    const table = document.createElement("table");
    table.className = "claims";
    table.innerHTML = `
      <thead><tr>
        <th>Ref #</th><th>Claimant</th><th>Type</th>
        <th>Date of Loss</th><th>Days</th><th>Status</th><th>Charges</th><th>Adjuster</th>
      </tr></thead>
      <tbody></tbody>`;
    const tbody = table.querySelector("tbody");

    for (const { cas: r, db: d, adj: a } of rows) {
      const claimType = d?.["Claim Type"] ?? "";
      const deadline  = /garage keeper|gk|pd/i.test(claimType) ? 5 : 17;
      const daysCls   = daysClass(r.daysOpen, deadline);
      const statusCls = r.status === "Inefficient" ? "badge badge-warn" : "badge badge-ok";
      const charge    = charges.get(r.referenceNbr) ?? 0;
      const adjHtml   = a
        ? `<span class="adj-name">${esc(a["Name"] ?? "")}</span>
           <a class="adj-email" href="mailto:${esc(a["Email"] ?? "")}">${esc(a["Email"] ?? "")}</a>
           ${a["Phone Nbr"] && a["Phone Nbr"] !== "0" ? `<span class="adj-phone">${esc(String(a["Phone Nbr"]))}</span>` : ""}`
        : `<span class="muted">${esc(d?.["Adjuster"] ?? "—")}</span>`;

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${esc(r.referenceNbr)}</td>
        <td>${claimantLink(r, d)}</td>
        <td>${esc(d?.["Claim Type"] ?? "")}</td>
        <td>${esc(d?.["Date of Loss"] ?? "")}</td>
        <td class="${daysCls}">${esc(String(r.daysOpen))}</td>
        <td><span class="${statusCls}">${esc(r.status)}</span></td>
        <td style="text-align:right;">${esc(fmtCurrency(charge))}</td>
        <td class="adj-cell">${adjHtml}</td>`;
      tbody.appendChild(tr);
    }
    return table;
  }

  // ── Evidence tab rendering ────────────────────────────────────────
  function renderEvidence({ cas, vee, cs }) {
    els.evResults.innerHTML = "";
    if (!cas && !vee && !cs) {
      els.evResults.innerHTML = `<div class="muted">No data — check the source pills above.</div>`;
      return;
    }
    if (cas) renderCasInefficient(cas, vee);
    if (cas) renderOpenClaimsFromPnl(cas, vee);
    if (cas) renderClosedPaidFromPnl(cas);
    if (cs)  renderClearSightSection(cs);
  }

  function renderCasInefficient(cas, vee) {
    const veeByEvidence = indexVeeByEvidence(vee);
    const charges = cas.chargesByRef ?? new Map();
    for (const [label, deadline, rows] of [
      ["Bodily Injury",     17, cas.bodilyInjury],
      ["Garage Keeper PD",   5, cas.garageKeeper],
    ]) {
      const inefficient = rows.filter((r) => r.status === "Inefficient");
      const title = sectionHeader(`${label} — ${inefficient.length} inefficient / ${rows.length} total (deadline ${deadline} days)`, "");
      els.evResults.appendChild(title);
      if (rows.length === 0) {
        const none = document.createElement("div");
        none.className = "muted";
        none.textContent = "No claims listed.";
        els.evResults.appendChild(none);
        continue;
      }
      const table = document.createElement("table");
      table.className = "claims";
      table.innerHTML = `
        <thead><tr>
          <th>Ref #</th><th>Claimant</th><th>Days open</th><th>Missing</th><th>Video transfer (VEE)</th><th>Charges</th>
        </tr></thead><tbody></tbody>`;
      const tbody = table.querySelector("tbody");
      const sortedRows = [
        ...inefficient,
        ...rows.filter((r) => r.status !== "Inefficient"),
      ];
      for (const r of sortedRows) {
        let missing = listMissing(r);
        const uploaded = veeUploadedFor(veeByEvidence, r.referenceNbr);
        if (uploaded) missing = missing.filter((m) => m !== "Video");
        const daysCls      = daysClass(r.daysOpen, deadline);
        const missingCls   = missing.length > 0 ? "missing" : "muted";
        const missingText  = missing.join(", ") || "(none)";
        const videoMissing = listMissing(r).includes("Video");
        const veeNote = videoMissing
          ? veeStatusFor(veeByEvidence, r.referenceNbr)
          : (r.enhancedExport === "Yes" ? "uploaded via VEE" : "—");
        const charge = charges.get(r.referenceNbr) ?? 0;
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>${esc(r.referenceNbr)}</td>
          <td>${claimantLink(r)}</td>
          <td class="${daysCls}">${esc(String(r.daysOpen))}</td>
          <td class="${missingCls}">${missingText}</td>
          <td>${esc(veeNote)}</td>
          <td style="text-align:right;">${esc(fmtCurrency(charge))}</td>`;
        tbody.appendChild(tr);
      }
      els.evResults.appendChild(table);
    }
  }

  function renderOpenClaimsFromPnl(cas, vee) {
    const rows = cas.openClaims ?? [];
    const veeByEvidence = indexVeeByEvidence(vee);
    els.evResults.appendChild(
      sectionHeader(`Other open claims at store — ${rows.length} (from PNL)`, "")
    );
    if (rows.length === 0) {
      const none = document.createElement("div");
      none.className = "muted";
      none.textContent = "No additional open claims in PNL (or all open claims are already in the evidence reports above).";
      els.evResults.appendChild(none);
      return;
    }
    const table = document.createElement("table");
    table.className = "claims";
    table.innerHTML = `
      <thead><tr>
        <th>Ref #</th><th>Claimant</th><th>Category</th><th>Charges</th><th>Video transfer (VEE)</th><th>Latest PNL Month</th>
      </tr></thead><tbody></tbody>`;
    const tbody = table.querySelector("tbody");
    for (const r of rows) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${esc(r.referenceNbr)}</td>
        <td>${claimantLink(r)}</td>
        <td>${esc(r.category)}</td>
        <td style="text-align:right;">${esc(fmtCurrency(r.totalCharges))}</td>
        <td>${esc(veeStatusFor(veeByEvidence, r.referenceNbr))}</td>
        <td class="muted">${esc(r.pnlMonth)}</td>`;
      tbody.appendChild(tr);
    }
    els.evResults.appendChild(table);
  }

  function renderClosedPaidFromPnl(cas) {
    const rows = cas.closedPaidClaims ?? [];
    if (rows.length === 0) return;

    const total = rows.reduce((s, r) => s + (r.totalCharges || 0), 0);
    els.evResults.appendChild(
      sectionHeader(`Closed claims with charges (FY27) — ${rows.length}, ${fmtCurrency(total)} total paid`, "")
    );
    const table = document.createElement("table");
    table.className = "claims";
    table.innerHTML = `
      <thead><tr>
        <th>Ref #</th><th>Claimant</th><th>Category</th><th>Charges</th><th>Latest PNL Month</th>
      </tr></thead><tbody></tbody>`;
    const tbody = table.querySelector("tbody");
    const sorted = [...rows].sort((a, b) => (b.totalCharges || 0) - (a.totalCharges || 0));
    for (const r of sorted) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${esc(r.referenceNbr)}</td>
        <td>${claimantLink(r)}</td>
        <td>${esc(r.category)}</td>
        <td style="text-align:right;">${esc(fmtCurrency(r.totalCharges))}</td>
        <td class="muted">${esc(r.pnlMonth)}</td>`;
      tbody.appendChild(tr);
    }
    els.evResults.appendChild(table);
  }

  function renderClearSightSection(cs) {
    if (cs.placeholder && cs.reason === "endpoints-undocumented") return;

    els.evResults.appendChild(sectionHeader("ClearSight — open claims in STARS", ""));

    const note = document.createElement("div");
    note.className = cs.reason === "cookie-check-failed" ? "muted error" : "muted";
    note.textContent = cs.placeholder
      ? (cs.note || "ClearSight integration is a stub.")
      : `${cs.claims.length} claims pulled from ClearSight.`;
    els.evResults.appendChild(note);

    if (cs.reason === "no-session" && Array.isArray(cs.cookieNames)) {
      const diag = document.createElement("div");
      diag.className = "muted";
      diag.style.marginTop = "6px";
      diag.style.fontSize = "11px";
      diag.textContent = cs.cookieNames.length === 0
        ? "Diagnostic: no cookies set on riskonnectclearsight.com — login wasn't completed."
        : `Diagnostic: cookies on riskonnectclearsight.com → ${cs.cookieNames.join(", ")}`;
      els.evResults.appendChild(diag);
    }
  }

  // ── Shared helpers ────────────────────────────────────────────────
  function sectionHeader(text, cls) {
    const el = document.createElement("div");
    el.className = "section-title" + (cls ? ` section-title--${cls}` : "");
    el.textContent = text;
    return el;
  }

  function listMissing(row) {
    const out = [];
    if (row.customerStatement?.startsWith("No"))       out.push("Customer Statement");
    if (row.witnessStatement?.startsWith("No"))        out.push("Witness Statement");
    if (row.video?.startsWith("No"))                   out.push("Video");
    if (row.photos?.startsWith("No"))                  out.push("Photos");
    if (row.evidenceCollectionSheet?.startsWith("No")) out.push("Evidence Collection Sheet");
    return out;
  }

  function claimantLink(casRow, dbClaim) {
    const claimId = dbClaim?.["Claim Nbr"] || casRow.referenceNbr;
    const name = esc(casRow.claimant);
    if (!claimId) return name;
    return `<a href="#" class="claim-copy" data-ref="${esc(claimId)}" title="Open ${esc(claimId)} in ClearSight — finish with Ctrl+V Enter">${name}</a>`;
  }

  function daysClass(days, deadline) {
    if (days >= deadline)     return "deadline-late";
    if (days >= deadline - 3) return "deadline-warn";
    return "";
  }

  function indexVeeByEvidence(vee) {
    const m = new Map();
    if (!vee?.records) return m;
    for (const rec of vee.records) {
      const key = String(rec.evidenceId || "").trim();
      if (!key) continue;
      const existing = m.get(key);
      if (!existing) { m.set(key, rec); continue; }
      const a = String(existing.lastUpdatedTimestampUtc || "");
      const b = String(rec.lastUpdatedTimestampUtc || "");
      if (b.localeCompare(a) > 0) m.set(key, rec);
    }
    return m;
  }

  function veeStatusFor(map, refNbr) {
    const rec = map.get(String(refNbr));
    if (!rec) return "no VEE record";
    const status   = rec.currentStatus || "?";
    const who      = rec.userName ? ` — ${rec.userName}` : "";
    const when     = rec.lastUpdatedTimestampUtc ? `, ${fmtShortDate(rec.lastUpdatedTimestampUtc)}` : "";
    const attempts = (rec.numberAttempts && rec.numberAttempts > 1) ? ` (${rec.numberAttempts} attempts)` : "";
    return `${status}${who}${when}${attempts}`;
  }

  function veeUploadedFor(map, refNbr) {
    const rec = map.get(String(refNbr));
    return !!rec && rec.currentStatus === "Successful";
  }

  function fmtShortDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    const M  = d.getMonth() + 1;
    const D  = d.getDate();
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${M}/${D} ${hh}:${mm}`;
  }

  function fmtTime(iso) {
    if (!iso) return "";
    return new Date(iso).toLocaleString();
  }

  function fmtCurrency(n) {
    if (!Number.isFinite(n) || n === 0) return "—";
    return "$" + Math.round(n).toLocaleString("en-US");
  }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }
    )[c]);
  }

  // ── Pill helpers ─────────────────────────────────────────────────
  function setPill(which, cls, text) {
    const el = which === "cas" ? els.pillCas : which === "vee" ? els.pillVee : els.pillCs;
    el.className = "pill " + cls;
    el.textContent = text;
  }

  function setPillDb(which, cls, text) {
    const el = which === "cas" ? els.pillCasDb : els.pillDf;
    el.className = "pill " + cls;
    el.textContent = text;
  }

  function reportPill(which, settled, okFmt) {
    if (settled.status === "fulfilled") {
      setPill(which, "ok", okFmt(settled.value));
    } else {
      const msg = settled.reason?.message || String(settled.reason);
      setPill(which, "error", `${which.toUpperCase()}: ${msg.slice(0, 80)}`);
      console.warn(`[ClaimsBuddy] ${which} failed`, settled.reason);
    }
  }

  function reportClearSightPill(settled) {
    if (settled.status !== "fulfilled") {
      const msg = settled.reason?.message || String(settled.reason);
      setPill("clearsight", "error", `CLEARSIGHT: ${msg.slice(0, 80)}`);
      console.warn(`[ClaimsBuddy] clearsight failed`, settled.reason);
      return;
    }
    const d = settled.value;
    if (!d.placeholder) {
      setPill("clearsight", "ok", `ClearSight: ${d.claims.length} claims`);
      return;
    }
    switch (d.reason) {
      case "no-session":
        setPill("clearsight", "warn", "ClearSight: log in first");
        break;
      case "cookie-check-failed":
        setPill("clearsight", "error", "ClearSight: cookie check failed");
        break;
      case "endpoints-undocumented":
      default:
        setPill("clearsight", "ok", "ClearSight: stub");
        break;
    }
  }

  function reportPillDb(which, settled, okFmt) {
    if (settled.status === "fulfilled") {
      setPillDb(which, "ok", okFmt(settled.value));
    } else {
      const msg = settled.reason?.message || String(settled.reason);
      setPillDb(which, "error", `${which.toUpperCase()}: ${msg.slice(0, 80)}`);
      console.warn(`[ClaimsBuddy] ${which} failed`, settled.reason);
    }
  }

  function setStatus(text, cls = "") {
    els.status.textContent = text || "";
    els.status.className   = "muted " + cls;
  }

  // ── Cleanup ──────────────────────────────────────────────────────
  return async function unmount() {
    link.remove();
  };
}
