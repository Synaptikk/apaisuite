// modules/claimsdisposition/components/storeTable.js
//
// Sortable store comparison table. Mirrors donor
// src/components/StoreComparisonTable.jsx (115 LOC).
//
// Sort state lives in the component (not the global app state) — same
// scoping decision the donor made.

import { h, replace } from "../lib/dom.js";
import { byStore, fmtMoney, fmtPct, filterRecords } from "../lib/metrics.js";
import { riskFlagFromScore, scoreStores, userFlagCountByStore } from "../lib/outliers.js";
import { sellThroughTier, cvpForWindow } from "../lib/cvp.js";
import { formatDate } from "../lib/dates.js";

const RISK_CLASS = {
  Normal:   "cd-pill-normal",
  Watch:    "cd-pill-watch",
  High:     "cd-pill-high",
  Critical: "cd-pill-critical",
};

const COLUMNS = [
  { key: "storeNumber",   label: "Store",         numeric: true,  format: (v) => v },
  { key: "total",         label: "Total Claims",  numeric: true,  format: (v) => v.toLocaleString() },
  { key: "disposalCount", label: "Disposals",     numeric: true,  format: (v) => v.toLocaleString() },
  { key: "disposalValue", label: "Disposal $",    numeric: true,  format: fmtMoney },
  { key: "donationCount", label: "Donations",     numeric: true,  format: (v) => v.toLocaleString() },
  { key: "donationValue", label: "Donation $",    numeric: true,  format: fmtMoney },
  { key: "disposalRate",  label: "Disposal Rate", numeric: true,  format: fmtPct },
  { key: "donationRate",  label: "Donation Rate", numeric: true,  format: fmtPct },
  { key: "sellThrough",   label: "Sell Through",  numeric: true,
    // Rendered specially below — colored cell based on tier (cvp.js).
    // Value is a fraction (0–1) so the table's default fmtPct works for sort.
    format: (v) => null,
    title: "Sell-through ratio (CVP units sold ÷ CVP units active) over the same date window as the filter. Capped at 8 weeks — Hoops returns at most 8 weeks of history.",
  },
  { key: "outlierScore",  label: "Outlier Score", numeric: true,  format: (v) => String(v ?? 0) },
  { key: "userFlagCount", label: "Assoc. Flags",  numeric: true,
    // Render the count next to a colored dot whose hue matches the
    // highest U-rule severity at the store. Zero = muted dash.
    format: (v, row) => null,   // rendered specially in renderBody
  },
  { key: "risk",          label: "Risk",          numeric: false },
];

// Maps the highest user-event severity at a store to the same pill
// colour we use for the Risk column, so the user-flag column visually
// echoes severity without taking up extra space.
const USER_SEV_CLASS = {
  Critical: "cd-pill-critical",
  High:     "cd-pill-high",
  Medium:   "cd-pill-watch",
  Low:      "cd-pill-normal",
};

export function createStoreTable({ onSelectStore }) {
  let sortKey = "outlierScore";
  let sortDir = "desc";
  let lastState = null;

  const thead = h("thead");
  const tbody = h("tbody");
  const table = h("table", { class: "cd-table" }, thead, tbody);

  const root = h("div", { class: "cd-card cd-section" },
    h("div", { class: "cd-section-head" },
      h("div", null,
        h("div", { class: "cd-section-title" }, "Store Comparison"),
        h("div", { class: "cd-section-sub cd-drill-hint" },
          h("span", { class: "cd-drill-hint-icon", "aria-hidden": "true" }, "👆"),
          " Click any row to drill into a store",
        ),
      ),
    ),
    h("div", { style: { overflowX: "auto" } }, table),
  );

  function renderHead() {
    replace(thead,
      h("tr", null,
        ...COLUMNS.map((c) => {
          const isSorted = c.key === sortKey;
          return h("th", {
            class: `${c.numeric ? "cd-table-num" : ""} ${isSorted ? `is-sorted ${sortDir === "asc" ? "is-asc" : ""}` : ""}`.trim(),
            title: c.title || undefined,
            onClick: () => {
              if (sortKey === c.key) sortDir = sortDir === "asc" ? "desc" : "asc";
              else { sortKey = c.key; sortDir = "desc"; }
              render();
            },
          }, c.label);
        }),
      ),
    );
  }

  function renderBody() {
    if (!lastState) return;
    const recs = filterRecords(lastState.records, lastState.filters);
    const cvpByStore = lastState.cvpByStore || {};
    const dateRange  = lastState.filters?.dateRange || null;
    const fetchedAt  = lastState.cvpMeta?.fetchedAt || null;
    const scoreByStore = scoreStores(recs, cvpByStore, dateRange, fetchedAt);
    const userFlagsByStore = userFlagCountByStore(recs);
    const rows = byStore(recs).map((s) => {
      const score = scoreByStore.get(s.storeNumber) || 0;
      const uf    = userFlagsByStore.get(s.storeNumber) || { count: 0, topSeverity: null };
      const cvp   = cvpByStore[s.storeNumber] || cvpByStore[String(s.storeNumber)] || null;
      const win   = cvp ? cvpForWindow(cvp, dateRange, fetchedAt) : null;
      return {
        ...s,
        outlierScore:  score,
        userFlagCount: uf.count,
        userFlagSev:   uf.topSeverity,
        sellThrough:   win && win.weeksUsed > 0 ? win.sellThrough : null,
        cvpTotalQty:   win && win.weeksUsed > 0 ? win.cvpTotalQty : null,
        cvpSalesQty:   win && win.weeksUsed > 0 ? win.cvpSalesQty : null,
        cvpWeeksUsed:  win ? win.weeksUsed : 0,
        cvpCapped:     win ? win.capped : false,
        risk:          riskFlagFromScore(score),
      };
    });
    rows.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === "string" && typeof bv === "string") {
        return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      return sortDir === "asc" ? av - bv : bv - av;
    });

    replace(tbody,
      ...rows.map((r) =>
        h("tr", { onClick: () => onSelectStore?.(r.storeNumber) },
          ...COLUMNS.map((c) => {
            if (c.key === "risk") {
              return h("td", null,
                h("span", { class: `cd-pill cd-pill-static ${RISK_CLASS[r.risk] || "cd-pill-normal"}` }, r.risk),
              );
            }
            if (c.key === "userFlagCount") {
              if (!r.userFlagCount) {
                return h("td", { class: "cd-table-num cd-muted" }, "—");
              }
              const cls = USER_SEV_CLASS[r.userFlagSev] || "cd-pill-normal";
              return h("td", { class: "cd-table-num" },
                h("span", {
                  class: `cd-pill cd-pill-static ${cls}`,
                  title: `${r.userFlagCount} associate-level flag${r.userFlagCount === 1 ? "" : "s"} — open the drawer to see who.`,
                }, String(r.userFlagCount)),
              );
            }
            if (c.key === "sellThrough") {
              if (r.sellThrough == null) {
                // Two distinct "no value" cases get different tooltips so the
                // analyst can tell whether to widen the filter or run a pull.
                const why = !lastState.cvpByStore || !lastState.cvpByStore[r.storeNumber]
                  ? "Hoops CVP data not loaded for this pull."
                  : r.cvpWeeksUsed === 0
                    ? `Filter window doesn't overlap the 8-week CVP history Hoops returned. Try widening the date range or pulling fresh.`
                    : "No CVP data for this store this window.";
                return h("td", { class: "cd-table-num cd-muted", title: why }, "—");
              }
              const tier = sellThroughTier(r.sellThrough);
              const cls  = tier === "good"  ? "cd-pill-normal"
                         : tier === "amber" ? "cd-pill-watch"
                         : "cd-pill-critical";
              const weeksLabel = r.cvpWeeksUsed === 1 ? "1 week" : `${r.cvpWeeksUsed} weeks`;
              const rangeLabel = lastState.filters?.dateRange?.from && lastState.filters?.dateRange?.to
                ? ` — matches filter ${formatDate(lastState.filters.dateRange.from)} – ${formatDate(lastState.filters.dateRange.to)}`
                : "";
              const cappedNote = r.cvpCapped
                ? "\nNote: Hoops returns at most 8 weeks of CVP history; longer filters show all 8."
                : "";
              return h("td", { class: "cd-table-num" },
                h("span", {
                  class: `cd-pill cd-pill-static ${cls}`,
                  title: `${(r.sellThrough * 100).toFixed(1)}% over ${weeksLabel} of CVP data (${r.cvpSalesQty.toLocaleString()} sold / ${r.cvpTotalQty.toLocaleString()} units)${rangeLabel}. Green ≥ 25%, amber 15–25%, red < 15%.${cappedNote}`,
                }, fmtPct(r.sellThrough)),
              );
            }
            const v = r[c.key];
            return h("td", { class: c.numeric ? "cd-table-num" : "" },
              c.format ? c.format(v) : v,
            );
          }),
        ),
      ),
    );

    // Empty-state row (when filters yield no stores)
    if (rows.length === 0) {
      replace(tbody,
        h("tr", null,
          h("td", { colspan: COLUMNS.length, class: "cd-center cd-muted" },
            "No stores match the current filters.",
          ),
        ),
      );
    }
  }

  function render() {
    renderHead();
    renderBody();
  }

  return {
    root,
    update(state) {
      lastState = state;
      render();
    },
    destroy() {},
  };
}
