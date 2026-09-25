// modules/stockingplan/view.js

import * as Compute from "./lib/compute.js";
import { verdictLine } from "./lib/shifts.js";
import { toPlaintext, toPrintHtml, toSuggestionText } from "./lib/render.js";
import { suggestPlan, suggestionAssignments } from "./lib/suggest.js";
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
  // assignments: Map<rowKey, { shift: 'stock2'|'stock3'|'stock1'|null, names: string[] }>
  let assignments = new Map();
  let level       = "area"; // area | dept | aisle
  // While a suggestion is showing, the output buttons emit IT rather than the
  // table — the draft is the thing the user came for.
  let suggestion  = null;

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
    try {

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
      "Couldn't auto-sign in to CaseVisibility. Open CaseVisibility, sign in, then click Collect again."
    );
    } catch (error) {
      await host.tabs.remove(created.id).catch(() => {});
      throw error;
    }
  }

  // One schedule pull. Used twice: the business date, then the morning after.
  async function fetchSchedule(tabId, storeNbr, businessDate, label) {
    const timeout = new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`${label} schedule fetch timed out after 45s — CV page may still be loading`)), 45_000)
    );
    const resp = await Promise.race([
      host.messaging.sendToTab(
        tabId,
        "collect-schedule",
        { storeNbr, businessDate },
        { fallbackScripts: [{ file: `modules/${host.id}/content/casevisibility.js` }] }
      ),
      timeout,
    ]);
    if (!resp || !resp.ok) throw new Error(resp?.error || `${label} schedule fetch failed.`);
    return resp.data;
  }

  // --- Collect -------------------------------------------------------------

  async function onCollect() {
    host.usage.record("collect");
    const $btn = $("sp-collect");
    $btn.disabled = true;
    assignments = new Map();
    suggestion  = null;
    $("sp-suggest-section").hidden = true;

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
      const businessDate = $("sp-businessDate").value || todayIso();
      const nextDate     = Compute.nextIsoDate(businessDate);

      setStatus("Finding CaseVisibility tab…");
      const { tab, opened } = await openCvTab();
      cvTabId  = tab.id;
      cvOpened = opened;

      setStatus("Loading tonight's schedule…");
      const schedJson = await fetchSchedule(tab.id, storeNbr, businessDate, "Tonight's");

      // The morning crew that inherits whatever the night can't finish. A
      // failure here is not fatal — the plan still renders without it.
      setStatus("Loading tomorrow's schedule…");
      let nextJson = null;
      let nextErr  = null;
      try {
        nextJson = await fetchSchedule(tab.id, storeNbr, nextDate, "Tomorrow's");
      } catch (e) {
        nextErr = String(e?.message ?? e);
      }

      setStatus("Capturing freight data…");
      let freightResp = { ok: false, areas: [], depts: [], areaTimes: [], aisles: [], error: null };
      try {
        // Pass the same tab so the SW doesn't open a second one.
        freightResp = await host.messaging.send("collect-freight", { storeNbr, businessDate, tabId: tab.id });
      } catch (e) {
        freightResp = { ok: false, areas: [], depts: [], areaTimes: [], aisles: [], error: String(e?.message ?? e) };
      }

      plan = Compute.buildPlan(
        schedJson,
        freightResp,
        { storeNbr, businessDate, nextScheduleJson: nextJson },
      );

      renderLabour();
      renderTrucks();
      renderAssociates();
      renderPlanTable();

      $("sp-labour-section").hidden = false;
      $("sp-assoc-section").hidden  = false;
      $("sp-plan-section").hidden   = false;
      $("sp-output-row").hidden     = false;
      $("sp-trucks-panel").hidden   = plan.trucks.length === 0;

      const callOuts = plan.associates.filter((a) => a.calledOut).length;
      let msg = `Done. ${plan.associates.length} on the stocking shifts`;
      if (callOuts) msg += `, ${callOuts} call-out${callOuts !== 1 ? "s" : ""}`;
      if (!plan.deptTasks.length) msg += " — department breakdown missing (allow pop-ups for CaseVisibility)";
      if (nextErr) msg += ` — next-day schedule unavailable: ${nextErr}`;
      if (!freightResp.ok) msg += ` — freight warning: ${freightResp.error || "partial data"}`;
      setStatus(msg, freightResp.ok && plan.deptTasks.length ? "ok" : "");
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

  // --- Render labour -------------------------------------------------------

  function renderLabour() {
    const cap = plan.capacity;
    $("sp-labour-dates").textContent =
      `${plan.dateLabel} tonight → ${plan.nextDateLabel} morning`;

    const v = $("sp-verdict");
    v.className = `sp-verdict sp-verdict-${cap.verdict}`;
    v.textContent = verdictLine(cap);

    const grid = $("sp-labour-grid");
    grid.innerHTML = "";

    const cells = [
      tile("Stock 2", cap.stock2Hours, cap.stock2Count, "tonight"),
      tile("Overnight", cap.stock3Hours, cap.stock3Count, "tonight"),
      tile("Mod Team", cap.modCount ? cap.modHours : null, cap.modCount || null, "tonight", cap.modCount ? null : "none tonight"),
      tile("Freight required", plan.requiredHours, null, "freight",
           plan.requiredBasis === "cv" ? "CaseVisibility estimate" : "our case rates"),
      tile("Stock 1 tomorrow", cap.nextStock1Hours, cap.nextStock1Count, "tomorrow",
           cap.nextStock1Hours == null ? "not pulled" : null),
    ];
    for (const c of cells) grid.appendChild(c);

    // Next-day salesfloor teams, offered only when tonight can't absorb the
    // freight on its own.
    const backup = $("sp-backup");
    if (cap.backup.length) {
      backup.hidden = false;
      backup.innerHTML = `
        <div class="sp-backup-head">
          Tomorrow's salesfloor teams — the hours to lean on for what's left at 7am
        </div>
        <table class="sp-backup-table">
          <thead><tr><th>Job group</th><th>Covers</th><th class="sp-th-num">Assoc</th><th class="sp-th-num">Hours</th><th>Starts</th></tr></thead>
          <tbody>
            ${cap.backup.map((b) => `<tr>
              <td>${esc(b.job)}</td>
              <td class="muted tiny">${esc(b.area || "—")}</td>
              <td class="sp-td-num">${b.count}</td>
              <td class="sp-td-num sp-hrs">${b.hours}h</td>
              <td class="tiny">${b.starts.map((h) => hourLabel(h)).join(", ")}</td>
            </tr>`).join("")}
          </tbody>
        </table>`;
    } else {
      backup.hidden = true;
      backup.innerHTML = "";
    }
  }

  function tile(label, hours, count, kind, note) {
    const el = document.createElement("div");
    el.className = `sp-tile sp-tile-${kind}`;
    const hrs = hours == null ? "—" : `${hours}h`;
    el.innerHTML = `
      <div class="sp-tile-label">${esc(label)}</div>
      <div class="sp-tile-value">${esc(hrs)}</div>
      <div class="sp-tile-note muted tiny">${count != null ? `${count} scheduled` : ""}${note ? (count != null ? " · " : "") + esc(note) : ""}</div>`;
    return el;
  }

  function hourLabel(h) {
    const ampm = h >= 12 ? "p" : "a";
    return `${h % 12 || 12}${ampm}`;
  }

  // --- Render trucks -------------------------------------------------------

  function renderTrucks() {
    const list = $("sp-trucks-list");
    list.innerHTML = "";
    $("sp-trucks-count").textContent =
      `(${plan.trucks.length} · ${plan.trucks.reduce((s, t) => s + t.totalCases, 0).toLocaleString()} cases)`;

    for (const truck of plan.trucks) {
      const card = document.createElement("div");
      card.className = "sp-truck-card sp-truck-" + String(truck.type).toLowerCase().replace(/\W+/g, "-");

      const parts = [];
      if (truck.grocCases) parts.push(`${truck.grocCases.toLocaleString()} Groc/Cons`);
      if (truck.gmCases)   parts.push(`${truck.gmCases.toLocaleString()} GM`);
      if (truck.bpCases)   parts.push(`${truck.bpCases.toLocaleString()} BP`);

      card.innerHTML = `
        <div class="sp-truck-header">
          <span class="sp-truck-type">${esc(truck.type)}</span>
          <span class="sp-truck-eta">${esc(formatEta(truck.eta))}</span>
        </div>
        <div class="sp-truck-details">
          <div class="sp-truck-row">
            <span class="sp-truck-label">Trailer</span>
            <span class="sp-truck-value">${esc(truck.trailer || "—")}</span>
          </div>
          <div class="sp-truck-row">
            <span class="sp-truck-label">Load ID</span>
            <button class="sp-truck-loadid" data-loadid="${esc(truck.loadId)}" title="Click to copy">${esc(truck.loadId || "—")}</button>
          </div>
          <div class="sp-truck-row">
            <span class="sp-truck-label">Cases</span>
            <span class="sp-truck-value">${esc(parts.join(" + "))}${parts.length > 1 ? ` = <strong>${truck.totalCases.toLocaleString()}</strong>` : ""}</span>
          </div>
        </div>
        <div class="sp-truck-status ${truck.arrived ? "is-arrived" : ""}">${esc(truck.status)}</div>`;

      const btn = card.querySelector(".sp-truck-loadid");
      btn.addEventListener("click", async () => {
        if (!truck.loadId) return;
        try {
          await navigator.clipboard.writeText(truck.loadId);
          const was = btn.textContent;
          btn.textContent = "✓ copied";
          setTimeout(() => { btn.textContent = was; }, 1500);
        } catch { /* clipboard denied — nothing useful to do */ }
      });

      list.appendChild(card);
    }
  }

  function formatEta(ts) {
    const d = Compute.parseTimestamp(ts);
    if (!d) return ts || "—";
    return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${Compute.formatTime12h(d)}`;
  }

  // --- Render associates ---------------------------------------------------

  function renderAssociates() {
    const list = $("sp-assoc-list");
    list.innerHTML = "";
    $("sp-assoc-count").textContent = `(${plan.associates.length})`;

    for (const key of ["stock2", "stock3", "modteam", "maintenance"]) {
      const g = plan.shifts[key];
      if (!g || !g.members.length) continue;

      const header = document.createElement("div");
      header.className = "sp-assoc-group-header";
      header.textContent =
        `${g.label} — ${g.count} scheduled, ${g.workingHours}h` +
        (g.calledOut ? `, ${g.calledOut} call-out${g.calledOut !== 1 ? "s" : ""}` : "");
      list.appendChild(header);

      const wrap = document.createElement("div");
      wrap.className = "sp-assoc-names";
      for (const m of [...g.members].sort((a, b) => a.name.localeCompare(b.name))) {
        const item = document.createElement("div");
        item.className = "sp-name-item" + (m.calledOut ? " sp-callout" : "") + (m.rank !== "assoc" ? " sp-name-lead" : "");
        item.dataset.role = key;
        item.title = `${m.jobDesc} · ${Compute.formatShiftRange(m.start, m.end)} · ${m.hours}h`;
        item.textContent = m.name + (m.calledOut ? " ✗" : "") + (m.rank !== "assoc" ? ` (${m.rank})` : "");
        wrap.appendChild(item);
      }
      list.appendChild(wrap);
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
        <th class="sp-th-dept">Area / Dept / Aisle</th>
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

    if (level === "aisle") {
      renderAisles(tbody);
    } else {
      for (const area of plan.areaSections) {
        const key = `area:${area.name}`;
        tbody.appendChild(makeRow(key, `<strong>${esc(area.name)}</strong> ${tagFor(area.isFC)}`,
                                  area.cases, area.breakpacks, area.hours,
                                  { indent: 0, defaultShift: area.defaultShift }));
        if (level === "dept") {
          for (const d of area.depts) {
            tbody.appendChild(makeRow(`dept:${d.key}`, esc(d.label),
                                      d.cases, d.breakpacks, d.hours,
                                      { indent: 1, defaultShift: d.defaultShift }));
          }
        }
      }
      if (!plan.areaSections.length) {
        tbody.innerHTML = `<tr><td colspan="6" class="muted">No freight rows found — check the browser console.</td></tr>`;
      } else if (level === "dept" && !plan.deptTasks.length) {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td colspan="6" class="muted tiny">Department detail unavailable — casesByDept.html didn't open. Allow pop-ups for radapps3.wal-mart.com and collect again.</td>`;
        tbody.appendChild(tr);
      }
    }

    // Footer: the store total, stated once so it's clear the levels don't add up
    // on top of each other.
    const tfoot = document.createElement("tfoot");
    tfoot.innerHTML = `<tr class="sp-total-row">
      <td>Store total</td>
      <td class="sp-td-num">${plan.areaSections.reduce((s, a) => s + a.cases, 0).toLocaleString()}</td>
      <td class="sp-td-num">${plan.areaSections.reduce((s, a) => s + a.breakpacks, 0).toLocaleString()}</td>
      <td class="sp-td-num sp-hrs">${plan.requiredHours}h</td>
      <td colspan="2"></td>
    </tr>`;
    table.appendChild(tfoot);
  }

  function renderAisles(tbody) {
    if (!plan.aisleSections.length) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="6" class="muted tiny">Aisle detail unavailable — casesByAisle.html didn't open. Allow pop-ups for radapps3.wal-mart.com and collect again.</td>`;
      tbody.appendChild(tr);
      return;
    }
    for (const sec of plan.aisleSections) {
      const hdr = document.createElement("tr");
      hdr.className = "sp-dept-header";
      hdr.innerHTML = `<td colspan="6">${esc(sec.label)} ${tagFor(true)} — a breakdown of D92 + D95, already counted in Food (Non-FDD)</td>`;
      tbody.appendChild(hdr);

      for (const pair of sec.pairs) {
        const trailerNote = pair.byTrailer.length
          ? `<span class="sp-trailer-note muted tiny">${pair.byTrailer.map((t) => `${esc(t.trailer)} ${t.case_qty}`).join(" · ")}</span>`
          : "";
        tbody.appendChild(makeRow(
          `aisle:${sec.deptNbr}:${pair.label}`,
          `Aisle ${esc(pair.label)}${pair.unknown ? ' <span class="sp-tag warn">unlocated</span>' : ""} ${trailerNote}`,
          pair.totalCases, pair.totalBps, pair.hours,
          { indent: 1, defaultShift: "stock3" },
        ));
      }
    }
  }

  function tagFor(isFC) {
    return isFC ? `<span class="sp-tag fc">F&amp;C</span>` : `<span class="sp-tag gm">GM</span>`;
  }

  // Build a single plan table row with an assignment input.
  function makeRow(key, labelHtml, cases, bps, hours, opts = {}) {
    const tr = document.createElement("tr");
    tr.className = "sp-plan-row" + (opts.indent ? " sp-aisle-row" : "");
    tr.dataset.rowKey = key;

    const assignment = assignments.get(key)
      || { shift: opts.defaultShift || null, names: [] };
    assignments.set(key, assignment);

    tr.innerHTML = `
      <td class="sp-td-dept">${labelHtml}</td>
      <td class="sp-td-num">${Number(cases || 0).toLocaleString()}</td>
      <td class="sp-td-num">${Number(bps || 0).toLocaleString()}</td>
      <td class="sp-td-num sp-hrs">${hours}h</td>
      <td class="sp-td-shift">
        <select class="sp-shift-select" data-key="${esc(key)}">
          <option value="">—</option>
          <option value="stock2">Stock 2</option>
          <option value="stock3">Overnight</option>
          <option value="stock1">Stock 1 (am)</option>
        </select>
      </td>
      <td class="sp-td-assign">
        <div class="sp-chips" data-key="${esc(key)}"></div>
        <div class="sp-autocomplete-wrap">
          <input type="text" class="sp-assign-input" placeholder="assign…" data-key="${esc(key)}" autocomplete="off">
          <ul class="sp-dropdown" hidden></ul>
        </div>
      </td>`;

    const shiftSelect = tr.querySelector(".sp-shift-select");
    if (assignment.shift) shiftSelect.value = assignment.shift;

    shiftSelect.addEventListener("change", () => {
      const current = assignments.get(key) || { shift: null, names: [] };
      current.shift = shiftSelect.value || null;
      assignments.set(key, current);
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

      // Filter to the chosen shift. Stock 1 is tomorrow's crew and isn't in
      // tonight's associate list, so that option falls through to everyone.
      const selectedShift = shiftSelect.value;
      let matches = plan.associates;
      if (selectedShift === "stock2") matches = matches.filter((a) => a.role === "stock2");
      if (selectedShift === "stock3") matches = matches.filter((a) => a.role === "stock3" || a.role === "modteam");

      matches = matches.filter((a) => a.name.toLowerCase().includes(q)).slice(0, 8);
      if (!matches.length) { dropdown.hidden = true; return; }
      dropdown.innerHTML = matches
        .map((a) => `<li class="sp-dd-item${a.calledOut ? " sp-dd-callout" : ""}" data-name="${esc(a.name)}">${esc(a.name)} <span class="muted tiny">${esc(a.groupLabel)} · ${a.hours}h</span></li>`)
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

  // --- Breakdown level toggle ----------------------------------------------

  function onToggle(e) {
    const btn = e.target.closest(".sp-toggle-btn");
    if (!btn || !plan) return;
    level = btn.dataset.level;
    for (const b of container.querySelectorAll(".sp-toggle-btn")) {
      b.classList.toggle("is-active", b === btn);
    }
    renderPlanTable();
  }

  // --- Suggest a plan ------------------------------------------------------

  function onSuggest() {
    if (!plan) { setStatus("Collect first.", "error"); return; }
    if (!plan.deptTasks.length) {
      setStatus("A suggestion needs the department breakdown — allow pop-ups for radapps3.wal-mart.com and collect again.", "error");
      return;
    }
    host.usage.record("suggest");

    suggestion = suggestPlan(plan);

    // Accepting the draft fills the table too, so the user can edit it by hand
    // and the Copy/Print path still holds their edits.
    assignments = suggestionAssignments(suggestion);
    level = "dept";
    for (const b of container.querySelectorAll(".sp-toggle-btn")) {
      b.classList.toggle("is-active", b.dataset.level === "dept");
    }
    renderPlanTable();

    renderSuggestBlocks();
    $("sp-suggest-draft").textContent = toSuggestionText(plan, suggestion);

    const u = suggestion.utilisation.stock3;
    $("sp-suggest-util").textContent =
      "overnight at " + (u == null ? "?" : Math.round(u * 100) + "%") + " of its hours";

    const bits = [];
    for (const m of suggestion.moves) {
      const arrow = m.to === "stock1" ? "→" : "←";
      bits.push(
        '<li class="sp-move sp-move-' + (m.to === "stock1" ? "push" : "pull") + '">' +
        "<strong>" + esc(m.line) + "</strong> " + arrow + " " + esc(blockName(m.to)) +
        ' <span class="muted tiny">' + esc(m.why) + "</span></li>");
    }
    for (const n of suggestion.notes) {
      bits.push('<li class="sp-move sp-move-note"><strong>' + esc(blockName(n.block)) +
        '</strong> <span class="muted tiny">' + esc(n.text) + "</span></li>");
    }
    if (suggestion.owned.length) {
      bits.push('<li class="sp-move sp-move-note"><strong>Left out</strong> <span class="muted tiny">' +
        suggestion.owned.map((l) => esc(l.label) + " " + l.hours + "h (" + esc(l.owner) + ")").join("; ") +
        " — their own teams, never on the stocking plan.</span></li>");
    }
    $("sp-suggest-why").innerHTML = bits.length ? '<ul class="sp-moves">' + bits.join("") + "</ul>" : "";

    $("sp-suggest-section").hidden = false;
    $("sp-suggest-section").scrollIntoView({ behavior: "smooth", block: "nearest" });
    const n = suggestion.moves.length;
    setStatus("Draft ready — " + n + " line" + (n === 1 ? "" : "s") + " moved. Edit before sending.", "ok");
  }

  // Available vs planned, per team. "Left" is what the shift still has after
  // the freight this plan names — the room for zoning, backroom and topstock.
  function renderSuggestBlocks() {
    const order = ["stock2", "stock3", "modteam", "stock1"];
    const rows = [];
    for (const key of order) {
      const b = suggestion.blocks[key];
      if (!b) continue;
      if (key === "modteam" && !b.scheduled) {
        rows.push('<tr class="sp-block-none"><td>Mod Team</td><td colspan="4" class="muted tiny">none scheduled tonight</td></tr>');
        continue;
      }
      const crew  = b.crew ? b.crew.count + " scheduled" : "—";
      const avail = b.capacity == null ? "—" : b.capacity + "h";
      const plan_ = key === "modteam" ? "—" : b.hours + "h";
      let left = "—", cls = "";
      if (b.remaining != null && key !== "modteam") {
        left = (b.remaining < 0 ? "−" : "") + Math.abs(b.remaining) + "h";
        cls  = b.remaining < 0 ? "sp-left-over" : (b.util != null && b.util > 0.78 ? "sp-left-tight" : "");
      }
      const when = key === "stock1" ? " <span class=\"muted tiny\">" + esc(plan.nextDateLabel) + "</span>" : "";
      rows.push(
        "<tr><td>" + esc(b.title) + when + '</td><td class="muted tiny">' + esc(crew) +
        '</td><td class="sp-td-num">' + avail + '</td><td class="sp-td-num">' + plan_ +
        '</td><td class="sp-td-num sp-hrs ' + cls + '">' + left + "</td></tr>");
    }
    $("sp-suggest-blocks").innerHTML =
      '<table class="sp-blocks-table"><thead><tr>' +
      '<th>Team</th><th></th><th class="sp-th-num">Available</th>' +
      '<th class="sp-th-num">Planned</th><th class="sp-th-num">Left</th>' +
      "</tr></thead><tbody>" + rows.join("") + "</tbody></table>";
  }

  function blockName(key) {
    return { stock1: "Stock 1 (tomorrow am)", stock2: "Stock 2", stock3: "Overnight", modteam: "Mod Team" }[key] || key;
  }

  // --- Help ----------------------------------------------------------------

  // The CPH table is per store and per department, so it is derived from the
  // collect that just ran rather than shipped as a constant: cases divided by
  // the hours CaseVisibility charged for them IS the rate it used. Departments
  // whose whole day is inner packs have no case rate to show, so they fall back
  // to the inner-pack side; a vendor-set department has freight but zero hours,
  // which is a label, not a divide-by-zero.
  function renderHelpRates() {
    const box = $("sp-help-rates");
    if (!plan || !plan.deptTasks.length) {
      box.innerHTML = "<p class=\"muted tiny\">Collect first and this shows the exact rate CaseVisibility used for every department in that business day&rsquo;s freight.</p>";
      return;
    }

    const rows = plan.deptTasks.map((d) => {
      let cph = null;
      if (d.caseHours > 0 && d.cases > 0)         cph = d.cases / d.caseHours;
      else if (d.bpHours > 0 && d.breakpacks > 0) cph = d.breakpacks / d.bpHours;
      return {
        label:  d.label,
        hours:  d.hours,
        cph,
        vendor: d.hours === 0 && (d.cases > 0 || d.breakpacks > 0),
      };
    });
    rows.sort((a, b) => (b.cph ?? -1) - (a.cph ?? -1));

    box.innerHTML =
      '<p class="muted tiny">Derived from the ' + esc(plan.dateLabel || plan.businessDate) +
      " collect for store " + esc(String(plan.storeNbr)) +
      " \u2014 cases divided by the hours CaseVisibility charged for them.</p>" +
      '<table class="sp-help-table sp-help-rate-table"><thead><tr>' +
      '<th>Department</th><th class="sp-th-num">Cases / hr</th><th class="sp-th-num">Hours</th>' +
      "</tr></thead><tbody>" +
      rows.map((r) =>
        "<tr><td>" + esc(r.label) + '</td><td class="sp-td-num">' +
        (r.vendor ? '<span class="muted tiny">vendor set</span>'
                  : (r.cph == null ? "\u2014" : Math.round(r.cph))) +
        '</td><td class="sp-td-num">' + r.hours + "h</td></tr>").join("") +
      "</tbody></table>";
  }

  function onHelp() {
    renderHelpRates();
    const dlg = $("sp-help");
    if (typeof dlg.showModal === "function") dlg.showModal();
    else dlg.setAttribute("open", "");   // no <dialog> support: inline, still readable
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
    const text = suggestion ? toSuggestionText(plan, suggestion) : toPlaintext(plan, assignments);
    try {
      await navigator.clipboard.writeText(text);
      setStatus("Copied to clipboard.", "ok");
    } catch (e) {
      setStatus("Copy failed: " + (e?.message ?? e), "error");
    }
  }

  function onOpenOutlook() {
    if (!plan) { setStatus("Generate the plan first.", "error"); return; }
    const text     = suggestion ? toSuggestionText(plan, suggestion) : toPlaintext(plan, assignments);
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
  $("sp-help-btn").addEventListener("click", onHelp);
  // Clicking the backdrop closes it; a click inside lands on a child element.
  $("sp-help").addEventListener("click", (e) => { if (e.target === $("sp-help")) $("sp-help").close(); });
  $("sp-suggest").addEventListener("click", onSuggest);
  $("sp-print").addEventListener("click", onPrint);
  $("sp-copy").addEventListener("click", onCopy);
  $("sp-openOutlook").addEventListener("click", onOpenOutlook);
  container.querySelector(".sp-view-toggle").addEventListener("click", onToggle);

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
