// modules/digitalmetrics/lib/pages/leaderboard.js
//
// Ranking by any single metric, with volume outliers held back.

import { section, empty, esc, table, associateCell } from "./_shared.js";
import { classificationOf, badgeClass, CLASSIFICATIONS, UNCLASSIFIED } from "../data/classify.js";
import { excludeOutliers } from "../data/opportunities.js";

const METRICS = [
  ["ftpr",       "FTPR",       "%",   "desc"],
  ["pick_rate",  "Pick Rate",  "",    "desc"],
  ["picked_qty", "Pick Qty",   "",    "desc"],
  ["hours",      "Hours",      "",    "desc"],
  ["nil_rate",   "Nil Rate",   "%",   "asc"],   // lower is better
  ["sub_rate",   "Sub Rate",   "%",   "asc"],
];

const COUNTS = [
  ["top10", "Top 10"], ["top25", "Top 25"], ["top50", "Top 50"],
  ["bottom10", "Bottom 10"], ["bottom25", "Bottom 25"], ["all", "All"],
];

export function render(ctx) {
  const { associates = [], classifications = {}, ui = {} } = ctx;
  if (!associates.length) return empty("Select a store to see the leaderboard.");

  const metricKey = ui.lbMetric || "ftpr";
  const group     = ui.lbGroup  || "All";
  const countKey  = ui.lbCount  || "top25";
  const metric    = METRICS.find(([k]) => k === metricKey) || METRICS[0];
  const [key, label, suffix, direction] = metric;

  const scoped = group === "All"
    ? associates
    : associates.filter((a) => classificationOf(a.name, classifications) === group);

  const { ranked, excluded } = excludeOutliers(scoped);

  const sorted = [...ranked].sort((a, b) =>
    direction === "asc" ? (a[key] || 0) - (b[key] || 0) : (b[key] || 0) - (a[key] || 0));

  const [, mode, size] = countKey.match(/^(top|bottom|all)(\d+)?$/) || [];
  const shown = mode === "all"    ? sorted
              : mode === "bottom" ? sorted.slice(-Number(size))
              :                     sorted.slice(0, Number(size));

  const controls = `
    <div class="dm-controls">
      <label class="field"><span>Metric</span>
        <select class="dm-input" id="dm-lb-metric">
          ${METRICS.map(([k, l]) =>
            `<option value="${esc(k)}" ${k === metricKey ? "selected" : ""}>${esc(l)}</option>`).join("")}
        </select>
      </label>
      <label class="field"><span>Group</span>
        <select class="dm-input" id="dm-lb-group">
          ${["All", ...CLASSIFICATIONS, UNCLASSIFIED].map((g) =>
            `<option value="${esc(g)}" ${g === group ? "selected" : ""}>${esc(g)}</option>`).join("")}
        </select>
      </label>
      <label class="field"><span>Show</span>
        <select class="dm-input" id="dm-lb-count">
          ${COUNTS.map(([k, l]) =>
            `<option value="${esc(k)}" ${k === countKey ? "selected" : ""}>${esc(l)}</option>`).join("")}
        </select>
      </label>
    </div>`;

  const rows = table([
    { label: "#", key: "_rank", align: "right",
      format: (a) => String(shown.indexOf(a) + 1) },
    { label: "Associate", key: "name",
      format: (a) => {
        const cls = classificationOf(a.name, classifications);
        return associateCell(a.name, cls);
      } },
    { label, key, align: "right", format: (a) => `${esc(a[key] ?? 0)}${esc(suffix)}` },
    { label: "Pick Qty", key: "picked_qty", align: "right",
      format: (a) => esc((a.picked_qty || 0).toLocaleString()) },
    { label: "Hours", key: "hours", align: "right" },
  ], shown, { emptyMessage: "No associates in this group." });

  // Exclusions are disclosed rather than silently dropped — a missing name on
  // a leaderboard reads as an error to the person looking for it.
  const note = excluded.length
    ? `<details class="dm-details">
         <summary>${excluded.length} excluded as low-volume outliers</summary>
         <ul class="dm-issues">${excluded
           .map((a) => `<li>${esc(a.name)} — ${esc((a.picked_qty || 0).toLocaleString())} picks</li>`)
           .join("")}</ul>
       </details>`
    : "";

  return section("Leaderboard", controls + rows + note);
}

export function wire(ctx, root) {
  const { onUiChange, host, onSelectAssociate } = ctx;
  const bind = (id, field) => {
    const el = root.querySelector(id);
    const fn = (e) => onUiChange?.({ [field]: e.target.value });
    el?.addEventListener("change", fn);
    return () => el?.removeEventListener("change", fn);
  };
  const offs = [
    bind("#dm-lb-metric", "lbMetric"),
    bind("#dm-lb-group",  "lbGroup"),
    bind("#dm-lb-count",  "lbCount"),
    // Clicking a name anywhere opens that person's breakdown, not just on the
    // Associates tab.
    host.ui.delegate(root, "click", "[data-dm-associate]", (_e, el) => {
      onSelectAssociate?.(el.dataset.dmAssociate);
    }),
  ];
  return () => offs.forEach((off) => off());
}
