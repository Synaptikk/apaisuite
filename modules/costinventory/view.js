// modules/costinventory/view.js
//
// The worksheet on screen, in the sheet's own row order, so anyone who has
// filled the xlsx by hand recognises it immediately.
//
// The Cost Inventory App total is the one figure a person types. It is typed
// straight into the grid and the arithmetic below it updates as you go, with
// no pull involved — the pulled figures (beginning inventory, sales,
// purchases, freight) are already in hand by then.

import {
  buildWorksheet, DEPARTMENTS,
} from "./lib/compute.js";
import { fillWorkbook, excelDateSerial } from "./lib/xlsx.js";

const STALE_AFTER_MS = 12 * 60 * 60 * 1000;

// Worksheet rows, top to bottom, exactly as the xlsx prints them.
const ROWS = [
  // The sheet prints "counted (salesfloor & backroom)" in its operator column
  // here rather than a +/-/=; it is a note, not an operator, so it renders as
  // a hint under the label instead of in the 1-character operator slot.
  { key: "counted",   label: "Total from Cost Inventory App (Cost)", prefix: "",
    hint: "counted — salesfloor & backroom", kind: "input" },
  { key: "truck",     label: "Warehouse Truck Invoices (Cost)",      prefix: "+",
    hint: "always 0 — last night's freight is reported below, not added here", kind: "computed" },
  { key: "ending",    label: "Ending Inventory (Cost)",              prefix: "=",        kind: "computed", strong: true },
  { key: "gap1",      kind: "gap" },
  { key: "sales",     label: "Sales (Retail)",                       prefix: "",         kind: "pulled" },
  { key: "beginning", label: "Beginning Inventory",                  prefix: "",         kind: "pulled" },
  { key: "purchases", label: "Purchases (Cost)",                     prefix: "+",        kind: "pulled" },
  { key: "endingRef", label: "Ending inv",                           prefix: "—",   kind: "computed" },
  { key: "cogs",      label: "COGS",                                 prefix: "=",        kind: "computed" },
  { key: "grossProfit",    label: "Gross Profit $",                  prefix: "",         kind: "computed", strong: true },
  { key: "grossProfitPct", label: "Gross Profit %",                  prefix: "",         kind: "computed", strong: true, pct: true },
];

export async function mount(host, container) {
  // Inject the stylesheet and WAIT for it — rendering before it applies lays
  // the grid out with default table rules and reads as a layout bug.
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = host.url("styles.css");
  link.dataset.module = host.id;
  const cssReady = new Promise((resolve) => {
    if (link.sheet) return resolve();
    link.addEventListener("load", resolve, { once: true });
    link.addEventListener("error", resolve, { once: true });
  });
  document.head.appendChild(link);

  container.innerHTML = await (await fetch(host.url("view.html"))).text();
  await cssReady;

  const $ = (sel) => container.querySelector(sel);
  const els = {
    store:       $("[data-store]"),
    windowStart: $("[data-window-start]"),
    windowEnd:   $("[data-window-end]"),
    night:       $("[data-night]"),
    gridBody:    $("[data-grid-body]"),
    sources:     $("[data-sources]"),
    trailers:    $("[data-trailers]"),
    trailerBody: $("[data-trailer-body]"),
    freshness:   $("[data-freshness]"),
    pullBtn:     $('[data-action="pull"]'),
    exportBtn:   $('[data-action="export"]'),
  };

  // `counted` is held here rather than in the snapshot: it is the user's
  // typing, and a pull must never overwrite what they have entered.
  let state = { snapshot: null, counted: {}, storeNbr: "" };

  const initial = await host.messaging.send("get_state", {});
  state.counted  = initial?.inputs?.counted ?? {};
  state.storeNbr = initial?.inputs?.storeNbr ?? "";
  state.snapshot = initial?.snapshot ?? null;

  const defaults = initial?.defaults ?? {};
  els.store.value       = state.storeNbr;
  els.windowStart.value = state.snapshot?.dates?.windowStart ?? defaults.windowStart ?? "";
  els.windowEnd.value   = state.snapshot?.dates?.windowEnd   ?? defaults.windowEnd   ?? "";
  els.night.value       = state.snapshot?.dates?.night       ?? defaults.night       ?? "";

  render();

  // ── events ──────────────────────────────────────────────────────────────

  const onStoreInput = () => {
    state.storeNbr = els.store.value.trim();
    persistInputs();
  };
  els.store.addEventListener("change", onStoreInput);

  const onCountedInput = (e) => {
    const input = e.target.closest("[data-counted-dept]");
    if (!input) return;
    const dept = Number(input.dataset.countedDept);
    const raw = input.value.trim();
    if (raw === "") delete state.counted[dept];
    else state.counted[dept] = Number(raw.replace(/[$,]/g, ""));
    repaintComputed();
    persistInputs();
  };
  els.gridBody.addEventListener("input", onCountedInput);

  const onPull = async () => {
    setBusy(true);
    try {
      const res = await host.messaging.send("pull", {
        storeNbr: els.store.value.trim(),
        counted: state.counted,
        dates: {
          windowStart: els.windowStart.value,
          windowEnd:   els.windowEnd.value,
          night:       els.night.value,
        },
      });
      if (!res?.ok) {
        host.ui?.toast?.(res?.error ?? "pull failed");
        return;
      }
      state.snapshot = res.snapshot;
      render();
    } catch (e) {
      host.ui?.toast?.(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };
  els.pullBtn.addEventListener("click", onPull);

  const onExport = async () => {
    try {
      await exportWorkbook(host, state, els);
    } catch (e) {
      host.ui?.toast?.("export failed: " + String(e?.message ?? e));
    }
  };
  els.exportBtn.addEventListener("click", onExport);

  // ── rendering ───────────────────────────────────────────────────────────

  function worksheetNow() {
    const snap = state.snapshot;
    return buildWorksheet({
      counted: state.counted,
      beginningInventory: fromColumns(snap, "beginning"),
      itrByDept: itrFromSnapshot(snap),
    });
  }

  function render() {
    renderGrid(worksheetNow());
    renderSources(state.snapshot);
    renderTrailers(state.snapshot?.trailerPanel, state.snapshot?.dates?.night);
    renderFreshness(state.snapshot);
    els.exportBtn.disabled = !state.snapshot;
  }

  /** Cheap path for typing: only the derived cells change. */
  function repaintComputed() {
    const ws = worksheetNow();
    for (const row of ROWS) {
      if (row.kind !== "computed") continue;
      ws.columns.forEach((col) => {
        const cell = els.gridBody.querySelector(`[data-cell="${row.key}-${col.dept}"]`);
        if (cell) cell.textContent = formatCell(row, col);
      });
    }
    els.exportBtn.disabled = !state.snapshot;
  }

  function renderGrid(ws) {
    els.gridBody.innerHTML = "";
    for (const row of ROWS) {
      const tr = document.createElement("tr");
      if (row.kind === "gap") {
        tr.className = "ci-gap";
        tr.innerHTML = '<td colspan="5">Estimated Gross Profit:</td>';
        els.gridBody.appendChild(tr);
        continue;
      }

      tr.className = "ci-row ci-row-" + row.kind + (row.strong ? " ci-row-strong" : "");
      const label = document.createElement("td");
      label.className = "ci-rowlabel";
      label.innerHTML = (row.prefix ? '<span class="ci-op">' + row.prefix + "</span>" : "") + row.label +
        (row.hint ? '<em class="ci-hint">' + row.hint + "</em>" : "");
      tr.appendChild(label);

      for (const col of ws.columns) {
        const td = document.createElement("td");
        if (row.kind === "input") {
          const input = document.createElement("input");
          input.type = "text";
          input.inputMode = "decimal";
          input.className = "ci-count-input";
          input.dataset.countedDept = String(col.dept);
          input.placeholder = "type the app total";
          input.value = state.counted[col.dept] ?? "";
          td.appendChild(input);
        } else {
          td.dataset.cell = row.key + "-" + col.dept;
          td.textContent = formatCell(row, col);
          if (row.kind === "pulled" && !state.snapshot) td.classList.add("ci-empty");
        }
        tr.appendChild(td);
      }
      els.gridBody.appendChild(tr);
    }
  }

  function renderSources(snap) {
    if (!snap?.sources) { els.sources.hidden = true; return; }
    els.sources.hidden = false;

    const lines = [
      sourceLine("Beginning inventory", snap.sources.beginningInventory,
        snap.sources.beginningInventory?.tool
          ? snap.sources.beginningInventory.tool
          : "OneWalmart lookup"),
      sourceLine("Sales & purchases", snap.sources.itr,
        snap.sources.itr?.coverage
          ? snap.sources.itr.coverage.days + " days, " +
            snap.sources.itr.coverage.firstDate + " → " + snap.sources.itr.coverage.lastDate +
            (snap.sources.itr.coverage.missingTail > 0
              ? " (ITR is " + snap.sources.itr.coverage.missingTail + " day behind)" : "")
          : "Ops Portal ITR"),
      sourceLine("Freight", snap.sources.trailers,
        (snap.sources.trailers?.loads?.length ?? 0) + " fresh trailer(s) on " + (snap.sources.trailers?.night ?? "—")),
    ];
    els.sources.innerHTML = lines.join("");
  }

  function renderTrailers(panel, night) {
    if (!panel || !panel.trailers?.length) {
      if (panel && night) {
        els.trailers.hidden = false;
        els.trailerBody.innerHTML =
          '<p class="ci-note">No MP or FDD trailers invoiced for the night of ' + night + ".</p>";
        return;
      }
      els.trailers.hidden = true;
      return;
    }
    els.trailers.hidden = false;

    const depts = DEPARTMENTS;
    let html = '<table class="ci-trailer-table"><thead><tr><th>Trailer</th>' +
      depts.map((d) => "<th>" + d.dept + "<em>" + d.name + "</em></th>").join("") +
      "<th>Total</th></tr></thead><tbody>";

    for (const t of panel.trailers) {
      html += '<tr><td class="ci-trailer-id"><span class="ci-type ci-type-' + t.type.toLowerCase() + '">' +
        t.type + "</span> " + t.trailer +
        (t.arrived ? '<em>arrived ' + t.arrived + "</em>" : "") +
        (t.invoiceDates?.length ? '<em>invoiced ' + t.invoiceDates.join(", ") + "</em>" : "") +
        "</td>" +
        depts.map((d) => "<td>" + money(t.byDept[d.dept] ?? 0) + "</td>").join("") +
        "<td><strong>" + money(t.total) + "</strong></td></tr>";
    }

    for (const group of panel.byType) {
      html += '<tr class="ci-trailer-subtotal"><td>All ' + group.type + " trailers" +
        "<em>" + group.trailers.join(", ") + "</em></td>" +
        depts.map((d) => "<td>" + money(group.byDept[d.dept] ?? 0) + "</td>").join("") +
        "<td><strong>" + money(group.total) + "</strong></td></tr>";
    }

    html += '<tr class="ci-trailer-total"><td>MP + FDD combined</td>' +
      depts.map((d) => "<td>" + money(panel.byDept[d.dept] ?? 0) + "</td>").join("") +
      "<td><strong>" + money(panel.total) + "</strong></td></tr></tbody></table>";

    if (panel.missingInvoices?.length) {
      html += '<p class="ci-note ci-warn">No invoice yet for ' +
        panel.missingInvoices.map((m) => m.type + " " + m.trailer).join(", ") +
        " — that freight is not in the totals above.</p>";
    }

    els.trailerBody.innerHTML = html;
  }

  function renderFreshness(snap) {
    if (!snap?.pulledAt) { els.freshness.textContent = "no pull yet"; return; }
    const age = Date.now() - snap.pulledAt;
    els.freshness.textContent = "pulled " + relative(age);
    els.freshness.classList.toggle("ci-stale", age > STALE_AFTER_MS);
  }

  function setBusy(busy) {
    els.pullBtn.disabled = busy;
    els.pullBtn.querySelector(".btn-spinner").hidden = !busy;
    els.pullBtn.querySelector(".btn-label").textContent = busy ? "Pulling…" : "Pull numbers";
  }

  function persistInputs() {
    host.messaging.send("set_inputs", {
      inputs: { storeNbr: state.storeNbr, counted: state.counted },
    }).catch(() => {});
  }

  // ── cleanup ─────────────────────────────────────────────────────────────
  return () => {
    els.store.removeEventListener("change", onStoreInput);
    els.gridBody.removeEventListener("input", onCountedInput);
    els.pullBtn.removeEventListener("click", onPull);
    els.exportBtn.removeEventListener("click", onExport);
    link.remove();
  };
}

// ─── export ───────────────────────────────────────────────────────────────

async function exportWorkbook(host, state, els) {
  const ws = buildWorksheet({
    counted: state.counted,
    beginningInventory: fromColumns(state.snapshot, "beginning"),
    itrByDept: itrFromSnapshot(state.snapshot),
  });

  const cells = {
    C3: els.store.value.trim(),
    E3: excelDateSerial(els.windowEnd.value || new Date().toISOString().slice(0, 10)),
  };
  for (const col of ws.columns) {
    cells[col.column + "7"]  = col.counted;
    cells[col.column + "8"]  = col.truck;
    cells[col.column + "13"] = col.sales;
    cells[col.column + "14"] = col.beginning;
    cells[col.column + "15"] = col.purchases;
  }

  const template = await (await fetch(host.url("templates/worksheet.xlsx"))).arrayBuffer();
  const filled = await fillWorkbook(template, cells);

  const blob = new Blob([filled], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "Cost-Inventory-" + (els.store.value.trim() || "store") + "-" +
    (els.windowEnd.value || "today") + ".xlsx";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ─── helpers ──────────────────────────────────────────────────────────────

function fromColumns(snap, key) {
  const out = {};
  for (const col of snap?.worksheet?.columns ?? []) out[col.dept] = col[key];
  return out;
}

function itrFromSnapshot(snap) {
  const out = {};
  for (const col of snap?.worksheet?.columns ?? []) {
    out[col.dept] = { purchasesCost: col.purchases, salesRetail: col.sales };
  }
  return out;
}

function formatCell(row, col) {
  if (row.pct) return (col.grossProfitPct * 100).toFixed(1) + "%";
  const key = row.key === "endingRef" ? "ending" : row.key;
  return money(col[key] ?? 0);
}

function money(n) {
  return "$" + (Number(n) || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function sourceLine(label, source, detail) {
  const ok = source?.ok;
  return '<div class="ci-source ' + (ok ? "ci-source-ok" : "ci-source-bad") + '">' +
    '<span class="ci-source-dot"></span>' +
    "<strong>" + label + "</strong>" +
    "<span>" + (ok ? detail : (source?.error ?? "not pulled")) + "</span></div>";
}

function relative(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + " min ago";
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours + " h ago";
  return Math.round(hours / 24) + " d ago";
}
