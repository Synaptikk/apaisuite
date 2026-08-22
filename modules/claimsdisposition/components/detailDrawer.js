// modules/claimsdisposition/components/detailDrawer.js
//
// Slide-in side panel for per-store deep dive. Mirrors donor
// src/components/DetailDrawer.jsx (143 LOC), minus the line chart (added
// in Phase 4 with the chart helper) and the textarea (cosmetic only — no
// save mechanism in the donor either).

import { h, replace } from "../lib/dom.js";
import { dailyStoreSeries, hourSeries, summarize, byUserAtStore, fmtMoney, fmtPct } from "../lib/metrics.js";
import { detectUserOutliers, scoreUsersAtStore } from "../lib/outliers.js";
import { formatHour, formatDateShort } from "../lib/dates.js";
import { createLineChart } from "../lib/chart.js";
import { getNameSync, lookupName, warmCache, subscribe as subscribeDirectory } from "../../../shared/associateLookup.js";
import { sellThroughTier, cvpForWindow } from "../lib/cvp.js";

function mini(label, value) {
  return h("div", { class: "cd-card", style: { padding: "12px" } },
    h("div", { class: "cd-card-title" }, label),
    h("div", { style: { fontSize: "var(--fs-lg)", fontWeight: "var(--fw-semi)", marginTop: "4px" } }, value),
  );
}

function followUpFor(sum) {
  if (sum.disposalRate > 0.4) return "Validate dispose decisions — high disposal rate vs market.";
  if (sum.donationRate > 0.25) return "Confirm donation pickup partners — donation rate is elevated.";
  return "No immediate follow-up required; continue routine review.";
}

export function createDetailDrawer({ getHost, onClose }) {
  // `getHost` returns the DOM node we mount into (the #cd-drawer-host
  // container set up by view.html). The drawer renders into that host
  // because position:fixed needs to escape the module viewport in some
  // page contexts but here we just keep it in-module for cleanup safety.

  const backdrop = h("div", { class: "cd-drawer-backdrop", onClick: () => onClose?.() });
  const closeBtn = h("button", {
    type: "button",
    class: "cd-drawer-close",
    "aria-label": "Close",
    onClick: () => onClose?.(),
  }, "×");

  const headerTitle = h("h2", { class: "cd-drawer-title", style: { color: "#FFFFFF" } }, "");
  const headerSub   = h("p",  { class: "cd-drawer-subtitle", style: { color: "rgba(255,255,255,0.8)" } }, "Detail drawer");
  const drawerHeader = h("div", {
    class: "cd-drawer-header",
    style: { background: "var(--apai-blue)", color: "#FFFFFF" },
  },
    h("div", null, headerTitle, headerSub),
    closeBtn,
  );

  const body = h("div", { class: "cd-drawer-body" });
  const drawer = h("aside", { class: "cd-drawer" }, drawerHeader, body);

  const root = h("div", { class: "cd-no-print" }, backdrop, drawer);

  // Inline line chart instance — destroyed and recreated each render
  // because the chart slot itself is re-mounted via `replace(body, ...)`.
  let trendChart = null;

  // Cached "currently rendered for store" so we know when to warm the
  // directory cache (only on transitions, not on every re-render).
  let lastStoreWarmed = null;

  // Subscribe to directory resolution events. When a name resolves
  // asynchronously after the drawer has rendered, re-render the user
  // table in-place. We hold a ref to the table slot so we only repaint
  // that section, not the whole drawer.
  let usersSlot = null;
  let lastUserState = null;   // {storeNumber, records} — to drive re-renders
  const unsubscribeDirectory = subscribeDirectory(() => {
    // Re-render the user table when ANY username resolves. Cheap: just
    // re-runs the local table render against already-computed metrics.
    if (usersSlot && lastUserState) {
      renderUserTable(usersSlot, lastUserState.storeNumber, lastUserState.records);
    }
  });

  function render(state) {
    const storeNumber = state.selectedStore;
    if (storeNumber == null) {
      backdrop.classList.remove("is-open");
      drawer.classList.remove("is-open");
      trendChart?.destroy();
      trendChart = null;
      return;
    }

    const recs = state.records.filter((r) => r.storeNumber === storeNumber);
    const trend = dailyStoreSeries(recs, storeNumber);
    const hours = hourSeries(recs);
    const sum   = summarize(recs);
    const cvp   = state.cvpByStore?.[storeNumber] || state.cvpByStore?.[String(storeNumber)] || null;

    const topDays = [...trend]
      .map((d) => ({ ...d, total: d.disposalCount + d.donationCount, value: d.disposalValue + d.donationValue }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 5);
    const topHours = [...hours]
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    headerTitle.textContent = `Store #${storeNumber}`;

    const trendSlot = h("div", { class: "cd-chart", style: { height: "220px" } });
    // Reserve a slot for the users-at-this-store table. We re-paint just
    // this slot when directory lookups resolve, instead of re-rendering
    // the whole drawer body.
    usersSlot = h("div", { class: "cd-card", style: { padding: "0" } });
    lastUserState = { storeNumber, records: state.records };

    replace(body,
      // Mini stat grid
      h("section", { class: "cd-grid", style: { gridTemplateColumns: "1fr 1fr" } },
        mini("Total Claims",         sum.total.toLocaleString()),
        mini("Disposal $",           fmtMoney(sum.disposalValue)),
        mini("Donation $",           fmtMoney(sum.donationValue)),
        mini("Disposal Rate",        fmtPct(sum.disposalRate)),
        mini("Donation Rate",        fmtPct(sum.donationRate)),
        mini("Other / Return / CVP", (sum.returnCount + sum.cvpCount + sum.otherCount).toLocaleString()),
      ),

      // Trend chart
      h("section", { class: "cd-section" },
        h("h3", { class: "cd-section-title", style: { marginBottom: "8px" } }, "Trend"),
        trendSlot,
      ),

      // Top days + top hours side by side
      h("section", { class: "cd-grid", style: { gridTemplateColumns: "1fr 1fr" } },
        h("div", null,
          h("h3", { class: "cd-section-title", style: { marginBottom: "8px" } }, "Top Days"),
          h("ul", { class: "cd-card", style: { padding: "0", listStyle: "none", margin: "0" } },
            ...topDays.map((d) =>
              h("li", {
                style: { display: "flex", justifyContent: "space-between", padding: "8px 12px", borderBottom: "1px solid var(--apai-border-soft)" },
              },
                h("span", null, d.dateIso),
                h("span", { class: "cd-muted" },
                  `${d.total.toLocaleString()} events · ${fmtMoney(d.value)}`),
              ),
            ),
          ),
        ),
        h("div", null,
          h("h3", { class: "cd-section-title", style: { marginBottom: "8px" } }, "Top Hours"),
          h("ul", { class: "cd-card", style: { padding: "0", listStyle: "none", margin: "0" } },
            ...topHours.map((hb) =>
              h("li", {
                style: { display: "flex", justifyContent: "space-between", padding: "8px 12px", borderBottom: "1px solid var(--apai-border-soft)" },
              },
                h("span", null, formatHour(hb.hour)),
                h("span", { class: "cd-muted" }, `${hb.count.toLocaleString()} events`),
              ),
            ),
          ),
        ),
      ),

      // Recommended follow-up
      h("section", { class: "cd-section" },
        h("h3", { class: "cd-section-title", style: { marginBottom: "8px" } }, "Recommended Follow-up"),
        h("div", {
          class: "cd-card",
          style: { background: "rgba(0,113,206,0.08)", borderColor: "rgba(0,113,206,0.25)" },
        }, followUpFor(sum)),
      ),

      // CVP performance panel — Hoops Sell-Through for this store. Only
      // renders when the pull captured CVP data; otherwise hidden.
      cvp ? buildCvpPanel(cvp, storeNumber, state.filters?.dateRange, state.cvpMeta?.fetchedAt) : null,

      // Per-user breakdown at this store
      h("section", { class: "cd-section" },
        h("h3", { class: "cd-section-title", style: { marginBottom: "8px" } }, "Users at this store"),
        usersSlot,
      ),
    );

    // Populate the user table (sync render against in-memory directory).
    renderUserTable(usersSlot, storeNumber, state.records);

    // Kick off directory warm in the background. As lookups resolve,
    // subscribeDirectory above fires renderUserTable again to backfill names.
    // Only re-warm on store transitions to avoid hammering on every render.
    if (lastStoreWarmed !== storeNumber) {
      lastStoreWarmed = storeNumber;
      const usernames = byUserAtStore(state.records, storeNumber)
        .map((r) => r.userId)
        .filter((u) => u && u !== "(unknown)");
      warmCache(usernames).catch(() => {});
    }

    // Now that trendSlot is in the DOM (after replace(body, ...)) it has
    // a measurable width — create the chart and render.
    trendChart?.destroy();
    trendChart = createLineChart(trendSlot, {
      height: 220,
      data: trend,
      xKey: "dateIso",
      xFormat: (iso) => formatDateShort(iso),
      yFormat: (v) => v.toLocaleString(),
      series: [
        { key: "disposalCount", name: "Disposals", color: "#0071CE" },
        { key: "donationCount", name: "Donations", color: "#FFC220" },
      ],
    });

    requestAnimationFrame(() => {
      backdrop.classList.add("is-open");
      drawer.classList.add("is-open");
    });
  }

  return {
    root,
    update(state)  { render(state); },
    destroy()      {
      trendChart?.destroy();
      unsubscribeDirectory();
    },
  };
}

// ── Per-user table rendering ─────────────────────────────────────
// Renders into `slot`. Kicks directory lookups (via lookupName) for each
// row so names resolve async; the subscribeDirectory listener in the
// createDetailDrawer closure re-invokes this fn when names settle.
//
// Columns: username (+ resolved name), total claims, disposal $,
// donation $, outlier flags. Sorted by outlier score then disposal $ desc.
function renderUserTable(slot, storeNumber, records) {
  const rows         = byUserAtStore(records, storeNumber);
  const userOutliers = detectUserOutliers(records, storeNumber);
  const scoreByUser  = scoreUsersAtStore(records, storeNumber);

  if (rows.length === 0) {
    replace(slot,
      h("div", { class: "cd-center cd-muted", style: { padding: "24px" } },
        "No user-level data for this store."),
    );
    return;
  }

  // Index outlier events per user for quick badge rendering.
  const eventsByUser = new Map();
  for (const e of userOutliers) {
    if (!eventsByUser.has(e.userId)) eventsByUser.set(e.userId, []);
    eventsByUser.get(e.userId).push(e);
  }

  // Sort: outlier score desc, then disposal $ desc.
  const sorted = [...rows].sort((a, b) => {
    const sa = scoreByUser.get(a.userId) || 0;
    const sb = scoreByUser.get(b.userId) || 0;
    if (sa !== sb) return sb - sa;
    return b.disposalValue - a.disposalValue;
  });

  // Kick async lookups for any user whose name we don't have yet. The
  // subscribe() listener will re-invoke this fn as names resolve.
  for (const r of sorted) {
    if (!r.userId || r.userId === "(unknown)") continue;
    if (getNameSync(r.userId) === undefined) lookupName(r.userId).catch(() => {});
  }

  const table = h("table", { class: "cd-table cd-table-users" },
    h("thead", null,
      h("tr", null,
        h("th", null, "User"),
        h("th", { class: "cd-table-num" }, "Claims"),
        h("th", { class: "cd-table-num" }, "Disposal $"),
        h("th", { class: "cd-table-num" }, "Donation $"),
        h("th", null, "Flags"),
      ),
    ),
    h("tbody", null,
      ...sorted.map((r) => {
        const name = getNameSync(r.userId);
        const userCell = h("td", null,
          h("div", { style: { fontWeight: "var(--fw-semi)" } }, r.userId),
          name
            ? h("div", { class: "cd-muted", style: { fontSize: "var(--fs-xs)" } }, name)
            : (name === null
                ? h("div", { class: "cd-muted", style: { fontSize: "var(--fs-xs)", fontStyle: "italic" } }, "—")
                : h("div", { class: "cd-muted", style: { fontSize: "var(--fs-xs)", fontStyle: "italic" } }, "…")),
        );
        const flags = eventsByUser.get(r.userId) || [];
        const flagCell = h("td", null,
          ...flags.map((e) =>
            h("span", {
              class: `cd-pill cd-pill-static cd-pill-${e.severity === "Critical" ? "critical" : e.severity === "High" ? "high" : e.severity === "Medium" ? "watch" : "normal"}`,
              title: e.explanation,
              style: { marginRight: "4px" },
            }, `${e.ruleId} ${e.severity}`),
          ),
        );
        return h("tr", null,
          userCell,
          h("td", { class: "cd-table-num" }, r.total.toLocaleString()),
          h("td", { class: "cd-table-num" }, fmtMoney(r.disposalValue)),
          h("td", { class: "cd-table-num" }, fmtMoney(r.donationValue)),
          flagCell,
        );
      }),
    ),
  );
  replace(slot, h("div", { style: { overflowX: "auto" } }, table));
}

// ── CVP performance panel ────────────────────────────────────
// Renders the headline sell-through % + this-window breakdown + an 8-week
// trend list. Headline numbers honour the user's date filter so they line
// up with the Sell-Through column in the Store Comparison table; the trend
// list is unconditional (8-week Hoops history is the whole point of the
// strip — windowing it would defeat the trend signal).
function buildCvpPanel(cvp, storeNumber, dateRange, fetchedAt) {
  const win = cvpForWindow(cvp, dateRange, fetchedAt);
  // Fall back to the latest-week snapshot when there's no filter applied at
  // all (cold render / no records loaded). Keeps the panel useful in edge
  // cases instead of showing "0%".
  const stRate     = win && win.weeksUsed > 0 ? win.sellThrough : (cvp.sellThrough || 0);
  const totalQty   = win && win.weeksUsed > 0 ? win.cvpTotalQty : (cvp.cvpTotalQty || 0);
  const salesQty   = win && win.weeksUsed > 0 ? win.cvpSalesQty : (cvp.cvpSalesQty || 0);
  const weeksUsed  = win ? win.weeksUsed : 1;
  const capped     = win ? win.capped : false;
  const noOverlap  = win && win.weeksUsed === 0;

  const tier = sellThroughTier(stRate);
  const cls  = tier === "good"  ? "cd-pill-normal"
             : tier === "amber" ? "cd-pill-watch"
             : "cd-pill-critical";

  const recoveredPct = totalQty > 0 ? fmtPct(salesQty / totalQty) : "—";
  const windowLabel = noOverlap
    ? `Filter window doesn't overlap CVP history`
    : weeksUsed === 1
      ? `Last 1 week`
      : `Last ${weeksUsed} weeks${capped ? " (Hoops 8-week cap)" : ""}`;

  return h("section", { class: "cd-section" },
    h("h3", { class: "cd-section-title", style: { marginBottom: "8px" } }, "CVP Performance"),
    h("div", { class: "cd-card" },
      // Headline metric: sell-through pill + windowed summary
      h("div", { style: { display: "flex", alignItems: "baseline", gap: "12px", flexWrap: "wrap", marginBottom: "12px" } },
        h("span", {
          class: `cd-pill cd-pill-static ${cls}`,
          style: { fontSize: "var(--fs-md)", fontWeight: "var(--fw-semi)" },
        }, `Sell-Through ${recoveredPct}`),
        h("span", { class: "cd-muted", style: { fontSize: "var(--fs-sm)" } },
          noOverlap
            ? windowLabel
            : `${windowLabel} · ${salesQty.toLocaleString()} sold of ${totalQty.toLocaleString()} units`),
      ),
      // Mini stat row — always shows the LATEST week from Hoops because
      // First-CVP'd / Re-CVP'd are weekly-snapshot fields (not summable across
      // weeks in any meaningful way). Total Active and Sold This Wk are
      // labelled "This Wk" to keep that explicit.
      h("div", { class: "cd-grid", style: { gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: "8px", marginBottom: "12px" } },
        cvpMini("First-CVP'd",   cvp.firstCvpQty.toLocaleString()),
        cvpMini("Re-CVP'd",      cvp.cvpToCvpQty.toLocaleString()),
        cvpMini("Total Active",  cvp.cvpTotalQty.toLocaleString()),
        cvpMini("Sold This Wk",  cvp.cvpSalesQty.toLocaleString()),
      ),
      // 8-week trend (oldest first → newest last). Tiny inline list.
      h("div", null,
        h("div", { class: "cd-muted", style: { fontSize: "var(--fs-xs)", marginBottom: "4px" } }, "Last 8 weeks (sell-through %):"),
        h("div", { style: { display: "grid", gridTemplateColumns: `repeat(${Math.max(1, cvp.history.length)},1fr)`, gap: "4px" } },
          ...cvp.history.map((w) => {
            const wTier = sellThroughTier(w.sellThrough);
            const wCls  = wTier === "good"  ? "cd-pill-normal"
                        : wTier === "amber" ? "cd-pill-watch"
                        : "cd-pill-critical";
            return h("div", {
              class: `cd-pill cd-pill-static ${wCls}`,
              style: { textAlign: "center", fontSize: "var(--fs-xs)", padding: "4px 2px" },
              title: `Wk ${w.wmWeekNbr}: ${(w.sellThrough * 100).toFixed(1)}% (${w.cvpSalesQty}/${w.cvpTotalQty})`,
            }, `W${w.wmWeekNbr}\n${(w.sellThrough * 100).toFixed(0)}%`);
          }),
        ),
      ),
    ),
  );
}

function cvpMini(label, value) {
  return h("div", { class: "cd-card", style: { padding: "8px 10px" } },
    h("div", { class: "cd-card-title", style: { fontSize: "var(--fs-xs)" } }, label),
    h("div", { style: { fontSize: "var(--fs-base)", fontWeight: "var(--fw-semi)", marginTop: "2px" } }, value),
  );
}
