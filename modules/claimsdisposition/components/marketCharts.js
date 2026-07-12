// modules/claimsdisposition/components/marketCharts.js
//
// Market overview charts. Mirrors donor src/components/MarketOverviewCharts.jsx
// (3 charts: 2 store-bar charts + 1 daily-trend line).
//
// N=1 behavior: with a single store in scope, the two store-bar charts are
// hidden (they'd show one bar each — uninformative). The daily-trend line
// chart stays. When future stores arrive, they auto-light.

import { h, clear } from "../lib/dom.js";
import { filterRecords, byStore, dailyMarketSeries, fmtMoney } from "../lib/metrics.js";
import { formatDateShort } from "../lib/dates.js";
import { createBarChart, createLineChart } from "../lib/chart.js";

const COLOR_DISPOSAL = "#0071CE";
const COLOR_DONATION = "#FFC220";

function chartCard(title, subtitle) {
  const slot = h("div", { class: "cd-chart" });
  const card = h("div", { class: "cd-card" },
    h("div", { class: "cd-section-head" },
      h("div", null,
        h("div", { class: "cd-section-title" }, title),
        h("div", { class: "cd-section-sub" }, subtitle),
      ),
    ),
    slot,
  );
  return { card, slot };
}

export function createMarketCharts() {
  // Storage for chart instances (created lazily so a stale chart isn't kept
  // alive on slot remount).
  let lineTrend = null;
  let barCountByStore = null;
  let barDollarByStore = null;

  const trendCard = chartCard("Daily Trend", "Disposals & donations across the selected window");
  const countCard = chartCard("Disposals vs Donations by Store", "Item counts, current filter window");
  const dollarCard = chartCard("Disposal $ vs Donation $ by Store", "Dollar value at cost");

  // Layout: trend is full width; the two store charts share the second row.
  const trendWrap = h("div", null, trendCard.card);
  const splitGrid = h("div", { class: "cd-grid cd-grid-charts" }, countCard.card, dollarCard.card);
  const root = h("div", { class: "cd-section" }, trendWrap, splitGrid);

  function update(state) {
    const recs = filterRecords(state.records, state.filters);
    const dailySeries = dailyMarketSeries(recs);
    const stores = byStore(recs);
    const multiStore = stores.length > 1;

    // ── Daily trend (always shown) ──
    const trendOpts = {
      height: 260,
      data: dailySeries,
      xKey: "dateIso",
      xFormat: (iso) => formatDateShort(iso),
      yFormat: (v) => v.toLocaleString(),
      series: [
        { key: "disposalCount", name: "Disposals", color: COLOR_DISPOSAL },
        { key: "donationCount", name: "Donations", color: COLOR_DONATION },
      ],
    };
    if (!lineTrend) lineTrend = createLineChart(trendCard.slot, trendOpts);
    else lineTrend.update(trendOpts);

    // ── Per-store bar charts (only when multi-store) ──
    splitGrid.style.display = multiStore ? "" : "none";
    if (multiStore) {
      const countOpts = {
        height: 280,
        data: stores,
        xKey: "storeNumber",
        xFormat: (v) => `#${v}`,
        yFormat: (v) => v.toLocaleString(),
        series: [
          { key: "disposalCount", name: "Disposals", color: COLOR_DISPOSAL },
          { key: "donationCount", name: "Donations", color: COLOR_DONATION },
        ],
      };
      const dollarOpts = {
        height: 280,
        data: stores,
        xKey: "storeNumber",
        xFormat: (v) => `#${v}`,
        yFormat: (v) => `$${Math.round(v / 1000)}k`,
        tooltip: (d, s) => `<strong>Store #${d.storeNumber}</strong><br>${s.name}: ${fmtMoney(d[s.key])}`,
        series: [
          { key: "disposalValue", name: "Disposal $", color: COLOR_DISPOSAL },
          { key: "donationValue", name: "Donation $", color: COLOR_DONATION },
        ],
      };
      if (!barCountByStore) barCountByStore = createBarChart(countCard.slot, countOpts);
      else barCountByStore.update(countOpts);
      if (!barDollarByStore) barDollarByStore = createBarChart(dollarCard.slot, dollarOpts);
      else barDollarByStore.update(dollarOpts);
    }
  }

  return {
    root,
    update,
    destroy() {
      lineTrend?.destroy();
      barCountByStore?.destroy();
      barDollarByStore?.destroy();
    },
  };
}
