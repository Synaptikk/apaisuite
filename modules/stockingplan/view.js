// modules/stockingplan/view.js

import * as Compute from "./lib/compute.js";
import { toPlaintext, toPrintHtml } from "./lib/render.js";
import { SSO_SELECTORS } from "../../shared/auth.js";
import { getUserHomeStore } from "../../shared/userStore.js";

const CV_URL     = "https://radapps3.wal-mart.com/Protected/CaseVisibility/html/main.html";
const CV_MATCH   = /^https:\/\/radapps3\.wal-mart\.com\/Protected\/CaseVisibility\//;

const DEFAULTS = {
  storeNbr:  "",
};

// A valid store is 1–5 digits. Empty / non-numeric input must NOT silently
// fall through to the data source, which defaults to store "1" (no data) and
// produces a blank report. Returns the trimmed store or "" if invalid.
function validStoreNbr(raw) {
  const v = String(raw ?? "").trim();
  return /^\d{1,5}$/.test(v) ? v : "";
}

export async function mount(host, container) {
  // Inject stylesheet.
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = host.url("styles.css");
  link.dataset.module = host.id;
  document.head.appendChild(link);

  // Load markup.
  try {
    const resp = await fetch(host.url("view.html"));
    container.innerHTML = await resp.text();
  } catch (e) {
    container.innerHTML = `<div class="state-error">Failed to load StockingPlan view: ${String(e?.message ?? e)}</div>`;
    return () => { link.remove(); };
  }

  const $ = (id) => container.querySelector("#" + id);

  // Load saved prefs. Shell home-store default wins if set; otherwise use
  // the module's own persisted value.
  const stored = await host.storage.sync.get();
  $("sp-storeNbr").value     = (await getUserHomeStore()) || stored.storeNbr || DEFAULTS.storeNbr;
  $("sp-businessDate").value = todayIso();

  async function savePrefs() {
    await host.storage.sync.set({
      storeNbr:  $("sp-storeNbr").value.trim() || DEFAULTS.storeNbr,
    });
  }

  // State managed in this closure.
  let plan        = null;   // Compute.buildPlan output
  // assignments: Map<rowKey, { shift: 'stock2'|'stock3'|null, names: string[] }>
  let assignments = new Map();

  // Status helper.
  const $status = $("sp-status");
  function setStatus(text, kind) {
    $status.textContent = text;
    $status.className = "status-strip" + (kind ? ` status-strip-${kind}` : "");
  }

  // --- CaseVisibility tab management ---------------------------------------
  // Returns the tab and whether WE opened it (vs. reusing an existing one).
  // Only tabs we open get closed after collection.

  async function openCvTab() {
    const existing = await host.tabs.query({ url: "https://radapps3.wal-mart.com/Protected/CaseVisibility/*" });
    if (existing.length) return { tab: existing[0], opened: false };

    setStatus("Opening CaseVisibility (background)…");
    const created = await host.tabs.create({ url: CV_URL, active: false });
    
    const loaded  = await host.tabs.waitForLoad(created.id, 30_000);
    if (!loaded) throw new Error("CaseVisibility tab load timed out.");

    let finalTab = await host.tabs.get(created.id);
    if (CV_MATCH.test(finalTab.url || "")) return { tab: finalTab, opened: true };

    setStatus("Signing in to CaseVisibility…");
    await host.auth.clickSso(created.id, SSO_SELECTORS);

    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      finalTab = await host.tabs.get(created.id).catch(() => null);
      if (!finalTab) throw new Error("CaseVisibility tab was closed during sign-in.");
      if (CV_MATCH.test(finalTab.url || "")) return { tab: finalTab, opened: true };
    }
    throw new Error(
      "Couldn't auto-sign in to CaseVisibility. Finish sign-in in the background tab, then click Collect again."
    );
  }

  // --- Collect -------------------------------------------------------------

  async function onCollect() {
    host.usage.record("collect");
    const $btn = $("sp-collect");
    $btn.disabled = true;
    assignments = new Map();

    let cvTabId   = null;
    let cvOpened  = false;

    try {
      await savePrefs();
      const storeNbr = validStoreNbr($("sp-storeNbr").value);
      if (!storeNbr) {
        setStatus("Enter a valid store number (1–5 digits) before collecting. Blank/invalid stores produce an empty report.", "error");
        $("sp-storeNbr").focus();
        return;
      }
      const businessDate = $("sp-businessDate").value      || todayIso();
      console.log("[stockingplan] onCollect start", { storeNbr, businessDate });

      setStatus("Finding CaseVisibility tab…");
      const { tab, opened } = await openCvTab();
      cvTabId  = tab.id;
      cvOpened = opened;

      setStatus("Loading schedule…");
      console.log("[stockingplan] sending collect-schedule to tab", tab.id);
      const _schedTimeout = new Promise((_, rej) =>
        setTimeout(() => rej(new Error("Schedule fetch timed out after 45s — CV page may still be loading")), 45_000)
      );
      const schedResp = await Promise.race([
        host.messaging.sendToTab(
          tab.id,
          "collect-schedule",
          { storeNbr, businessDate },
          { fallbackScripts: [{ file: `modules/${host.id}/content/casevisibility.js` }] }
        ),
        _schedTimeout,
      ]);
      if (!schedResp || !schedResp.ok) throw new Error(schedResp?.error || "Schedule fetch failed.");

      setStatus("Capturing freight data…");
      let freightResp = { ok: false, byDept: [], byAisle: [], error: null };
      try {
        // Pass the same tab so the SW doesn't open a second one.
        freightResp = await host.messaging.send("collect-freight", { storeNbr, businessDate, tabId: tab.id });
      } catch (e) {
        freightResp = { ok: false, byDept: [], byAisle: [], error: String(e?.message ?? e) };
      }

      plan = Compute.buildPlan(
        schedResp.data,
        { byDept: freightResp.byDept, byAisle: freightResp.byAisle },
        { storeNbr, businessDate }
      );

      renderAssociates();
      renderPlanTable();
      
      // Render truck details if available
      if (freightResp.trucks && freightResp.trucks.length > 0) {
        renderTrucks(freightResp.trucks);
        $("sp-trucks-panel").hidden = false;
      }

      $("sp-assoc-section").hidden = false;
      $("sp-plan-section").hidden  = false;
      $("sp-output-row").hidden    = false;

      const callOuts = plan.associates.filter((a) => a.calledOut).length;
      let msg = `Done. ${plan.associates.length} associates`;
      if (callOuts) msg += `, ${callOuts} call-out${callOuts !== 1 ? "s" : ""}`;
      if (!freightResp.ok) msg += ` — freight warning: ${freightResp.error || "partial data"}`;
      setStatus(msg, freightResp.ok ? "ok" : "");
    } catch (e) {
      setStatus(String(e?.message ?? e), "error");
    } finally {
      // Close the CV tab only if we opened it — don't touch a tab the user
      // already had open.
      if (cvOpened && cvTabId) {
        await host.tabs.remove(cvTabId).catch(() => {});
      }
      $btn.disabled = false;
    }
  }

  // --- Render trucks sidebar ----------------------------------------------

  function renderTrucks(trucks) {
    const list = $("sp-trucks-list");
    list.innerHTML = "";

    trucks.forEach(truck => {
      const card = document.createElement("div");
      card.className = "sp-truck-card";
      
      const typeClass = truck.type.toLowerCase().replace(/\s/g, '-');
      card.classList.add(`sp-truck-${typeClass}`);
      
      card.innerHTML = `
        <div class="sp-truck-header">
          <span class="sp-truck-type">${esc(truck.type)}</span>
          <span class="sp-truck-eta">${esc(truck.eta)}</span>
        </div>
        <div class="sp-truck-details">
          <div class="sp-truck-row">
            <span class="sp-truck-label">Trailer:</span>
            <span class="sp-truck-value">${esc(truck.trailer)}</span>
          </div>
          <div class="sp-truck-row">
            <span class="sp-truck-label">Load ID:</span>
            <button class="sp-truck-loadid" data-loadid="${esc(truck.loadId)}" title="Click to copy">
              ${esc(truck.loadId)}
              <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
                <path fill="currentColor" d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"/>
              </svg>
            </button>
          </div>
          <div class="sp-truck-row">
            <span class="sp-truck-label">Cases:</span>
            <span class="sp-truck-value">
              ${truck.grocCases > 0 ? `${truck.grocCases.toLocaleString()} Groc/Cons` : ''}
              ${truck.gmCases > 0 ? (truck.grocCases > 0 ? ' + ' : '') + `${truck.gmCases.toLocaleString()} GM` : ''}
              ${truck.bpCases > 0 ? (truck.grocCases > 0 || truck.gmCases > 0 ? ' + ' : '') + `${truck.bpCases.toLocaleString()} BP` : ''}
              = <strong>${truck.totalCases.toLocaleString()}</strong>
            </span>
          </div>
          ${truck.status ? `<div class="sp-truck-status">${esc(truck.status)}</div>` : ''}
        </div>
      `;
      
      // Add click-to-copy for Load ID
      const loadIdBtn = card.querySelector('.sp-truck-loadid');
      loadIdBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(truck.loadId);
          const originalText = loadIdBtn.innerHTML;
          loadIdBtn.innerHTML = '✓ Copied!';
          setTimeout(() => { loadIdBtn.innerHTML = originalText; }, 2000);
        } catch (e) {
          console.error('Failed to copy:', e);
        }
      });
      
      list.appendChild(card);
    });
  }

  // --- Render associates ---------------------------------------------------

  function renderAssociates() {
    const list = $("sp-assoc-list");
    list.innerHTML = "";
    $("sp-assoc-count").textContent = `(${plan.associates.length})`;

    // Group by role
    const groups = {
      stock2: { label: 'Stock 2 TA', associates: [] },
      stock3: { label: 'Overnight TA', associates: [] },
      modteam: { label: 'Overnight Mod Team', associates: [] },
      maintenance: { label: 'Overnight Maintenance', associates: [] },
      other: { label: 'Other', associates: [] },
    };

    plan.associates.forEach(a => {
      const role = a.role || 'other';
      if (groups[role]) groups[role].associates.push(a);
      else groups.other.associates.push(a);
    });

    // Render each group
    Object.entries(groups).forEach(([roleKey, group]) => {
      if (group.associates.length === 0) return;

      const header = document.createElement('div');
      header.className = 'sp-assoc-group-header';
      const callOuts = group.associates.filter(a => a.calledOut).length;
      header.textContent = `${group.label} (${group.associates.length}${callOuts ? `, ${callOuts} call-outs` : ''})`;
      list.appendChild(header);

      const sorted = [...group.associates].sort((a, b) => a.name.localeCompare(b.name));
      sorted.forEach(a => {
        const item = document.createElement("div");
        item.className = "sp-name-item" + (a.calledOut ? " sp-callout" : "");
        item.dataset.role = roleKey;
        item.textContent = a.name + (a.calledOut ? " ✗" : "");
        list.appendChild(item);
      });
    });
  }

  // --- Render plan table ---------------------------------------------------

  function renderPlanTable() {
    const body = $("sp-plan-body");
    body.innerHTML = "";

    if (!plan.freightCaptured) {
      body.innerHTML = `<p class="muted">Freight data not captured. Make sure the CaseVisibility freight page is loaded, then click Collect again.</p>`;
      return;
    }

    const table = document.createElement("table");
    table.className = "sp-table";
    table.innerHTML = `<thead>
      <tr>
        <th class="sp-th-dept">Dept / Aisle</th>
        <th class="sp-th-num">Cases</th>
        <th class="sp-th-num">Inner Packs</th>
        <th class="sp-th-num">Hours</th>
        <th class="sp-th-shift">Shift</th>
        <th class="sp-th-assign">Assigned</th>
      </tr>
    </thead>`;
    const tbody = document.createElement("tbody");
    table.appendChild(tbody);
    body.appendChild(table);

    // Dept-level rows.
    for (const t of plan.deptTasks) {
      const key = `dept:${t.key}`;
      const tr  = makeRow(key, t.label + (t.isFC ? " <span class='sp-tag fc'>F&amp;C</span>" : " <span class='sp-tag gm'>GM</span>"),
                          t.cases, t.breakpacks, t.hours, false);
      tbody.appendChild(tr);
    }

    // Aisle sections (food/cons by aisle).
    for (const sec of plan.aisleSections) {
      const hdr = document.createElement("tr");
      hdr.className = "sp-dept-header";
      const secLabel = sec.label || `Dept ${sec.deptNbr}`;
      hdr.innerHTML = `<td colspan="6">${esc(secLabel)} <span class='sp-tag fc'>F&amp;C</span> — by aisle</td>`;
      tbody.appendChild(hdr);

      for (const pair of sec.pairs) {
        const key = `aisle:${sec.deptNbr}:${pair.label}`;
        const tr  = makeRow(key, `Aisle ${esc(pair.label)}`, pair.totalCases, pair.totalBps, pair.hours, true);
        tbody.appendChild(tr);
      }
    }

    if (plan.deptTasks.length === 0 && plan.aisleSections.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" class="muted">No freight rows found. The freight data shape may be unrecognised — check the browser console.</td></tr>`;
    }
  }

  // Build a single plan table row with an assignment input.
  function makeRow(key, labelHtml, cases, bps, hours, indented) {
    const tr = document.createElement("tr");
    tr.className = "sp-plan-row" + (indented ? " sp-aisle-row" : "");
    tr.dataset.rowKey = key;

    const assignment = assignments.get(key) || { shift: null, names: [] };

    tr.innerHTML = `
      <td class="sp-td-dept">${labelHtml}</td>
      <td class="sp-td-num">${cases}</td>
      <td class="sp-td-num">${bps}</td>
      <td class="sp-td-num sp-hrs">${hours}h</td>
      <td class="sp-td-shift">
        <select class="sp-shift-select" data-key="${esc(key)}">
          <option value="">—</option>
          <option value="stock2">Stock 2</option>
          <option value="stock3">Stock 3</option>
        </select>
      </td>
      <td class="sp-td-assign">
        <div class="sp-chips" data-key="${esc(key)}"></div>
        <div class="sp-autocomplete-wrap">
          <input type="text" class="sp-assign-input" placeholder="assign…" data-key="${esc(key)}" autocomplete="off">
          <ul class="sp-dropdown" hidden></ul>
        </div>
      </td>`;

    // Set shift dropdown value
    const shiftSelect = tr.querySelector(".sp-shift-select");
    if (assignment.shift) shiftSelect.value = assignment.shift;

    // Wire shift select change
    shiftSelect.addEventListener("change", () => {
      const newShift = shiftSelect.value || null;
      const current = assignments.get(key) || { shift: null, names: [] };
      assignments.set(key, { shift: newShift, names: current.names });
    });

    // Render existing chips.
    const chipsEl = tr.querySelector(".sp-chips");
    for (const name of assignment.names) addChip(chipsEl, key, name);

    // Wire up the type-to-filter input.
    const input    = tr.querySelector(".sp-assign-input");
    const dropdown = tr.querySelector(".sp-dropdown");

    input.addEventListener("input", () => {
      const q = input.value.trim().toLowerCase();
      if (!q) { dropdown.hidden = true; return; }
      
      // Filter associates by selected shift if one is chosen
      const selectedShift = shiftSelect.value;
      let matches = plan.associates;
      
      if (selectedShift) {
        // For stock2, show stock2 associates
        // For stock3, show stock3 + modteam (they both work overnight freight)
        matches = matches.filter(a => {
          if (selectedShift === 'stock2') return a.role === 'stock2';
          if (selectedShift === 'stock3') return a.role === 'stock3' || a.role === 'modteam';
          return true;
        });
      }
      
      matches = matches
        .filter((a) => a.name.toLowerCase().includes(q))
        .slice(0, 8);
      
      if (!matches.length) { dropdown.hidden = true; return; }
      dropdown.innerHTML = matches
        .map((a) => `<li class="sp-dd-item${a.calledOut ? " sp-dd-callout" : ""}" data-name="${esc(a.name)}">${esc(a.name)}</li>`)
        .join("");
      dropdown.hidden = false;
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const first = dropdown.querySelector(".sp-dd-item");
        if (first) selectAssociate(key, first.dataset.name, input, dropdown, chipsEl);
      }
      if (e.key === "Escape") { dropdown.hidden = true; input.value = ""; }
    });

    dropdown.addEventListener("mousedown", (e) => {
      const li = e.target.closest(".sp-dd-item");
      if (!li) return;
      e.preventDefault();
      selectAssociate(key, li.dataset.name, input, dropdown, chipsEl);
    });

    // Close dropdown when focus leaves the row.
    input.addEventListener("blur", () => { setTimeout(() => { dropdown.hidden = true; }, 150); });

    return tr;
  }

  function selectAssociate(key, name, input, dropdown, chipsEl) {
    const current = assignments.get(key) || { shift: null, names: [] };
    if (!current.names.includes(name)) {
      current.names.push(name);
      assignments.set(key, current);
      addChip(chipsEl, key, name);
    }
    input.value    = "";
    dropdown.hidden = true;
  }

  function addChip(chipsEl, key, name) {
    const chip = document.createElement("span");
    chip.className = "sp-chip";
    chip.dataset.name = name;
    chip.innerHTML = `${esc(name)} <button class="sp-chip-remove" aria-label="Remove ${esc(name)}" title="Remove">×</button>`;
    chip.querySelector(".sp-chip-remove").addEventListener("click", () => {
      const current = assignments.get(key) || { shift: null, names: [] };
      current.names = current.names.filter((n) => n !== name);
      assignments.set(key, current);
      chip.remove();
    });
    chipsEl.appendChild(chip);
  }

  // --- Output actions ------------------------------------------------------

  function onPrint() {
    if (!plan) { setStatus("Generate the plan first.", "error"); return; }
    const html = toPrintHtml(plan, assignments);
    // This used to write the html to a blob: URL and open it with tabs.create,
    // relying on an inline `window.onload = () => window.print()` inside the
    // markup. A blob opened from an extension page inherits this page's CSP
    // (MV3 default: script-src 'self'), so that script was blocked and the
    // print dialog never opened — and tabs.create hands back no window handle
    // to print from either. Opening it ourselves gives us the handle.
    // Same fix as sparkfraud/view.js and vizpick/lib/card_report.js.
    const w = window.open("", "_blank", "width=900,height=700");
    if (!w) { setStatus("Allow pop-ups for this page to print the plan.", "error"); return; }
    w.document.open();
    w.document.write(html);
    w.document.close();
    setTimeout(() => { try { w.focus(); w.print(); } catch { /* user closed it */ } }, 350);
  }

  async function onCopy() {
    if (!plan) { setStatus("Generate the plan first.", "error"); return; }
    const text = toPlaintext(plan, assignments);
    try {
      await navigator.clipboard.writeText(text);
      setStatus("Copied to clipboard.", "ok");
    } catch (e) {
      setStatus("Copy failed: " + (e?.message ?? e), "error");
    }
  }

  function onOpenOutlook() {
    if (!plan) { setStatus("Generate the plan first.", "error"); return; }
    const text     = toPlaintext(plan, assignments);
    const storeNbr = validStoreNbr($("sp-storeNbr").value) || plan.storeNbr;
    const date     = $("sp-businessDate").value || todayIso();
    const subject  = `Stocking Plan — Store ${storeNbr} — ${date}`;
    const url =
      `https://outlook.office.com/mail/deeplink/compose` +
      `?subject=${encodeURIComponent(subject)}` +
      `&body=${encodeURIComponent(text)}`;
    if (url.length > 8000) {
      setStatus("Body too long for URL deeplink — use Copy and paste into a new Outlook draft.", "error");
      return;
    }
    host.tabs.create({ url });
  }

  // Wire listeners.
  $("sp-collect").addEventListener("click", onCollect);
  $("sp-print").addEventListener("click", onPrint);
  $("sp-copy").addEventListener("click", onCopy);
  $("sp-openOutlook").addEventListener("click", onOpenOutlook);

  return async () => {
    link.remove();
  };
}

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
