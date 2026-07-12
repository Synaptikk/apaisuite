// modules/claimsdisposition/components/timeOfDay.js
//
// Hour-of-day analysis: 24h grouped bar chart (disposal + donation) +
// two 24-cell heat strips (intensity-shaded). Mirrors donor
// src/components/TimeOfDayAnalysis.jsx (128 LOC).

import { h, replace } from "../lib/dom.js";
import { filterRecords, hourSeries, mean, stdev } from "../lib/metrics.js";
import { formatHour } from "../lib/dates.js";
import { createBarChart } from "../lib/chart.js";

const COLOR_DISPOSAL = "#0071CE";
const COLOR_DONATION = "#FFC220";

function hexAlpha(hex, alpha) {
  const a = Math.max(0, Math.min(1, alpha));
  const v = hex.replace("#", "");
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function intensity(z) {
  if (z >= 2) return 1.0;
  if (z >= 1) return 0.6;
  if (z >= 0) return 0.3;
  return 0.12;
}

function buildHeatStrip(label, data, field, m, sd, color) {
  const grid = h("div", { style: { display: "grid", gridTemplateColumns: "repeat(12, 1fr)", gap: "3px" } });
  data.forEach((d) => {
    const v = d[field];
    const z = sd ? (v - m) / sd : 0;
    const isSpike = z >= 2;
    const bg = isSpike ? "rgba(220,38,38,0.85)" : hexAlpha(color, intensity(z));
    const cell = h("div", {
      title: `${formatHour(d.hour)}: ${v} (${z >= 0 ? "+" : ""}${z.toFixed(1)} SD)`,
      style: {
        aspectRatio: "1 / 1",
        borderRadius: "3px",
        background: bg,
        color: isSpike || intensity(z) > 0.5 ? "#FFFFFF" : "var(--apai-ink)",
        fontSize: "10px",
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
        paddingBottom: "2px",
        fontWeight: "500",
      },
    }, String(d.hour));
    grid.appendChild(cell);
  });
  return h("div", {
    style: {
      background: "var(--apai-bg-soft)",
      border: "1px solid var(--apai-border)",
      borderRadius: "var(--rad-md)",
      padding: "12px",
    },
  },
    h("div", { style: { display: "flex", justifyContent: "space-between", marginBottom: "8px" } },
      h("div", { style: { fontSize: "var(--fs-sm)", fontWeight: "var(--fw-semi)" } }, label),
      h("div", { class: "cd-muted", style: { fontSize: "var(--fs-xs)" } },
        `Mean ${m.toFixed(1)} · SD ${sd.toFixed(1)}`),
    ),
    grid,
  );
}

export function createTimeOfDay() {
  let barChart = null;

  const chartSlot = h("div", { class: "cd-chart" });
  const heatGrid  = h("div", { class: "cd-grid", style: { gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", marginTop: "16px" } });

  const root = h("div", { class: "cd-card cd-section" },
    h("div", { class: "cd-section-head" },
      h("div", null,
        h("div", { class: "cd-section-title" }, "Time-of-Day Analysis"),
        h("div", { class: "cd-section-sub" },
          "Highlights opening-shift donation surges, late-night disposal spikes, and recurring same-hour activity."),
      ),
    ),
    chartSlot,
    heatGrid,
  );

  function update(state) {
    const recs = filterRecords(state.records, state.filters);
    const disp = hourSeries(recs, "Disposal");
    const don  = hourSeries(recs, "Donation");
    const combined = Array.from({ length: 24 }, (_, i) => ({
      hour: i,
      hourLabel: formatHour(i),
      Disposal: disp[i].count,
      Donation: don[i].count,
    }));

    const opts = {
      height: 260,
      data: combined,
      xKey: "hourLabel",
      yFormat: (v) => v.toLocaleString(),
      series: [
        { key: "Disposal", name: "Disposal", color: COLOR_DISPOSAL },
        { key: "Donation", name: "Donation", color: COLOR_DONATION },
      ],
    };
    if (!barChart) barChart = createBarChart(chartSlot, opts);
    else barChart.update(opts);

    const dispCounts = combined.map((d) => d.Disposal);
    const donCounts  = combined.map((d) => d.Donation);
    replace(heatGrid,
      buildHeatStrip("Disposal intensity by hour", combined, "Disposal", mean(dispCounts), stdev(dispCounts), COLOR_DISPOSAL),
      buildHeatStrip("Donation intensity by hour", combined, "Donation", mean(donCounts),  stdev(donCounts),  COLOR_DONATION),
    );
  }

  return {
    root,
    update,
    destroy() { barChart?.destroy(); },
  };
}
