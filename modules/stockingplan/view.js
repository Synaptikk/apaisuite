// modules/stockingplan/view.js

import * as Compute from "./lib/compute.js";
import { toPlaintext, toPrintHtml } from "./lib/render.js";
import { SSO_SELECTORS } from "../../shared/auth.js";

const CV_URL     = "https://radapps3.wal-mart.com/Protected/CaseVisibility/html/main.html";
const CV_MATCH   = /^https:\/\/radapps3\.wal-mart\.com\/Protected\/CaseVisibility\//;

const DEFAULTS = {
  storeNbr:  "",
  startHour: 22,
};

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

  // Load saved prefs.
  const stored = await host.storage.sync.get();
  $("sp-storeNbr").value     = stored.storeNbr  ?? DEFAULTS.storeNbr;
  $("sp-businessDate").value = todayIso();
  $("sp-recipient") && ($("sp-recipient").value = "");   // field removed — no-op guard
  $("sp-startHour").value    = stored.startHour  ?? DEFAULTS.startHour;

  async function savePrefs() {
    await host.storage.sync.set({
      storeNbr:  $("sp-storeNbr").value.trim() || DEFAULTS.storeNbr,
      startHour: Number($("sp-startHour").value) || DEFAULTS.startHour,
    });
  }

  // State managed in this closure.
  let plan        = null;   // Compute.buildPlan output
  let assignments = new Map(); // rowKey → string[]

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
    const $btn = $("sp-collect");
    $btn.disabled = true;
    assignments = new Map();

    let cvTabId   = null;
    let cvOpened  = false;

    try {
      await savePrefs();
      const storeNbr    = $("sp-storeNbr").value.trim()    || DEFAULTS.storeNbr;
      const businessDate = $("sp-businessDate").value      || todayIso();
      const startHour   = Number($("sp-startHour").value)  || DEFAULTS.startHour;
      console.log("[stockingplan] onCollect start", { storeNbr, businessDate });

      setStatus("Finding CaseVisibility tab…");
      const { tab, opened } = await openCvTab();
      console.log("[stockingplan] CV tab:", tab.id, tab.url, "opened:", opened);
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
        { storeNbr, businessDate, startHour }
      );

      renderAssociates();
      renderPlanTable();

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
      if (cvOpened && cvTabId) host.tabs.remove(cvTabId).catch(() => {});
      $btn.disabled = false;
    }
  }

  // --- Render associates ---------------------------------------------------

  function renderAssociates() {
    const list = $("sp-assoc-list");
    list.innerHTML = "";
    $("sp-assoc-count").textContent = `(${plan.associates.length})`;

    const sorted = [...plan.associates].sort((a, b) => a.name.localeCompare(b.name));
    for (const a of sorted) {
      const item = document.createElement("div");
      item.className = "sp-name-item" + (a.calledOut ? " sp-callout" : "");
      item.textContent = a.name + (a.calledOut ? " ✗" : "");
      list.appendChild(item);
    }
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
        <th class="sp-th-num">BPs</th>
        <th class="sp-th-num">Hours</th>
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
      hdr.innerHTML = `<td colspan="5">${esc(secLabel)} <span class='sp-tag fc'>F&amp;C</span> — by aisle</td>`;
      tbody.appendChild(hdr);

      for (const pair of sec.pairs) {
        const key = `aisle:${sec.deptNbr}:${pair.label}`;
        const tr  = makeRow(key, `Aisle ${esc(pair.label)}`, pair.totalCases, pair.totalBps, pair.hours, true);
        tbody.appendChild(tr);
      }
    }

    if (plan.deptTasks.length === 0 && plan.aisleSections.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="muted">No freight rows found. The freight data shape may be unrecognised — check the browser console.</td></tr>`;
    }
  }

  // Build a single plan table row with an assignment input.
  function makeRow(key, labelHtml, cases, bps, hours, indented) {
    const tr = document.createElement("tr");
    tr.className = "sp-plan-row" + (indented ? " sp-aisle-row" : "");
    tr.dataset.rowKey = key;

    const assignedNames = assignments.get(key) || [];

    tr.innerHTML = `
      <td class="sp-td-dept">${labelHtml}</td>
      <td class="sp-td-num">${cases}</td>
      <td class="sp-td-num">${bps}</td>
      <td class="sp-td-num sp-hrs">${hours}h</td>
      <td class="sp-td-assign">
        <div class="sp-chips" data-key="${esc(key)}"></div>
        <div class="sp-autocomplete-wrap">
          <input type="text" class="sp-assign-input" placeholder="assign…" data-key="${esc(key)}" autocomplete="off">
          <ul class="sp-dropdown" hidden></ul>
        </div>
      </td>`;

    // Render existing chips.
    const chipsEl = tr.querySelector(".sp-chips");
    for (const name of assignedNames) addChip(chipsEl, key, name);

    // Wire up the type-to-filter input.
    const input    = tr.querySelector(".sp-assign-input");
    const dropdown = tr.querySelector(".sp-dropdown");

    input.addEventListener("input", () => {
      const q = input.value.trim().toLowerCase();
      if (!q) { dropdown.hidden = true; return; }
      const matches = plan.associates
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
    const current = assignments.get(key) || [];
    if (!current.includes(name)) {
      current.push(name);
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
      const arr = (assignments.get(key) || []).filter((n) => n !== name);
      assignments.set(key, arr);
      chip.remove();
    });
    chipsEl.appendChild(chip);
  }

  // --- Output actions ------------------------------------------------------

  function onPrint() {
    if (!plan) { setStatus("Generate the plan first.", "error"); return; }
    const html = toPrintHtml(plan, assignments);
    const blob = new Blob([html], { type: "text/html" });
    const url  = URL.createObjectURL(blob);
    host.tabs.create({ url });
    // Blob URL is tied to the extension page; Chrome will clean it up when the tab closes.
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
    const storeNbr = $("sp-storeNbr").value.trim() || DEFAULTS.storeNbr;
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
