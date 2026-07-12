// modules/claimsdisposition/components/outlierPanel.js
//
// Full outlier-panel implementation. Mirrors donor
// src/components/OutlierPanel.jsx (286 LOC, the most React-heavy component
// in the donor — useMemo×3, useState×2, useEffect×1 + nested modal with
// Escape-key listener).
//
// State this component owns internally (not in app state):
//   - scope: "ALL" or "<storeNumber>" — narrows which store's events show
//   - showRulesHelp: bool — whether the rules-help modal is open
//
// All other inputs come from state.records + state.filters via update().

import { h, replace } from "../lib/dom.js";
import { detectOutliers } from "../lib/outliers.js";
import { filterRecords } from "../lib/metrics.js";
import { STORE_LIST } from "../data/schema.js";

const SEVERITY_RANK = { Critical: 4, High: 3, Medium: 2, Low: 1 };
const TOP_N = 10;

const BADGE_CLASS = {
  Critical: "cd-pill-critical",
  High:     "cd-pill-high",
  Medium:   "cd-pill-watch",
  Low:      "cd-pill-normal",
};

const TYPE_COLOR = {
  Disposal: "var(--apai-blue)",
  Donation: "var(--apai-yellow)",
};

// Exported because the PDF generator (lib/pdf.js::buildDocDefinition) also
// uses this list for the methodology page — one source of truth for rule
// descriptions. Keep `id` stable across edits; rule events reference it.
// R5 (hour-of-day disposal spike) was removed 2026-05-31 — it generated
// almost-pure noise because every store legitimately spikes at open/close.
export const RULE_REFERENCE = [
  { id: "R1", title: "Store disposal $ above market",          trigger: "Store total disposal $ > market mean + 2 SD",                            catches: "Store is disposing far more value than peers in the market." },
  { id: "R2", title: "Store donation $ above market",          trigger: "Store total donation $ > market mean + 2 SD",                            catches: "Store is donating far more value than peers in the market." },
  { id: "R3", title: "Single-day disposal spike",              trigger: "Day's disposal $ > store's daily mean + 2 SD",                           catches: "One day at the store had a disposal value that stands out from its own baseline." },
  { id: "R4", title: "Single-day donation spike",              trigger: "Day's donation $ > store's daily mean + 2 SD",                           catches: "One day at the store had a donation value that stands out from its own baseline." },
  { id: "R6", title: "Disposal rate skew vs market",           trigger: "Store disposal rate > 1.5× the market disposal rate (≥ 200 claims)",     catches: "Store leans on Disposal more often than the rest of the market." },
  { id: "R7", title: "Donations ramping vs baseline",          trigger: "Last 7 days donation $ > 2× the prior baseline period",                  catches: "Donation activity is climbing quickly compared to the store's recent history." },
  { id: "R8",  title: "Disposal concentrated in few hands",     trigger: "Top 20% of disposal-handling associates account for ≥ 70% of store disposal $ (≥ 5 active users)", catches: "A small subset of the store's associates handle the majority of disposal volume — possible role misuse or collusion." },
  { id: "R9",  title: "Sparse disposal-handling staff",         trigger: "Store unique disposal-user count ≥ 1.5 SD below market mean (≥ 200 disposals)",                    catches: "Store processes a high volume of disposals with unusually few associates — could be access-control gap or undertraining." },
  { id: "R10", title: "Low CVP sell-through",                   trigger: "Store's weekly CVP sell-through < 15% with ≥ 100 active CVP units",                                catches: "Items marked down to clearance (CVP) are being disposed instead of sold — the back-end half of the 'CVP then dispose' pattern." },
];

// User-level rules. Surface as badges in the per-store drawer's user table.
export const USER_RULE_REFERENCE = [
  { id: "U1", title: "Associate disposal $ above peers",       trigger: "User disposal $ > store user-mean + 2 SD",                                catches: "An individual at this store disposes far more than coworkers there." },
  { id: "U2", title: "Associate donation $ above peers",       trigger: "User donation $ > store user-mean + 2 SD",                                catches: "An individual at this store donates far more than coworkers there." },
  { id: "U3", title: "Associate dominates store disposal $",   trigger: "User accounts for ≥ 40% of store disposal $ (≥ 50 records)",              catches: "Single associate responsible for two-fifths or more of the store's disposal value." },
  { id: "U4", title: "Top-3 disposer vs store median",         trigger: "User in top 3 disposal $ AND ≥ 3× store median (≥ 5 disposals)",          catches: "Catches standout disposers even at small stores where z-scores are unreliable." },
];

export const SEVERITY_LADDER = [
  { z: "≥ 4",   label: "Critical" },
  { z: "≥ 3",   label: "High" },
  { z: "≥ 2.5", label: "Medium" },
  { z: "≥ 2",   label: "Low" },
];

export function createOutlierPanel({ onSelectStore } = {}) {
  let scope = "ALL";
  let lastState = null;

  // ── DOM scaffolding (stable refs, content re-rendered in render()) ──
  const countSub  = h("div", { class: "cd-section-sub" });
  const scopeSel  = h("select", { class: "cd-select", style: { minWidth: "200px" } });
  const jumpBtn   = h("button", { type: "button", class: "cd-btn cd-btn-xs", style: { display: "none" } });
  const list      = h("div", { class: "cd-outlier-list" });

  scopeSel.addEventListener("change", () => {
    scope = scopeSel.value;
    render();
  });
  jumpBtn.addEventListener("click", () => {
    scope = jumpBtn.dataset.target;
    scopeSel.value = scope;
    render();
  });

  const rulesLink = h("button", {
    type: "button",
    class: "cd-btn cd-btn-xs",
    style: { padding: "2px 8px", color: "var(--apai-blue)", border: "none", background: "transparent", textDecoration: "underline" },
    onClick: () => openRulesModal(),
  }, "Rules R1–R7");

  const root = h("div", { class: "cd-card cd-section" },
    h("div", { class: "cd-section-head" },
      h("div", null,
        h("div", { class: "cd-section-title" }, "Outlier Detection"),
        countSub,
      ),
      h("div", { class: "cd-no-print", style: { display: "flex", alignItems: "flex-end", gap: "12px" } },
        h("div", { class: "cd-field" },
          h("span", { class: "cd-field-label" }, "Store"),
          scopeSel,
        ),
        jumpBtn,
      ),
    ),
    list,
  );

  function severityFloor() {
    return lastState?.filters?.severity ? SEVERITY_RANK[lastState.filters.severity] || 0 : 0;
  }

  function computeEligible() {
    if (!lastState) return [];
    const recs = filterRecords(lastState.records, lastState.filters);
    const all = detectOutliers(recs, lastState.cvpByStore, lastState.filters?.dateRange, lastState.cvpMeta?.fetchedAt);
    const floor = severityFloor();
    return floor ? all.filter((o) => (SEVERITY_RANK[o.severity] || 0) >= floor) : all;
  }

  function countByStore(events) {
    const m = new Map();
    for (const o of events) m.set(o.storeNumber, (m.get(o.storeNumber) || 0) + 1);
    return m;
  }

  function defaultStore(byStore) {
    let best = null, bestCount = -1;
    for (const [sn, c] of byStore.entries()) {
      if (c > bestCount) { bestCount = c; best = sn; }
    }
    return best;
  }

  function renderScopeOptions(eligible, byStore) {
    // Build store options on every render — the multi-store list shifts
    // depending on filters.
    const opts = [
      h("option", { value: "ALL" }, `All stores · ${eligible.length} events`),
    ];
    for (const sn of STORE_LIST) {
      const c = byStore.get(sn) || 0;
      opts.push(h("option", { value: String(sn) }, `Store ${sn} · ${c} event${c === 1 ? "" : "s"}`));
    }
    replace(scopeSel, ...opts);
    // Re-establish the selection (replace() wipes it).
    scopeSel.value = scope;
    // Donor's useEffect: if scope's store has no events, slide back to ALL.
    if (scope !== "ALL" && !byStore.has(Number(scope))) {
      scope = "ALL";
      scopeSel.value = "ALL";
    }
  }

  function renderEventCard(o) {
    const dot = h("span", {
      style: {
        display: "inline-block",
        width: "8px",
        height: "8px",
        borderRadius: "50%",
        background: TYPE_COLOR[o.type] || "#9CA3AF",
      },
    });
    const typeChip = h("span", {
      style: {
        fontSize: "var(--fs-xs)",
        fontWeight: "var(--fw-semi)",
        color: "var(--apai-muted)",
        textTransform: "uppercase",
        letterSpacing: "0.04em",
      },
    }, o.type, h("span", { class: "cd-muted", style: { marginLeft: "8px" } }, `· Store ${o.storeNumber}`));

    const ruleBtn = h("button", {
      type: "button",
      class: "cd-outlier-rule",
      style: { cursor: "pointer", border: "none", textDecoration: "underline", color: "var(--apai-blue)" },
      onClick: (e) => { e.stopPropagation(); openRulesModal(); },
    }, o.ruleId);

    return h("article", {
      class: "cd-card",
      style: { cursor: "pointer", padding: "14px" },
      onClick: () => onSelectStore?.(o.storeNumber),
    },
      h("header", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px", gap: "8px" } },
        h("div", { style: { display: "flex", alignItems: "center", gap: "8px" } }, dot, typeChip),
        h("span", { class: `cd-pill cd-pill-static ${BADGE_CLASS[o.severity]}` }, o.severity),
      ),
      h("div", { class: "cd-outlier-text", style: { marginBottom: "8px" } }, o.explanation),
      h("dl", {
        style: { display: "grid", gridTemplateColumns: "auto 1fr", columnGap: "16px", rowGap: "4px", fontSize: "var(--fs-xs)", margin: 0 },
      },
        h("dt", { class: "cd-muted" }, "Date"),
        h("dd", { style: { textAlign: "right", margin: 0 } },
          o.dateLabel + (o.timeWindow ? ` · ${o.timeWindow}` : "")),
        h("dt", { class: "cd-muted" }, "Metric"),
        h("dd", { style: { textAlign: "right", margin: 0 } }, o.metric),
        h("dt", { class: "cd-muted" }, "Expected"),
        h("dd", { style: { textAlign: "right", margin: 0 } }, o.expectedRange),
        h("dt", { class: "cd-muted" }, "Actual"),
        h("dd", { style: { textAlign: "right", margin: 0, fontWeight: "var(--fw-semi)" } }, o.actualValue),
        h("dt", { class: "cd-muted" }, "Rule"),
        h("dd", { style: { textAlign: "right", margin: 0 } }, ruleBtn),
      ),
    );
  }

  function render() {
    if (!lastState) return;
    const eligible = computeEligible();
    const byStore = countByStore(eligible);
    renderScopeOptions(eligible, byStore);

    const source = scope === "ALL"
      ? eligible
      : eligible.filter((o) => o.storeNumber === Number(scope));
    const displayed = source.slice(0, TOP_N);
    const totalForScope = scope === "ALL" ? eligible.length : (byStore.get(Number(scope)) || 0);

    // Count sub-line + Rules link
    replace(countSub,
      `Top ${Math.min(TOP_N, totalForScope)} of ${totalForScope} event${totalForScope === 1 ? "" : "s"} · `,
      rulesLink,
    );

    // Jump-to-top-store button (shown when ALL is active and a leader exists)
    const top = defaultStore(byStore);
    if (top != null && scope === "ALL") {
      jumpBtn.style.display = "";
      jumpBtn.textContent = `Jump to top store (${top})`;
      jumpBtn.dataset.target = String(top);
    } else {
      jumpBtn.style.display = "none";
    }

    // Event list (or empty state)
    if (displayed.length === 0) {
      replace(list,
        h("div", { class: "cd-outlier-empty" },
          "No outliers detected for the current selection.",
        ),
      );
    } else {
      const grid = h("div", { class: "cd-grid", style: { gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))" } });
      for (const o of displayed) grid.appendChild(renderEventCard(o));
      replace(list, grid);
    }
  }

  // ── Rules help modal ──────────────────────────────────────────
  let modalEl = null;
  let escListener = null;

  function openRulesModal() {
    if (modalEl) return;
    const close = () => closeRulesModal();
    escListener = (ev) => { if (ev.key === "Escape") close(); };
    window.addEventListener("keydown", escListener);

    const dialog = h("div", { class: "cd-modal", onClick: (e) => e.stopPropagation() },
      h("div", {
        class: "cd-modal-header",
        style: { background: "var(--apai-blue)", color: "#FFFFFF", borderRadius: "var(--rad-lg) var(--rad-lg) 0 0" },
      },
        h("div", null,
          h("h2", { class: "cd-modal-title" }, "Outlier Detection Rules"),
          h("p", { class: "cd-muted", style: { color: "rgba(255,255,255,0.8)", margin: "4px 0 0", fontSize: "var(--fs-sm)" } },
            "How each rule decides an event is unusual"),
        ),
        h("button", {
          type: "button",
          class: "cd-drawer-close",
          style: { color: "rgba(255,255,255,0.8)", fontSize: "24px" },
          "aria-label": "Close",
          onClick: close,
        }, "×"),
      ),
      h("div", { class: "cd-modal-body" },
        h("ol", { style: { display: "flex", flexDirection: "column", gap: "12px", padding: 0, listStyle: "none", margin: 0 } },
          ...RULE_REFERENCE.map((r) =>
            h("li", { class: "cd-card", style: { padding: "12px" } },
              h("div", { style: { display: "flex", alignItems: "baseline", gap: "8px" } },
                h("span", {
                  style: {
                    background: "var(--apai-blue)",
                    color: "#FFFFFF",
                    fontSize: "var(--fs-xs)",
                    fontWeight: "var(--fw-bold)",
                    padding: "2px 8px",
                    borderRadius: "4px",
                    minWidth: "32px",
                    textAlign: "center",
                  },
                }, r.id),
                h("span", { style: { fontWeight: "var(--fw-semi)" } }, r.title),
              ),
              h("dl", {
                style: { display: "grid", gridTemplateColumns: "auto 1fr", columnGap: "12px", rowGap: "4px", marginTop: "8px", fontSize: "var(--fs-xs)" },
              },
                h("dt", { class: "cd-muted", style: { fontWeight: "var(--fw-medium)" } }, "Catches"),
                h("dd", { style: { margin: 0 } }, r.catches),
                h("dt", { class: "cd-muted", style: { fontWeight: "var(--fw-medium)" } }, "Trigger"),
                h("dd", { style: { margin: 0, fontFamily: "var(--font-mono)" } }, r.trigger),
              ),
            ),
          ),
        ),
        // ── User-level rules section ──
        h("section", { style: { marginTop: "20px" } },
          h("h3", { style: { fontSize: "var(--fs-md)", fontWeight: "var(--fw-semi)", margin: "0 0 8px" } },
            "Per-associate rules (badges in the store drawer)"),
          h("ol", { style: { display: "flex", flexDirection: "column", gap: "12px", padding: 0, listStyle: "none", margin: 0 } },
            ...USER_RULE_REFERENCE.map((r) =>
              h("li", { class: "cd-card", style: { padding: "12px" } },
                h("div", { style: { display: "flex", alignItems: "baseline", gap: "8px" } },
                  h("span", {
                    style: {
                      background: "var(--apai-yellow)",
                      color: "var(--apai-ink)",
                      fontSize: "var(--fs-xs)",
                      fontWeight: "var(--fw-bold)",
                      padding: "2px 8px",
                      borderRadius: "4px",
                      minWidth: "32px",
                      textAlign: "center",
                    },
                  }, r.id),
                  h("span", { style: { fontWeight: "var(--fw-semi)" } }, r.title),
                ),
                h("dl", {
                  style: { display: "grid", gridTemplateColumns: "auto 1fr", columnGap: "12px", rowGap: "4px", marginTop: "8px", fontSize: "var(--fs-xs)" },
                },
                  h("dt", { class: "cd-muted", style: { fontWeight: "var(--fw-medium)" } }, "Catches"),
                  h("dd", { style: { margin: 0 } }, r.catches),
                  h("dt", { class: "cd-muted", style: { fontWeight: "var(--fw-medium)" } }, "Trigger"),
                  h("dd", { style: { margin: 0, fontFamily: "var(--font-mono)" } }, r.trigger),
                ),
              ),
            ),
          ),
        ),
        h("section", {
          class: "cd-card",
          style: { padding: "12px", background: "var(--apai-bg-soft)", marginTop: "16px" },
        },
          h("h3", { style: { fontSize: "var(--fs-md)", fontWeight: "var(--fw-semi)", margin: "0 0 8px" } },
            "Severity ladder (z-score based rules)"),
          h("div", {
            class: "cd-grid",
            style: { gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: "8px" },
          },
            ...SEVERITY_LADDER.map((s) =>
              h("div", {
                class: "cd-card",
                style: { padding: "8px", textAlign: "center" },
              },
                h("span", { class: `cd-pill cd-pill-static ${BADGE_CLASS[s.label]}` }, s.label),
                h("div", { class: "cd-muted", style: { fontSize: "var(--fs-xs)", fontFamily: "var(--font-mono)", marginTop: "4px" } },
                  `z ${s.z}`),
              ),
            ),
          ),
          h("p", { class: "cd-muted", style: { fontSize: "var(--fs-xs)", marginTop: "12px", lineHeight: "var(--lh-base)" } },
            "R6 and R7 use ratio thresholds rather than z-scores (e.g. > 2× baseline = High, otherwise Medium). Each event's severity rolls up into the store's composite outlier score, which drives the Risk pill in the comparison table: Normal (0–1), Watch (2–3), High (4–6), Critical (7+)."),
        ),
      ),
    );

    modalEl = h("div", {
      class: "cd-modal-backdrop cd-no-print",
      onClick: close,
      role: "dialog",
      "aria-modal": "true",
    }, dialog);
    document.body.appendChild(modalEl);
  }

  function closeRulesModal() {
    if (escListener) {
      window.removeEventListener("keydown", escListener);
      escListener = null;
    }
    modalEl?.remove();
    modalEl = null;
  }

  function update(state) {
    lastState = state;
    render();
  }

  return {
    root,
    update,
    destroy() {
      closeRulesModal();
    },
  };
}

// Exported so view.js can mirror the same filtering logic when computing
// the count badge in SummaryCards (avoids running detectOutliers twice).
export function filteredOutlierCount(state) {
  const recs = filterRecords(state.records, state.filters);
  const all  = detectOutliers(recs, state.cvpByStore, state.filters?.dateRange, state.cvpMeta?.fetchedAt);
  if (!state.filters?.severity) return all.length;
  const floor = SEVERITY_RANK[state.filters.severity] || 0;
  return all.filter((o) => (SEVERITY_RANK[o.severity] || 0) >= floor).length;
}
