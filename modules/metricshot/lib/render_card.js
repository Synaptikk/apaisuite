// modules/metricshot/lib/render_card.js
//
// Renders the VizPick Backroom Health card as SVG, reproducing the Tableau
// dashboard this used to screenshot via CDP. Geometry and colours were
// measured off a capture of the real dashboard (980x614) rather than eyeballed:
//
//   background #FFFFFF   blue #0B61B2   green #25A738   black #000000
//   track #D9D9D9
//
// The dashboard's top-left period dropdown is deliberately not reproduced: it
// is a Tableau control, not data, and a picture of a dropdown nobody can click
// is just noise in a chat post.
//
// Colour rule, read off the same capture: a ring with a goal is GREEN at or
// above it and BLACK below it — there is no amber middle band. Rings with no
// goal (the composite and the department rings) are blue and are never judged.
//
// NO CSS custom properties and no classes in here, deliberately. This SVG is
// rasterised in an offscreen document with no stylesheet attached, so var()
// would have nothing to resolve against and every colour would fall back to
// black. It also posts onto white in Workvivo regardless of the viewer's
// theme, which is why it does not follow the app's dark mode.

const C = {
  bg:      "#FFFFFF",
  blue:    "#0B61B2",
  green:   "#25A738",
  black:   "#000000",
  track:   "#D9D9D9",
  ink:     "#000000",
  grey:    "#7F7F7F",
  white:   "#FFFFFF",
};

const FONT = "Bogle, 'Helvetica Neue', Helvetica, Arial, sans-serif";

const W = 980;
const H = 614;
const HEADER_H = 72;

// Measured centres from the reference capture.
const BIG   = { cx: 222, cy: 264, outer: 160, thick: 38 };
const DEPT  = { cy: 509, xs: [97, 222, 347], outer: 37, thick: 10 };
const GRID  = { xs: [575, 848], ys: [200, 470], outer: 118, thick: 17 };

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
 * track, which is what makes a near-complete ring read at a glance.
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

// Accepts either the dashboard shape or the older parsed-export shape, so a
// caller that has not been updated still renders something rather than throwing.
function normalise(input, meta) {
  const src = input || {};
  if (Number.isFinite(src.health) || Array.isArray(src.metrics)) {
    return {
      health: num(src.health),
      metrics: (src.metrics || []).slice(0, 4),
      deptRings: (src.deptRings || []).slice(0, 3),
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
    title = "VizPick Backroom Health",
    store = null,
    capturedAt = null,
  } = meta;

  const p = [];
  p.push(`<rect width="${W}" height="${H}" fill="${C.bg}"/>`);

  // ── Header bar ────────────────────────────────────────────────────────────
  p.push(`<rect x="0" y="0" width="${W}" height="${HEADER_H}" fill="${C.blue}"/>`);
  p.push(text(W / 2, 48, truncate(title, 40), { size: 29, weight: 700, fill: C.white }));

  // Store / timestamp are not on the Tableau dashboard, but a posted image with
  // no provenance is hard to act on, so they sit in the header's right edge.
  const stamp = [store ? `Store ${store}` : null, capturedAt].filter(Boolean).join("  ·  ");
  if (stamp) p.push(text(W - 14, 62, stamp, { size: 13, fill: C.white, anchor: "end" }));

  // ── Composite ring ────────────────────────────────────────────────────────
  p.push(ring(BIG.cx, BIG.cy, BIG.outer, BIG.thick, health, C.blue));
  p.push(text(BIG.cx, BIG.cy - 8, Number.isFinite(health) ? Math.round(health) : "—",
    { size: 76, weight: 700 }));
  p.push(text(BIG.cx, BIG.cy + 42, "VizPick", { size: 21 }));
  p.push(text(BIG.cx, BIG.cy + 74, "Health", { size: 21 }));

  // ── Department rings (no goal — never judged) ─────────────────────────────
  deptRings.slice(0, 3).forEach((d, i) => {
    const cx = DEPT.xs[i];
    p.push(ring(cx, DEPT.cy, DEPT.outer, DEPT.thick, num(d.value), C.blue));
    p.push(text(cx, DEPT.cy + 7, Number.isFinite(num(d.value)) ? Math.round(d.value) : "—",
      { size: 19, weight: 400 }));
    p.push(text(cx, DEPT.cy + 79, truncate(d.label, 10), { size: 18, fill: C.grey }));
  });

  // ── Goal grid ─────────────────────────────────────────────────────────────
  metrics.slice(0, 4).forEach((m, i) => {
    const cx = GRID.xs[i % 2];
    const cy = GRID.ys[Math.floor(i / 2)];
    const v = num(m.value);
    p.push(ring(cx, cy, GRID.outer, GRID.thick, v, bandColor(v, m.goal)));
    p.push(text(cx, cy - 12, Number.isFinite(v) ? `${Math.round(v)}%` : "—",
      { size: 47, weight: 400 }));
    p.push(text(cx, cy + 26, truncate(m.label, 14), { size: 24 }));
    if (m.goal != null) {
      p.push(text(cx, cy + 58, `Goal ${m.goal}%`, { size: 20, fill: C.grey }));
    }
  });

  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${p.join("")}</svg>`,
    width: W,
    height: H,
  };
}
