// modules/digitalmetrics/lib/pages/classify.js
//
// Bulk classification. One row per associate, radio buttons per category.
//
// Changes are applied optimistically and persisted through the module's
// adapter, which re-encodes the whole map (classifications are stored as a
// single token-keyed document, not per-associate rows).

import { section, empty, esc, table } from "./_shared.js";
import { CLASSIFICATIONS, UNCLASSIFIED, classificationOf, badgeClass } from "../data/classify.js";

const FILTERS = ["All", "Unclassified", ...CLASSIFICATIONS];

export function render(ctx) {
  const { associates = [], classifications = {}, ui = {} } = ctx;
  if (!associates.length) return empty("Select a store to classify associates.");

  const filter = ui.classifyFilter || "All";
  const search = (ui.classifySearch || "").trim().toUpperCase();

  const visible = associates.filter((a) => {
    const cls = classificationOf(a.name, classifications);
    if (filter !== "All" && cls !== filter) return false;
    if (search && !a.name.toUpperCase().includes(search)) return false;
    return true;
  });

  const controls = `
    <div class="dm-controls">
      <input class="dm-input" id="dm-classify-search" type="search"
             placeholder="Search associates" value="${esc(ui.classifySearch || "")}">
      <div class="dm-filter-group">
        ${FILTERS.map((f) => `
          <button class="dm-filter ${f === filter ? "is-active" : ""}"
                  data-dm-filter="${esc(f)}">${esc(f)}</button>`).join("")}
      </div>
      <span class="dm-stat-note">${visible.length} of ${associates.length}</span>
    </div>`;

  const rows = table([
    { key: "name", label: "Associate" },
    {
      label: "Current", key: "_current",
      format: (a) => {
        const cls = classificationOf(a.name, classifications);
        return `<span class="badge ${esc(badgeClass(cls))}">${esc(cls)}</span>`;
      },
    },
    {
      label: "Classify as", key: "_radio",
      format: (a) => {
        const cls = classificationOf(a.name, classifications);
        return [...CLASSIFICATIONS, UNCLASSIFIED].map((c) => `
          <label class="dm-radio">
            <input type="radio" name="dm-cls-${esc(a.name)}" value="${esc(c)}"
                   data-dm-classify="${esc(a.name)}" ${c === cls ? "checked" : ""}>
            <span>${esc(c)}</span>
          </label>`).join("");
      },
    },
  ], visible, { emptyMessage: "No associates match this filter." });

  return section("Classify", controls + rows);
}

export function wire(ctx, root) {
  const { host, onClassify, onUiChange } = ctx;

  const offRadio = host.ui.delegate(root, "[data-dm-classify]", "change", (_e, el) => {
    onClassify?.(el.dataset.dmClassify, el.value);
  });

  const offFilter = host.ui.delegate(root, "[data-dm-filter]", "click", (_e, el) => {
    onUiChange?.({ classifyFilter: el.dataset.dmFilter });
  });

  // Debounced so a re-render doesn't fight the user mid-word.
  let timer = null;
  const search = root.querySelector("#dm-classify-search");
  const onInput = (e) => {
    clearTimeout(timer);
    const value = e.target.value;
    timer = setTimeout(() => onUiChange?.({ classifySearch: value }), 200);
  };
  search?.addEventListener("input", onInput);

  return () => {
    offRadio?.();
    offFilter?.();
    clearTimeout(timer);
    search?.removeEventListener("input", onInput);
  };
}
