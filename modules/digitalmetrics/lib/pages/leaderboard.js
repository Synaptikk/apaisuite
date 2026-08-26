// modules/digitalmetrics/lib/pages/leaderboard.js
//
// Ranking by any single metric, with volume outliers held back.

import { section, empty, esc, table, associateCell, compareBy, flipDir } from "./_shared.js";
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
  // Associate is sortable too but is not a ranking metric, so it lives outside
  // METRICS — which still drives the Metric dropdown and the Top/Bottom slice.
  const sortable  = [...METRICS, ["name", "Associate", "", "asc"]];
  const metric    = sortable.find(([k]) => k === metricKey) || METRICS[0];
  const [key, , , direction] = metric;

  // The ranking direction is the metric's own "better first" unless the user
  // has clicked the active header to invert it. Kept as a flag rather than a
  // literal direction so the natural order stays the default when the metric
  // changes — otherwise switching to Nil Rate would silently rank worst-first.
  const dir = ui.lbRev ? flipDir(direction) : direction;

  const scoped = group === "All"
    ? associates
    : associates.filter((a) => classificationOf(a.name, classifications) === group);

  const { ranked, excluded } = excludeOutliers(scoped);

  const sorted = [...ranked].sort(compareBy(key, dir));

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

  // Every metric is shown, always. Previously only the selected one had a
  // column, so comparing two metrics meant switching the dropdown back and
  // forth and holding the first set of numbers in your head.
  const rows = table([
    // Rank is the row's position in the current sort, so it has no order of
    // its own to be sorted by.
    { label: "#", key: "_rank", align: "right", sortable: false,
      format: (a) => String(shown.indexOf(a) + 1) },
    { label: "Associate", key: "name",
      format: (a) => {
        const cls = classificationOf(a.name, classifications);
        return associateCell(a.name, cls);
      } },
    ...METRICS.map(([k, l, sfx]) => ({
      label: l, key: k, align: "right",
      format: (a) => k === "picked_qty"
        ? esc((a[k] || 0).toLocaleString())
        : `${esc(a[k] ?? 0)}${esc(sfx)}`,
    })),
  ], shown, {
    emptyMessage: "No associates in this group.",
    sort: { key, dir },
  });

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
  const { onUiChange, host, onSelectAssociate, ui = {} } = ctx;
  const bind = (id, field, extra = {}) => {
    const el = root.querySelector(id);
    const fn = (e) => onUiChange?.({ [field]: e.target.value, ...extra });
    el?.addEventListener("change", fn);
    return () => el?.removeEventListener("change", fn);
  };
  const offs = [
    // Picking a metric from the dropdown drops any inversion, so the new
    // metric arrives in its natural best-first order.
    bind("#dm-lb-metric", "lbMetric", { lbRev: false }),
    bind("#dm-lb-group",  "lbGroup"),
    bind("#dm-lb-count",  "lbCount"),
    // Clicking the header you are already sorted by flips the direction;
    // clicking any other switches to it, natural order first. Same convention
    // as every file manager, so it needs no explaining.
    host.ui.delegate(root, "click", "[data-dm-sort]", (_e, el) => {
      const next = el.dataset.dmSort;
      onUiChange?.(next === (ui.lbMetric || "ftpr")
        ? { lbRev: !ui.lbRev }
        : { lbMetric: next, lbRev: false });
    }),
    // Clicking a name anywhere opens that person's breakdown, not just on the
    // Associates tab.
    host.ui.delegate(root, "click", "[data-dm-associate]", (_e, el) => {
      onSelectAssociate?.(el.dataset.dmAssociate);
    }),
  ];
  return () => offs.forEach((off) => off());
}
