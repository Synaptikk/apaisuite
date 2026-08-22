// modules/metricshot/lib/render_card.js
//
// Renders the VizPick Backroom Health card as SVG, reproducing the real
// Tableau dashboard panel this used to screenshot via CDP. Geometry, colours
// and the right-side legend text were measured pixel-by-pixel off a real
// export of that panel (696x284 — see the user-supplied reference image used
// 2026-08-20; a PREVIOUS pass measured only 980x614 off a DIFFERENT, partial
// capture that didn't include the legend panel at all, which is why it was
// missing here for a while):
//
//   background #FFFFFF   blue #0C61B2   green #23A730   black #000000
//
// The dashboard's top-left period dropdown is deliberately not reproduced: it
// is a Tableau control, not data, and a picture of a dropdown nobody can click
// is just noise in a chat post.
//
// Colour rule, read off the same capture: a ring with a goal is GREEN at or
// above it and BLACK below it — there is no amber middle band. Rings with no
// goal (the composite and the department rings) are blue and are never judged.
//
// FIXED SLOTS, NOT INDEXED. Every dept ring and goal ring is a NAMED slot
// (Fresh/F&C/GM; Cases/Locations/Picks/Overstock) that always renders — track,
// label, and goal text — with "—" standing in for a missing value. The prior
// design rendered whatever was in `metrics`/`deptRings` positionally, so a run
// with no ring data (health/metrics/deptRings all empty — the normal case
// whenever the headless VizPick export is the only source, since it can't
// reach the donut-health sheets) posted a card with the header and one empty
// ring and NOTHING else: no legend, no goal grid, no dept rings — a "blank
// screenshot" from the user's perspective. Matching data by label to a fixed
// template means the legend and every ring slot are always visible even when
// live numbers are missing.
//
// The right-side legend text (title + four goal/weight descriptions) is
// static dashboard chrome, not live data — it never varies per store or per
// run, so it's hardcoded here rather than threaded through from capture data.
//
// NO CSS custom properties and no classes in here, deliberately. This SVG is
// rasterised in an offscreen document with no stylesheet attached, so var()
// would have nothing to resolve against and every colour would fall back to
// black. It also posts onto white in Workvivo regardless of the viewer's
// theme, which is why it does not follow the app's dark mode.

const C = {
  bg:      "#FFFFFF",
  blue:    "#0C61B2",
  green:   "#23A730",
  black:   "#000000",
  track:   "#D9D9D9",
  ink:     "#000000",
  grey:    "#7F7F7F",
  white:   "#FFFFFF",
};

const FONT = "Bogle, 'Helvetica Neue', Helvetica, Arial, sans-serif";

// Main panel is an exact-size reproduction of the reference capture
// (696x284). A slim footer band is appended below it for the store/timestamp
// provenance stamp — not on the real dashboard, but a posted image with no
// provenance is hard to act on. Keeping it OUT of the reproduced region means
// the 0..284 area matches the reference pixel-for-pixel in proportion.
const MAIN_W = 696;
const MAIN_H = 284;
const FOOTER_H = 18;
const W = MAIN_W;
const H = MAIN_H + FOOTER_H;
const HEADER_H = 32;

// Measured centres from the reference capture (696x284).
const BIG  = { cx: 94, cy: 118, outer: 80, thick: 14 };
const DEPT = { cy: 228, xs: [29, 94, 158], outer: 19, thick: 5 };
const GRID = { xs: [259, 376], ys: [97, 218], outer: 56, thick: 8 };

// Fixed slots — see the module header for why these are name-matched rather
// than positional. Order here is the reproduced dashboard's own order.
const DEPT_SLOTS = ["Fresh", "F&C", "GM"];
const METRIC_SLOTS = [
  { label: "Cases",     goal: 95 },
  { label: "Locations", goal: 95 },
  { label: "Picks",     goal: 90 },
  { label: "Overstock", goal: 90 },
];

// The legend panel's four rows, in the same order as METRIC_SLOTS. Static
// dashboard text — see the module header.
const LEGEND_ROWS = [
  { desc: "Cases Seen / Cases Expected",             goal: "Goal > 95% (40% wt.)" },
  { desc: "Locations Seen / Locations Expected",     goal: "Goal > 95% (10% wt.)" },
  { desc: "On Hand Picks / Suggested Picks",         goal: "Goal 90% (30% wt.)" },
  { desc: "Stocking Exceptions / Stocking Baseline", goal: "Goal >90% (20% wt.)" },
];
const LEGEND_TITLE = "VizPick Health Metric";
const LEGEND_X = 462;
const LEGEND_TITLE_Y = 56;
const LEGEND_ROW_Y0 = 93;      // first bold description baseline
const LEGEND_ROW_STEP = 50;    // vertical gap between rows (measured)
const LEGEND_GOAL_DY = 17;     // gap from bold description to its goal line

const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const num = (v) => (Number.isFinite(v) ? v : null);

// Truncate BEFORE escaping. Slicing escaped text splits entities — a label
// containing "&" became "…&a", which is malformed XML, and an SVG that fails
// to parse rasterises to nothing at all.
const truncate = (s, n) => {
  const t = String(s ?? "");
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

const text = (x, y, s, { size = 16, weight = 400, fill = C.ink, anchor = "middle" } = {}) =>
  `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="${FONT}" ` +
  `font-size="${size}" font-weight="${weight}" fill="${fill}">${esc(s)}</text>`;

/**
 * One ring. `pct` fills clockwise from twelve o'clock; the remainder shows the
 * track, which is what makes a near-complete ring read at a glance. A null
 * pct still draws the track (empty ring), so a missing value reads as
 * "no data yet" rather than as an invisible slot.
 */
function ring(cx, cy, outer, thick, pct, color) {
  const r = outer - thick / 2;
  const circ = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(1, (num(pct) ?? 0) / 100));
  const on = circ * frac;
  return (
    `<circle cx="${cx}" cy="${cy}" r="${r.toFixed(1)}" fill="none" ` +
      `stroke="${C.track}" stroke-width="${thick}"/>` +
    (frac > 0
      ? `<circle cx="${cx}" cy="${cy}" r="${r.toFixed(1)}" fill="none" stroke="${color}" ` +
        `stroke-width="${thick}" stroke-dasharray="${on.toFixed(1)} ${(circ - on).toFixed(1)}" ` +
        `transform="rotate(-90 ${cx} ${cy})"/>`
      : "")
  );
}

// Green at or above goal, black below. Blue when there is no goal to judge.
function bandColor(value, goal) {
  if (goal == null || !Number.isFinite(goal)) return C.blue;
  if (!Number.isFinite(value)) return C.blue;
  return value >= goal ? C.green : C.black;
}

// Case-insensitive label lookup — matches a fixed slot name against whatever
// the caller supplied, so { label: "cases" } or { label: "Cases" } both hit
// the "Cases" slot. Returns null (never throws) when nothing matches, which
// the caller renders as an empty ring + "—" rather than skipping the slot.
function findByLabel(list, label) {
  const wanted = label.toLowerCase();
  return (list || []).find((x) => String(x?.label ?? "").trim().toLowerCase() === wanted) || null;
}

// Accepts either the dashboard shape or the older parsed-export shape, so a
// caller that has not been updated still renders something rather than throwing.
function normalise(input, meta) {
  const src = input || {};
  if (Number.isFinite(src.health) || Array.isArray(src.metrics)) {
    return {
      health: num(src.health),
      metrics: src.metrics || [],
      deptRings: src.deptRings || [],
    };
  }
  // Legacy: derive what we can from a department/location export.
  const depts = src.departmentBreakout || [];
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const pickAvg = avg(depts.map((d) => num(d.pickPct)).filter(Number.isFinite));
  return {
    health: num(meta?.health) ?? null,
    metrics: [{ label: "Picks", value: pickAvg, goal: 90 }],
    deptRings: [],
  };
}

/**
 * @returns {{svg:string,width:number,height:number}}
 */
export function renderMetricCard(input, meta = {}) {
  const { health, metrics, deptRings } = normalise(input, meta);
  const {
    title = "VizPick Backroom Health (Current Day)",
    store = null,
    capturedAt = null,
  } = meta;

  const p = [];
  p.push(`<rect width="${W}" height="${H}" fill="${C.bg}"/>`);

  // ── Header bar ────────────────────────────────────────────────────────────
  p.push(`<rect x="0" y="0" width="${MAIN_W}" height="${HEADER_H}" fill="${C.blue}"/>`);
  p.push(text(MAIN_W / 2, 21, truncate(title, 48), { size: 15, weight: 700, fill: C.white }));

  // ── Composite ring ────────────────────────────────────────────────────────
  p.push(ring(BIG.cx, BIG.cy, BIG.outer, BIG.thick, health, C.blue));
  p.push(text(BIG.cx, 113, Number.isFinite(health) ? Math.round(health) : "—",
    { size: 32, weight: 700 }));
  p.push(text(BIG.cx, 141, "VizPick", { size: 11 }));
  p.push(text(BIG.cx, 158, "Health", { size: 11 }));

  // ── Department rings (no goal — never judged) ─────────────────────────────
  DEPT_SLOTS.forEach((label, i) => {
    const cx = DEPT.xs[i];
    const d = findByLabel(deptRings, label);
    const v = d ? num(d.value) : null;
    p.push(ring(cx, DEPT.cy, DEPT.outer, DEPT.thick, v, C.blue));
    p.push(text(cx, DEPT.cy + 4, Number.isFinite(v) ? Math.round(v) : "—",
      { size: 12, weight: 700 }));
    p.push(text(cx, 273, label, { size: 10, fill: C.grey }));
  });

  // ── Goal grid ─────────────────────────────────────────────────────────────
  METRIC_SLOTS.forEach((slot, i) => {
    const cx = GRID.xs[i % 2];
    const cy = GRID.ys[Math.floor(i / 2)];
    const m = findByLabel(metrics, slot.label);
    const v = m ? num(m.value) : null;
    const goal = m && m.goal != null ? m.goal : slot.goal;
    p.push(ring(cx, cy, GRID.outer, GRID.thick, v, bandColor(v, goal)));
    p.push(text(cx, cy - 6, Number.isFinite(v) ? `${Math.round(v)}%` : "—",
      { size: 22, weight: 700 }));
    p.push(text(cx, cy + 12, slot.label, { size: 11 }));
    p.push(text(cx, cy + 28, `Goal ${goal}%`, { size: 9, fill: C.grey }));
  });

  // ── Right-side legend (static dashboard text) ─────────────────────────────
  p.push(text(LEGEND_X, LEGEND_TITLE_Y, LEGEND_TITLE, { size: 15, weight: 700, fill: C.blue, anchor: "start" }));
  LEGEND_ROWS.forEach((row, i) => {
    const y = LEGEND_ROW_Y0 + i * LEGEND_ROW_STEP;
    p.push(text(LEGEND_X, y, row.desc, { size: 11, weight: 700, anchor: "start" }));
    p.push(text(LEGEND_X, y + LEGEND_GOAL_DY, row.goal, { size: 10, fill: C.grey, anchor: "start" }));
  });

  // ── Footer: store / capture-time provenance (not on the real dashboard) ──
  const stamp = [store ? `Store ${store}` : null, capturedAt].filter(Boolean).join("  ·  ");
  if (stamp) {
    p.push(text(MAIN_W - 8, MAIN_H + 13, stamp, { size: 10, fill: C.grey, anchor: "end" }));
  }

  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${p.join("")}</svg>`,
    width: W,
    height: H,
  };
}
