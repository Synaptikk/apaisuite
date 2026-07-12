// modules/claimsdisposition/components/filterBar.js
//
// Compact filter row: date from/to, day presets (7d/14d/30d/All), store
// multi-select pills, disposition multi-select pills, severity floor,
// department select. Mirrors donor src/components/FilterBar.jsx (203 LOC)
// but built as imperative DOM.
//
// State flow:
//   - All filter state lives in view.js (state.filters).
//   - onChange(newFilters) flows up via setState.
//   - update(state) is called whenever state changes; we re-render the
//     dynamic bits (selected pills, summary meta, dept dropdown).
//
// The dept dropdown options come from the dataset, so they need to refresh
// once the records load. Everything else is structural (built once).

import { h, replace } from "../lib/dom.js";
import { DISPOSITION_TYPES, STORE_LIST } from "../data/schema.js";
import { formatDate } from "../lib/dates.js";

const fmtInput = (d) => {
  if (!d) return "";
  // Local-time YYYY-MM-DD so <input type="date"> renders the day the user
  // expects (not shifted by UTC offset).
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function toggleInArray(arr, value) {
  const set = new Set(arr || []);
  if (set.has(value)) set.delete(value); else set.add(value);
  return Array.from(set);
}

export function createFilterBar({ onChange }) {
  let currentFilters = null;
  let currentMin = null;
  let currentMax = null;
  let currentDepartments = [];

  // ── Stable element refs (built once, re-populated on update) ──
  const fromInput = h("input", { type: "date", class: "cd-input" });
  const toInput   = h("input", { type: "date", class: "cd-input" });

  const presetRow  = h("div", { class: "cd-field-row" });
  const storeRow   = h("div", { class: "cd-field-row" });
  const dispRow    = h("div", { class: "cd-field-row" });
  const severitySel = h("select", { class: "cd-select" },
    h("option", { value: "" }, "All"),
    h("option", { value: "Low" },      "Low+"),
    h("option", { value: "Medium" },   "Medium+"),
    h("option", { value: "High" },     "High+"),
    h("option", { value: "Critical" }, "Critical only"),
  );
  const deptSel = h("select", { class: "cd-select" });
  const deptField = h("div", { class: "cd-field cd-hidden" },
    h("span", { class: "cd-field-label" }, "Department"),
    deptSel,
  );
  const summaryMeta = h("div", { class: "cd-summary-meta" });

  // Event wiring (uses currentFilters captured at click time)
  fromInput.addEventListener("change", () => {
    const v = fromInput.value ? new Date(fromInput.value) : null;
    onChange({ ...currentFilters, dateRange: { ...currentFilters.dateRange, from: v } });
  });
  toInput.addEventListener("change", () => {
    const v = toInput.value ? new Date(`${toInput.value}T23:59:59`) : null;
    onChange({ ...currentFilters, dateRange: { ...currentFilters.dateRange, to: v } });
  });
  severitySel.addEventListener("change", () => {
    onChange({ ...currentFilters, severity: severitySel.value || null });
  });
  deptSel.addEventListener("change", () => {
    onChange({ ...currentFilters, departments: deptSel.value ? [deptSel.value] : [] });
  });

  function presetDays(days) {
    if (!currentMax) return;
    const to = new Date(currentMax);
    const from = new Date(currentMax);
    from.setDate(from.getDate() - (days - 1));
    onChange({ ...currentFilters, dateRange: { from, to } });
  }

  function presetAll() {
    if (!currentMin || !currentMax) return;
    onChange({ ...currentFilters, dateRange: { from: currentMin, to: currentMax } });
  }

  // Build the static structure once.
  replace(presetRow,
    h("button", { type: "button", class: "cd-btn cd-btn-xs", onClick: () => presetDays(7) },  "7d"),
    h("button", { type: "button", class: "cd-btn cd-btn-xs", onClick: () => presetDays(14) }, "14d"),
    h("button", { type: "button", class: "cd-btn cd-btn-xs", onClick: () => presetDays(30) }, "30d"),
    h("button", { type: "button", class: "cd-btn cd-btn-xs", onClick: presetAll },             "All"),
  );

  const root = h("div", { class: "cd-filters cd-no-print" },
    h("div", { class: "cd-filters-bar" },
      h("div", { class: "cd-field" },
        h("span", { class: "cd-field-label" }, "From"),
        fromInput,
      ),
      h("div", { class: "cd-field" },
        h("span", { class: "cd-field-label" }, "To"),
        toInput,
      ),
      h("div", { class: "cd-field" },
        h("span", { class: "cd-field-label" }, "Quick range"),
        presetRow,
      ),
      h("div", { class: "cd-field cd-field-spacer" },
        h("span", { class: "cd-field-label" }, "Stores"),
        storeRow,
      ),
      h("div", { class: "cd-field" },
        h("span", { class: "cd-field-label" }, "Disposition Type"),
        dispRow,
      ),
      h("div", { class: "cd-field" },
        h("span", { class: "cd-field-label" }, "Severity"),
        severitySel,
      ),
      deptField,
      summaryMeta,
    ),
  );

  function renderStorePills() {
    const active = currentFilters?.storeNumbers || [];
    replace(storeRow,
      h("button", {
        type: "button",
        class: `cd-pill ${active.length === 0 ? "is-active" : ""}`,
        onClick: () => onChange({ ...currentFilters, storeNumbers: [] }),
      }, "All"),
      ...STORE_LIST.map((sn) => h("button", {
        type: "button",
        class: `cd-pill ${active.includes(sn) ? "is-active" : ""}`,
        onClick: () => onChange({ ...currentFilters, storeNumbers: toggleInArray(active, sn) }),
      }, String(sn))),
    );
  }

  function renderDispPills() {
    const active = currentFilters?.dispositionTypes || [];
    replace(dispRow,
      ...DISPOSITION_TYPES.map((t) => h("button", {
        type: "button",
        class: `cd-pill ${active.includes(t) ? "is-active-yellow" : ""}`,
        onClick: () => onChange({ ...currentFilters, dispositionTypes: toggleInArray(active, t) }),
      }, t)),
    );
  }

  function renderDeptOptions(departments) {
    if (!departments?.length) {
      deptField.classList.add("cd-hidden");
      return;
    }
    deptField.classList.remove("cd-hidden");
    const cur = currentFilters?.departments?.[0] || "";
    replace(deptSel,
      h("option", { value: "" }, "All"),
      ...departments.map((d) => h("option", { value: d }, d)),
    );
    deptSel.value = cur;
  }

  function renderSummary() {
    const r = currentFilters?.dateRange;
    if (r?.from && r?.to) {
      replace(summaryMeta,
        "Showing ",
        h("strong", null, `${formatDate(r.from)} – ${formatDate(r.to)}`),
      );
    } else {
      replace(summaryMeta);
    }
  }

  function update(state) {
    currentFilters = state.filters;
    if (state.records.length) {
      const set = new Set();
      for (const r of state.records) set.add(r.department);
      currentDepartments = Array.from(set).sort();
    }
    // date range bounds come from getDateRange — recomputed in view.js and
    // passed in via state? No — pull from records directly so the FilterBar
    // is self-sufficient. Cheap: O(records) once per state change.
    let min = null, max = null;
    for (const r of state.records) {
      if (!min || r.timestamp < min) min = r.timestamp;
      if (!max || r.timestamp > max) max = r.timestamp;
    }
    currentMin = min;
    currentMax = max;

    fromInput.min = fmtInput(min);
    fromInput.max = fmtInput(max);
    toInput.min   = fmtInput(min);
    toInput.max   = fmtInput(max);
    fromInput.value = fmtInput(currentFilters?.dateRange?.from);
    toInput.value   = fmtInput(currentFilters?.dateRange?.to);
    severitySel.value = currentFilters?.severity || "";

    renderStorePills();
    renderDispPills();
    renderDeptOptions(currentDepartments);
    renderSummary();
  }

  return { root, update, destroy() {} };
}
