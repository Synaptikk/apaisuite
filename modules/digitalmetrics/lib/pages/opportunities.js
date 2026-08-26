// modules/digitalmetrics/lib/pages/opportunities.js
//
// Associates performing below their cohort benchmark, worst first.

import { section, empty, esc, table, associateCell } from "./_shared.js";
import { classificationOf, badgeClass, CLASSIFICATIONS, UNCLASSIFIED } from "../data/classify.js";
import { analyseOpportunities, sortOpportunities } from "../data/opportunities.js";

const SORT_OPTIONS = [
  ["overall",        "Overall"],
  ["ftpr",           "FTPR"],
  ["pick_rate",      "Pick Rate"],
  ["nil_rate",       "Nil Rate"],
  ["sub_rate",       "Sub Rate"],
  ["late_start",     "Late Start"],
  ["pick_adherence", "Pick Adherence"],
];

// Exceptions is off by default: exception pickers are measured on a different
// scale and their presence buries everyone else.
const DEFAULT_GROUPS = ["Digital", "Fashion", "Store Help", UNCLASSIFIED];

export function render(ctx) {
  const { associates = [], benchmarks = {}, classifications = {}, adherence = {}, ui = {} } = ctx;
  if (!associates.length) return empty("Select a store to see opportunities.");

  const sortBy = ui.oppSort || "overall";
  const groups = ui.oppGroups || DEFAULT_GROUPS;

  const inGroup = associates.filter((a) =>
    groups.includes(classificationOf(a.name, classifications)));

  const flagged = sortOpportunities(
    analyseOpportunities(inGroup, benchmarks, adherence).filter((a) => a.issues.length),
    sortBy,
  );

  const controls = `
    <div class="dm-controls">
      <label class="field">
        <span>Sort by</span>
        <select class="dm-input" id="dm-opp-sort">
          ${SORT_OPTIONS.map(([v, l]) =>
            `<option value="${esc(v)}" ${v === sortBy ? "selected" : ""}>${esc(l)}</option>`).join("")}
        </select>
      </label>
      <div class="dm-filter-group">
        ${[...CLASSIFICATIONS, UNCLASSIFIED].map((g) => `
          <button class="dm-filter ${groups.includes(g) ? "is-active" : ""}"
                  data-dm-group="${esc(g)}">${esc(g)}</button>`).join("")}
      </div>
      <span class="dm-stat-note">${flagged.length} flagged</span>
    </div>`;

  const rows = table([
    {
      label: "Associate", key: "name",
      format: (a) => {
        const cls = classificationOf(a.name, classifications);
        return associateCell(a.name, cls);
      },
    },
    { label: "Score", key: "score", align: "right",
      // The breakdown is the justification; without it the number is arbitrary.
      format: (a) => `<span title="${esc(a.scoreBreakdown.join("\n"))}">${esc(a.score)}</span>` },
    { label: "FTPR",      key: "ftpr",      align: "right", format: (a) => `${esc(a.ftpr)}%` },
    { label: "Pick Rate", key: "pick_rate", align: "right" },
    { label: "Nil",       key: "nil_rate",  align: "right", format: (a) => `${esc(a.nil_rate)}%` },
    { label: "Sub",       key: "sub_rate",  align: "right", format: (a) => `${esc(a.sub_rate)}%` },
    {
      label: "Adherence", key: "adherence", align: "right",
      format: (a) => {
        const info = adherence[a.name];
        if (!info) return "—";
        return `<span class="${info.isLowAdherence ? "is-bad" : "is-good"}">${esc(info.adherence)}%</span>` +
               `<div class="dm-stat-note">${esc(info.actualHours)}h / ${esc(info.assignedHours)}h</div>`;
      },
    },
    { label: "Issues", key: "issues",
      format: (a) => `<ul class="dm-issues">${
        a.issues.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` },
  ], flagged, { emptyMessage: "No associates are below benchmark in the selected groups." });

  return section("Opportunities", controls + rows);
}

export function wire(ctx, root) {
  const { host, onUiChange, ui = {} } = ctx;

  const sort = root.querySelector("#dm-opp-sort");
  const onSort = (e) => onUiChange?.({ oppSort: e.target.value });
  sort?.addEventListener("change", onSort);

  const offAssoc = host.ui.delegate(root, "click", "[data-dm-associate]", (_e, el) => {
    ctx.onSelectAssociate?.(el.dataset.dmAssociate);
  });

  const offGroup = host.ui.delegate(root, "click", "[data-dm-group]", (_e, el) => {
    const group   = el.dataset.dmGroup;
    const current = ui.oppGroups || DEFAULT_GROUPS;
    const next    = current.includes(group)
      ? current.filter((g) => g !== group)
      : [...current, group];
    onUiChange?.({ oppGroups: next });
  });

  return () => {
    sort?.removeEventListener("change", onSort);
    offGroup?.();
    offAssoc?.();
  };
}
