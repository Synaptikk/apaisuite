// modules/claimsdisposition/components/dayOfWeek.js
//
// Day-of-week analysis: 7-bar grouped chart with dashed mean reference
// lines for each series. Mirrors donor src/components/DayOfWeekAnalysis.jsx
// (38 LOC).

import { h } from "../lib/dom.js";
import { filterRecords, dayOfWeekSeries, mean } from "../lib/metrics.js";
import { createBarChart } from "../lib/chart.js";

const COLOR_DISPOSAL = "#0071CE";
const COLOR_DONATION_DARK = "#E5A800"; // matches donor's reference line color

export function createDayOfWeek() {
  let barChart = null;
  const chartSlot = h("div", { class: "cd-chart" });
  const root = h("div", { class: "cd-card cd-section" },
    h("div", { class: "cd-section-head" },
      h("div", null,
        h("div", { class: "cd-section-title" }, "Day-of-Week Analysis"),
        h("div", { class: "cd-section-sub" },
          "Compare daily volume to the rolling baseline. Dashed lines mark the average across the selected window."),
      ),
    ),
    chartSlot,
  );

  function update(state) {
    const recs = filterRecords(state.records, state.filters);
    const data = dayOfWeekSeries(recs);
    const dispBase = mean(data.map((d) => d.disposalCount));
    const donBase  = mean(data.map((d) => d.donationCount));

    const opts = {
      height: 280,
      data,
      xKey: "name",
      yFormat: (v) => v.toLocaleString(),
      series: [
        { key: "disposalCount", name: "Disposals", color: COLOR_DISPOSAL },
        { key: "donationCount", name: "Donations", color: "#FFC220" },
      ],
      referenceLines: [
        { y: dispBase, color: COLOR_DISPOSAL,      label: `Avg disposals (${dispBase.toFixed(1)})` },
        { y: donBase,  color: COLOR_DONATION_DARK, label: `Avg donations (${donBase.toFixed(1)})` },
      ],
    };
    if (!barChart) barChart = createBarChart(chartSlot, opts);
    else barChart.update(opts);
  }

  return {
    root,
    update,
    destroy() { barChart?.destroy(); },
  };
}
