// modules/claimsdisposition/components/categoryPanel.js
//
// Store categories: one card each for Food & Consumables, Fresh and GM
// (Ops Portal's split, lib/categories.js) with claims totals and CVP
// adherence, then the associates whose CVP-recommended claims went anywhere
// but CVP, ranked by missed units. Honours the global filter bar; the
// category chips only steer the associate table.

import { h, replace } from "../lib/dom.js";
import { filterRecords, byCategory, cvpAssociates, fmtMoney, fmtPct } from "../lib/metrics.js";
import { CATEGORIES, categoryLabel } from "../lib/categories.js";
import { opsCvpWeek } from "../lib/cvp.js";

const TOP_N = 15;

// Adherence tiers for the pills. Ops Portal shows no target, so these are
// the dashboard's own bands.
function adherenceClass(rate) {
  if (rate == null) return "cd-pill-static";
  if (rate >= 0.7) return "cd-pill-normal";
  if (rate >= 0.5) return "cd-pill-watch";
  return "cd-pill-critical";
}

const fmtUnits = (n) => Math.round(n).toLocaleString();

export function createCategoryPanel() {
  let activeCat = null;      // null = all categories
  let showAll = false;
  let lastState = null;

  const cards = h("div", { class: "cd-grid cd-cat-grid" });
  const chips = h("div", { class: "cd-cat-chips" });
  const tableWrap = h("div", { style: { overflowX: "auto" } });
  const note = h("div", { class: "cd-section-sub" });

  const root = h("div", null,
    h("div", { class: "cd-card cd-section" },
      h("div", { class: "cd-section-head" },
        h("div", null,
          h("div", { class: "cd-section-title" }, "Store Categories"),
          h("div", { class: "cd-section-sub" },
            "Departments grouped as Ops Portal does. F&C here excludes Fresh (Ops Portal's F&C tile includes it)."),
        ),
      ),
      cards,
    ),
    h("div", { class: "cd-card cd-section" },
      h("div", { class: "cd-section-head" },
        h("div", null,
          h("div", { class: "cd-section-title" }, "Top Associates Affecting CVP"),
          h("div", { class: "cd-section-sub" },
            "Claims recommended CVP that the associate sent elsewhere. Missed units pull CVP adherence down."),
        ),
        chips,
      ),
      tableWrap,
      note,
    ),
  );

  function categoryCard(cat, row, ops, opsNow) {
    const r = row || {};
    const adh = r.adherence ?? null;
    return h("div", { class: "cd-card cd-cat-card" },
      h("div", { class: "cd-cat-card-head" },
        h("div", { class: "cd-card-title" }, cat.label),
        h("span", { class: `cd-pill cd-pill-static ${adherenceClass(adh)}`, title: "CVP adherence from these claims: CVP'd units / CVP-recommended units" },
          adh == null ? "No CVP recs" : `CVP adh ${fmtPct(adh)}`),
      ),
      h("div", { class: "cd-stat" }, (r.total || 0).toLocaleString()),
      h("div", { class: "cd-stat-sub" }, "claims"),
      h("dl", { class: "cd-cat-list" },
        line("Disposals", `${(r.disposalCount || 0).toLocaleString()} · ${fmtMoney(r.disposalValue || 0)}`),
        line("Donations", `${(r.donationCount || 0).toLocaleString()} · ${fmtMoney(r.donationValue || 0)}`),
        line("CVP'd", (r.cvpCount || 0).toLocaleString()),
        line("CVP recommended", `${fmtUnits(r.cvpRecUnits || 0)} units`),
        line("CVP missed", `${fmtUnits(r.cvpMissUnits || 0)} units · ${fmtMoney(r.missedRetail || 0)} retail`),
        line("Claim cost", fmtMoney(r.totalValue || 0)),
      ),
      ops || opsNow
        ? h("div", { class: "cd-cat-ops", title: "Ops Portal CVP for the selected stores, weighted by CVP units" },
            h("span", { class: "cd-muted" }, "Ops Portal "),
            ops ? `${ops.week}: adh ${pct1(ops.adherencePct)} · sell-thru ${pct1(ops.sellThruPct)}` : "",
            opsNow ? h("span", { class: "cd-muted" }, `  ·  ${opsNow.week} so far: adh ${pct1(opsNow.adherencePct)}`) : null,
          )
        : h("div", { class: "cd-cat-ops cd-muted" }, "Ops Portal CVP not in this pull (Pull again to fetch)"),
    );
  }

  function renderChips() {
    const opts = [{ id: null, short: "All" }, ...CATEGORIES.filter((c) => c.id !== "other")];
    replace(chips, ...opts.map((c) =>
      h("button", {
        type: "button",
        class: `cd-pill ${activeCat === c.id ? "is-active" : ""}`,
        onClick: () => { activeCat = c.id; showAll = false; render(); },
      }, c.short)));
  }

  function renderTable(recs) {
    const rows = cvpAssociates(recs, activeCat);
    const shown = showAll ? rows : rows.slice(0, TOP_N);
    if (!rows.length) {
      replace(tableWrap, h("div", { class: "cd-muted cd-center", style: { padding: "16px" } },
        "No missed CVP recommendations in this selection."));
      replace(note);
      return;
    }
    const head = ["#", "Associate", "Store", "Missed units", "Retail at stake", "CVP recs", "Adherence", "Sent instead", "Top dept", "Share of store misses"];
    const numeric = new Set([0, 3, 4, 5, 6, 9]);
    const table = h("table", { class: "cd-table cd-table-users" },
      h("thead", null, h("tr", null, ...head.map((t, i) => h("th", { class: numeric.has(i) ? "cd-table-num" : "" }, t)))),
      h("tbody", null, ...shown.map((u, i) => h("tr", null,
        h("td", { class: "cd-table-num" }, i + 1),
        h("td", null, h("strong", null, u.userId)),
        h("td", null, `#${u.storeNumber}`),
        h("td", { class: "cd-table-num" }, fmtUnits(u.cvpMissUnits)),
        h("td", { class: "cd-table-num" }, fmtMoney(u.missedRetail)),
        h("td", { class: "cd-table-num" }, fmtUnits(u.cvpRecUnits)),
        h("td", { class: "cd-table-num" },
          h("span", { class: `cd-pill cd-pill-static ${adherenceClass(u.adherence)}` }, fmtPct(u.adherence ?? 0))),
        h("td", null, u.topInstead ? `${u.topInstead.key} (${fmtUnits(u.topInstead.units)})` : "—"),
        h("td", null, u.topDept ? u.topDept.key : "—"),
        h("td", { class: "cd-table-num" }, fmtPct(u.missShare)),
      ))),
    );
    replace(tableWrap, table);

    const totalMiss = rows.reduce((s, u) => s + u.cvpMissUnits, 0);
    const topMiss = rows.slice(0, TOP_N).reduce((s, u) => s + u.cvpMissUnits, 0);
    replace(note,
      `${rows.length.toLocaleString()} associates missed ${fmtUnits(totalMiss)} CVP units${activeCat ? ` in ${categoryLabel(activeCat)}` : ""}; `,
      `the top ${Math.min(TOP_N, rows.length)} account for ${fmtPct(totalMiss ? topMiss / totalMiss : 0)}. `,
      rows.length > TOP_N
        ? h("button", { type: "button", class: "cd-btn cd-btn-link", onClick: () => { showAll = !showAll; render(); } },
            showAll ? `Show top ${TOP_N}` : `Show all ${rows.length}`)
        : null,
    );
  }

  function render() {
    if (!lastState) return;
    const recs = filterRecords(lastState.records, lastState.filters);
    const rollup = byCategory(recs);
    const stores = lastState.filters?.storeNumbers?.length
      ? lastState.filters.storeNumbers
      : lastState.realStoreNumbers || [];
    const ops = lastState.cvpCategories;
    const shownCats = CATEGORIES.filter((c) => c.id !== "other" || rollup.other?.total);
    replace(cards, ...shownCats.map((c) => c.id === "other"
      ? otherCard(rollup.other)
      : categoryCard(c, rollup[c.id], opsCvpWeek(ops, stores, c.id, -1), opsCvpWeek(ops, stores, c.id, 0))));
    renderChips();
    renderTable(recs);
  }

  function update(state) {
    lastState = state;
    render();
  }

  return { root, update, destroy() {} };
}

function otherCard(r) {
  return h("div", { class: "cd-card cd-cat-card cd-cat-card-other" },
    h("div", { class: "cd-card-title" }, "Other"),
    h("div", { class: "cd-stat" }, (r.total || 0).toLocaleString()),
    h("div", { class: "cd-stat-sub" }, "claims in Home, Fashion, Beauty, H&W, Fuel and unassigned depts (no Ops Portal tile)"),
    h("dl", { class: "cd-cat-list" },
      line("Disposal $", fmtMoney(r.disposalValue || 0)),
      line("CVP missed", `${fmtUnits(r.cvpMissUnits || 0)} units`),
    ),
  );
}

function line(label, value) {
  return [h("dt", null, label), h("dd", null, value)];
}

function pct1(v) {
  return v == null ? "—" : `${v.toFixed(1)}%`;
}
