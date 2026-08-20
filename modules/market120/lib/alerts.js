// modules/market120/lib/alerts.js
//
// Pure DOM alert engine — no network, no storage reads.
// Given a KPI snapshot (from get_state), compute warn/crit findings against
// hard-coded thresholds. In a future revision the thresholds move to
// chrome.storage.sync via a Settings panel; the compute() signature stays
// the same.
//
// Rules:
//   - ISA and Clearance/Deleted are separate metric families — never merge.
//   - A metric with a null value is silently skipped (not an alert).
//   - Absolute-value comparison used for shrink metrics (negative numbers).

// ── THRESHOLDS ──────────────────────────────────────────────────────
// Ported from Trey/src/alerts.js (Phase 1 Stage 1 constants).
// Rationale for each threshold is in the comment above it.
export const THRESHOLDS = {
  // ── Clearance / Deleted family ──────────────────────────────
  // Deleted units as % of Perpetual Inventory. Sample: 2.0% for Store 1458
  // (APSCPI 2026-07-23). Warn just above sample; crit at "clearly elevated".
  deletedPctOfPI: {
    family: "cd",
    label: "Deleted % of PI",
    kpi: "deleted_pct_pi",           // key path within state.clearance.kpis
    warn: 2.0, crit: 3.5, unit: "%",
  },

  // Deleted-on-Clearance $ as % of total Clearance $. Sample: ~12%.
  // NOTE: derived — needs both deleted_on_clearance_dollars AND clearance_dollars.
  deletedOnClrPct: {
    family: "cd",
    label: "Deleted-on-Clearance % of Clearance $",
    kpi: "__derived__",
    derive: (cd) => (cd?.clearance_dollars && cd?.deleted_on_clearance_dollars)
      ? (cd.deleted_on_clearance_dollars / cd.clearance_dollars) * 100
      : null,
    warn: 10.0, crit: 20.0, unit: "%",
  },

  // ── ISA family ──────────────────────────────────────────────
  // ISA Total Adjusted $ (absolute value). Sample $673K for one store; the
  // Market 120 aggregate is larger. Set on order-of-magnitude.
  isaAdjDollars: {
    family: "isa",
    label: "ISA Total Adjusted $ (abs)",
    kpi: "isa_total_adjusted_dollars",
    transform: (v) => (typeof v === "number") ? Math.abs(v) : null,
    warn: 500_000, crit: 800_000, unit: "$",
  },

  // Backroom Adjustments — Stolen $ (weekly). Sample: $46.3K across
  // ~46 weeks ≈ $1K/wk; alert at 2× that.
  // Value coming in is already the trailing period total (not weekly);
  // for MVP we compare the raw absolute value; refine later.
  stolenAdj: {
    family: "isa",
    label: "Stolen Adj $ (abs, trailing)",
    kpi: "stolen_adjusted_dollars",
    transform: (v) => (typeof v === "number") ? Math.abs(v) : null,
    warn: 10_000, crit: 30_000, unit: "$",
  },
};

// ── compute(state) → Alert[] ────────────────────────────────────────
export function computeAlerts(state) {
  const alerts = [];
  const cd = state?.clearance?.kpis || null;
  const isa = state?.isa?.kpis || null;

  // Stub payloads from Pass 1 must never fire (or silence) alerts — treat
  // them as no-data. Stub is marked with `stub: true`.
  const cdReal = (cd && !cd.stub) ? cd : null;
  const isaReal = (isa && !isa.stub) ? isa : null;

  for (const [id, spec] of Object.entries(THRESHOLDS)) {
    let value;
    if (spec.derive) {
      value = spec.family === "cd" ? spec.derive(cdReal)
             : spec.family === "isa" ? spec.derive(isaReal)
             : null;
    } else {
      const source = spec.family === "cd" ? cdReal : spec.family === "isa" ? isaReal : null;
      value = source ? source[spec.kpi] : null;
      if (spec.transform) value = spec.transform(value);
    }
    if (value == null || !Number.isFinite(value)) continue;
    let sev = null;
    if (value >= spec.crit) sev = "crit";
    else if (value >= spec.warn) sev = "warn";
    if (sev) {
      alerts.push({
        id, sev,
        family: spec.family,
        label: spec.label,
        value,
        threshold: sev === "crit" ? spec.crit : spec.warn,
        unit: spec.unit,
      });
    }
  }
  return alerts;
}

// Return true if we have at least one non-stub KPI to alert against.
export function hasRealKpis(state) {
  const cd = state?.clearance?.kpis;
  const isa = state?.isa?.kpis;
  const cdReal = !!(cd && !cd.stub && Object.entries(cd).some(([k, v]) => k !== "capturedAt" && k !== "stub" && typeof v === "number"));
  const isaReal = !!(isa && !isa.stub && Object.entries(isa).some(([k, v]) => k !== "capturedAt" && k !== "stub" && typeof v === "number"));
  return cdReal || isaReal;
}

// ── format helpers ──────────────────────────────────────────────────
export function fmtAlertValue(v, unit) {
  if (unit === "$" || unit === "$/wk") return "$" + Math.round(v).toLocaleString("en-US");
  if (unit === "%" || unit === "% WoW") return v.toLocaleString("en-US", { maximumFractionDigits: 1 }) + "%";
  return v.toLocaleString("en-US") + " " + unit;
}
