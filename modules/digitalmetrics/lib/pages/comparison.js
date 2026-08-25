// modules/digitalmetrics/lib/pages/comparison.js
//
// Side-by-side group comparison. Each card is the unweighted mean of that
// group's associates, matching how the benchmarks themselves are computed —
// deliberately NOT a picks-over-hours recomputation, so the numbers here agree
// with the ones on every other tab.

import { section, empty, esc } from "./_shared.js";
import { CLASSIFICATIONS, classificationOf } from "../data/classify.js";
import { badgeClass } from "../data/classify.js";

const METRICS = [
  { key: "hours",      label: "Hours",     suffix: ""    },
  { key: "ftpr",       label: "FTPR",      suffix: "%"   },
  { key: "pick_rate",  label: "Pick Rate", suffix: "/hr" },
  { key: "nil_rate",   label: "Nil Rate",  suffix: "%"   },
  { key: "sub_rate",   label: "Sub Rate",  suffix: "%"   },
  { key: "picked_qty", label: "Pick Qty",  suffix: ""    },
];

function groupStats(list) {
  if (!list.length) return null;
  const out = { count: list.length };
  for (const { key } of METRICS) {
    const total = list.reduce((s, a) => s + (a[key] || 0), 0);
    // Quantities sum; rates average.
    out[key] = key === "picked_qty" || key === "hours"
      ? Math.round(total * 10) / 10
      : Math.round((total / list.length) * 10) / 10;
  }
  return out;
}

function card(name, stats) {
  if (!stats) {
    return `<div class="dm-compare-card">
      <h4 class="dm-compare-title">${esc(name)}</h4>
      <p class="dm-stat-note">No associates in this group.</p>
    </div>`;
  }
  const rows = METRICS.map(({ key, label, suffix }) =>
    `<tr><td>${esc(label)}</td><td class="is-right">${esc(stats[key])}${esc(suffix)}</td></tr>`
  ).join("");

  return `<div class="dm-compare-card">
    <h4 class="dm-compare-title">
      <span class="badge ${esc(badgeClass(name))}">${esc(name)}</span>
      <span class="dm-stat-note">${stats.count} associate${stats.count === 1 ? "" : "s"}</span>
    </h4>
    <table class="data-table"><tbody>${rows}</tbody></table>
  </div>`;
}

export function render(ctx) {
  const { associates = [], classifications = {} } = ctx;
  if (!associates.length) return empty("Select a store to compare groups.");

  const cards = CLASSIFICATIONS.map((name) =>
    card(name, groupStats(associates.filter((a) => classificationOf(a.name, classifications) === name)))
  );

  return section("Compare Groups", `<div class="dm-compare-grid">${cards.join("")}</div>`);
}
