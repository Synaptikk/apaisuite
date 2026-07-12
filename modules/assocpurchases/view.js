// modules/assocpurchases/view.js

import { correlate } from "./lib/correlate.js";

export async function mount(host, container) {
  const htmlUrl = host.url("view.html");
  container.innerHTML = await fetch(htmlUrl).then(r => r.text());

  const $ = id => container.querySelector(`#${id}`);

  const storeInput   = $("ap-store");
  const startInput   = $("ap-start");
  const endInput     = $("ap-end");
  const runBtn       = $("ap-run-btn");
  const statusEl     = $("ap-status");
  const resultsEl    = $("ap-results");
  const errorEl      = $("ap-error");
  const summaryEl    = $("ap-summary");
  const mdCountEl    = $("ap-md-count");
  const mdWrapEl     = $("ap-md-table-wrap");
  const selfCountEl  = $("ap-self-count");
  const selfWrapEl   = $("ap-self-table-wrap");

  // Default date inputs to today.
  const today = new Date().toISOString().slice(0, 10);
  startInput.value = today;
  endInput.value   = today;

  function setStatus(msg) {
    statusEl.textContent = msg;
    statusEl.classList.remove("ap-hidden");
  }
  function clearStatus() { statusEl.classList.add("ap-hidden"); }
  function clearError()  { errorEl.classList.add("ap-hidden"); errorEl.textContent = ""; }
  function addError(msg) {
    errorEl.textContent = (errorEl.textContent ? errorEl.textContent + "\n" : "") + msg;
    errorEl.classList.remove("ap-hidden");
  }
  function chip(text, kind = "") {
    const el = document.createElement("span");
    el.className = `ap-chip${kind ? " ap-chip-" + kind : ""}`;
    el.textContent = text;
    return el;
  }

  // ── Markdown associates table ──────────────────────────────────────────────
  function buildMdTable(mumdData, resolvedNames) {
    const { headers, rows } = mumdData;
    if (!rows.length) {
      mdWrapEl.innerHTML = `<p class="ap-empty">No markdowns found for this store and date range.</p>`;
      return;
    }

    const ci = pat => headers.findIndex(h => new RegExp(pat, "i").test(h));
    const colWin  = (c => c !== -1 ? c : ci("user|associate"))(ci("^user.?id$|^win$"));
    const colItem = (c => c !== -1 ? c : ci("item|upc"))(ci("^upc.?nbr$|^item.?desc"));
    const colAmt  = ci("^net.?mumd|amount|diff");
    const colDate = ci("^date.?posted$|date");

    const byWin = new Map();
    for (const row of rows) {
      const win = (colWin !== -1 ? row[colWin] ?? "" : "").trim().toLowerCase();
      if (!byWin.has(win)) byWin.set(win, []);
      byWin.get(win).push(row);
    }

    const tbl = document.createElement("table");
    tbl.className = "ap-table";
    tbl.innerHTML = `<thead><tr>
      <th>Associate</th><th>WIN</th><th>Markdowns</th>
      <th>Items (sample)</th><th>Net MD Amt</th><th>Dates</th>
    </tr></thead>`;
    const tbody = document.createElement("tbody");
    const sorted = [...byWin.entries()].sort((a, b) => b[1].length - a[1].length);
    for (const [win, mdRows] of sorted) {
      const name  = resolvedNames.get(win) ?? win ?? "—";
      const items = colItem !== -1
        ? [...new Set(mdRows.map(r => r[colItem]).filter(Boolean))].slice(0, 3).join(", ")
        : "—";
      const amt   = colAmt !== -1
        ? mdRows.reduce((s, r) => s + (parseFloat(r[colAmt]) || 0), 0).toFixed(2)
        : null;
      const dates = colDate !== -1
        ? [...new Set(mdRows.map(r => r[colDate]).filter(Boolean))].slice(0, 3).join(", ")
        : "—";

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="ap-name">${host.ui.escapeHtml(name)}</td>
        <td class="ap-win">${host.ui.escapeHtml(win)}</td>
        <td class="ap-count">${mdRows.length}</td>
        <td>${host.ui.escapeHtml(items || "—")}</td>
        <td class="ap-amount">${amt ? "$" + amt : "—"}</td>
        <td class="ap-muted">${host.ui.escapeHtml(dates)}</td>
      `;
      tbody.appendChild(tr);
    }
    tbl.appendChild(tbody);
    mdWrapEl.innerHTML = "";
    mdWrapEl.appendChild(tbl);
  }

  // ── Self-purchase table ────────────────────────────────────────────────────
  function buildSelfTable(selfPurchases) {
    if (!selfPurchases.length) {
      selfWrapEl.innerHTML = `<p class="ap-empty">No self-purchase matches.<br>
        <small class="ap-muted">APPRISS sweep returned 0 cardholders — Phase 2 will add per-associate card lookup.</small>
      </p>`;
      return;
    }
    const tbl = document.createElement("table");
    tbl.className = "ap-table";
    tbl.innerHTML = `<thead><tr>
      <th>Associate</th><th>WIN</th><th>Markdowns</th>
      <th>Items marked</th><th>MD amount</th><th>APPRISS txns</th><th>Purchase total</th>
    </tr></thead>`;
    const tbody = document.createElement("tbody");
    for (const sp of selfPurchases) {
      const tr = document.createElement("tr");
      tr.className = "ap-row-alert";
      tr.innerHTML = `
        <td class="ap-name">${host.ui.escapeHtml(sp.resolvedName)}</td>
        <td class="ap-win">${host.ui.escapeHtml(sp.win)}</td>
        <td class="ap-count">${sp.markdownCount}</td>
        <td>${host.ui.escapeHtml(sp.markdownItems.slice(0, 5).join(", ") || "—")}</td>
        <td class="ap-amount">${sp.markdownAmount ? "$" + sp.markdownAmount : "—"}</td>
        <td class="ap-count">${host.ui.escapeHtml(String(sp.appriss.txnCount || "—"))}</td>
        <td class="ap-amount">${sp.appriss.totalAmount ? "$" + sp.appriss.totalAmount : "—"}</td>
      `;
      tbody.appendChild(tr);
    }
    tbl.appendChild(tbody);
    selfWrapEl.innerHTML = "";
    selfWrapEl.appendChild(tbl);
  }

  async function runInvestigation() {
    clearError();
    resultsEl.classList.add("ap-hidden");
    summaryEl.innerHTML = "";
    runBtn.disabled = true;

    const storeNo   = storeInput.value.trim() || "1458";
    const startDate = startInput.value || today;
    const endDate   = endInput.value   || today;

    let mumdData    = { headers: [], rows: [] };
    let apprissRows = [];
    let resolvedNames = new Map();

    try {
      // Step 1 — Pull MUMD data via background tab + direct API call.
      setStatus("Step 1 of 3 — Opening MUMD report in background…");
      const mumdResult = await host.messaging.send("assocpurchases.pullMarkdowns", { storeNo, startDate, endDate });

      if (mumdResult.error && !mumdResult.rows?.length) {
        addError(mumdResult.error);
        clearStatus();
        runBtn.disabled = false;
        return;
      }
      if (mumdResult.warning) addError(mumdResult.warning);
      mumdData = { headers: mumdResult.headers ?? [], rows: mumdResult.rows ?? [] };

      // Show filter context if available
      const filterInfo = [
        ...(mumdResult.filterText ?? []),
        mumdResult.ageMinutes != null ? `captured ${mumdResult.ageMinutes}m ago` : "",
      ].filter(Boolean).join(" · ");
      if (filterInfo) setStatus(`MUMD: ${filterInfo}`);

      // Step 2 — APPRISS sweep
      setStatus(`Step 2 of 3 — Querying APPRISS discount-card purchases for store ${storeNo}…`);
      const apprissResult = await host.messaging.send("assocpurchases.pullAppriss", { storeNo });
      if (apprissResult.error) addError(`APPRISS: ${apprissResult.error}`);
      apprissRows = apprissResult.rows ?? [];

      // Step 3 — Resolve WINs via Workvivo
      let winIdx = mumdData.headers.findIndex(h => /^user.?id$|^win$/i.test(h.trim()));
      if (winIdx === -1) winIdx = mumdData.headers.findIndex(h => /user|associate/i.test(h));
      const wins = winIdx !== -1
        ? [...new Set(mumdData.rows.map(r => r[winIdx]).filter(Boolean).map(w => w.toLowerCase()))]
        : [];

      setStatus(`Step 3 of 3 — Resolving ${wins.length} associate name(s) via Workvivo…`);
      if (wins.length) {
        const res = await host.messaging.send("assocpurchases.resolveNames", { wins });
        for (const [win, name] of Object.entries(res.names ?? {})) {
          resolvedNames.set(win, name);
        }
      }

      clearStatus();
      const corr = correlate(mumdData, apprissRows, resolvedNames);

      const assocCount = new Set(
        winIdx !== -1 ? mumdData.rows.map(r => r[winIdx]).filter(Boolean) : []
      ).size;

      summaryEl.innerHTML = "";
      summaryEl.appendChild(chip(`${mumdData.rows.length} markdown events`));
      summaryEl.appendChild(chip(`${assocCount} associate${assocCount !== 1 ? "s" : ""}`));
      summaryEl.appendChild(chip(`${apprissRows.length} APPRISS cardholders`));
      summaryEl.appendChild(chip(
        `${corr.selfPurchases.length} self-purchase match${corr.selfPurchases.length !== 1 ? "es" : ""}`,
        corr.selfPurchases.length ? "alert" : ""
      ));

      mdCountEl.textContent   = String(assocCount);
      selfCountEl.textContent = String(corr.selfPurchases.length);
      if (!corr.selfPurchases.length) selfCountEl.classList.add("ap-badge-zero");

      buildMdTable(mumdData, resolvedNames);
      buildSelfTable(corr.selfPurchases);

      resultsEl.classList.remove("ap-hidden");

    } catch (e) {
      clearStatus();
      addError(e?.message ?? String(e));
      if (mumdData.rows.length) {
        buildMdTable(mumdData, resolvedNames);
        resultsEl.classList.remove("ap-hidden");
      }
    } finally {
      runBtn.disabled = false;
    }
  }

  runBtn.addEventListener("click", runInvestigation);
  return () => {
    runBtn.removeEventListener("click", runInvestigation);
  };
}
