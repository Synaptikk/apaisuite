// modules/claimsdisposition/components/summaryCards.js
//
// 9 stat cards: total disposals, donations, $ values, rates, highest stores,
// outlier count. Mirrors donor src/components/SummaryCards.jsx (34 LOC).
//
// Each card has an optional accent stripe on the left (blue/yellow/red).

import { h, replace } from "../lib/dom.js";
import { summarize, highestStoreBy, fmtMoney, fmtPct, filterRecords } from "../lib/metrics.js";

const ACCENT_BLUE   = "var(--apai-blue)";
const ACCENT_YELLOW = "var(--apai-yellow)";
const ACCENT_RED    = "var(--cd-risk-critical)";

function card({ title, value, sub, accent }) {
  return h("div", { class: "cd-card" },
    accent ? h("span", { class: "cd-card-accent", style: { background: accent } }) : null,
    h("div", { class: "cd-card-title" }, title),
    h("div", { class: "cd-stat" }, value),
    sub ? h("div", { class: "cd-stat-sub" }, sub) : null,
  );
}

export function createSummaryCards({ getFilteredOutlierCount }) {
  // `getFilteredOutlierCount` is a getter passed in by view.js since the
  // outlier count depends on detectOutliers + severity filter — orchestrated
  // outside this component.
  const grid = h("div", { class: "cd-grid cd-grid-summary" });
  const root = h("div", null, grid);

  function update(state) {
    const recs = filterRecords(state.records, state.filters);
    const sum  = summarize(recs);
    const hiDisp = highestStoreBy(recs, "disposalValue");
    const hiDon  = highestStoreBy(recs, "donationValue");
    const outlierCount = getFilteredOutlierCount?.(state) ?? 0;

    replace(grid,
      card({ title: "Total Disposals", value: sum.disposalCount.toLocaleString(), sub: "Items dispositioned as disposal", accent: ACCENT_BLUE }),
      card({ title: "Total Donations", value: sum.donationCount.toLocaleString(), sub: "Items dispositioned as donation", accent: ACCENT_YELLOW }),
      card({ title: "Disposal $ Value", value: fmtMoney(sum.disposalValue), sub: "At cost", accent: ACCENT_BLUE }),
      card({ title: "Donation $ Value", value: fmtMoney(sum.donationValue), sub: "At cost", accent: ACCENT_YELLOW }),
      card({ title: "Disposal Rate", value: fmtPct(sum.disposalRate), sub: "of all claim events" }),
      card({ title: "Donation Rate", value: fmtPct(sum.donationRate), sub: "of all claim events" }),
      card({
        title: "Highest Disposal Store",
        value: hiDisp ? `#${hiDisp.storeNumber}` : "—",
        sub:   hiDisp ? fmtMoney(hiDisp.disposalValue) : "",
        accent: ACCENT_BLUE,
      }),
      card({
        title: "Highest Donation Store",
        value: hiDon ? `#${hiDon.storeNumber}` : "—",
        sub:   hiDon ? fmtMoney(hiDon.donationValue) : "",
        accent: ACCENT_YELLOW,
      }),
      card({ title: "Outlier Events", value: String(outlierCount), sub: "Across all rules", accent: ACCENT_RED }),
    );
  }

  return { root, update, destroy() {} };
}
