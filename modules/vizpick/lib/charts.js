// modules/vizpick/lib/charts.js
//
// Tiny dependency-free inline-SVG chart helpers, copied from market120's
// lib/charts.js (MV3 CSP forbids remote <script>, so no CDN Chart.js; a
// bundled charting lib is overkill for a handful of simple shapes).
//
// Adds gaugeSvg() on top of the market120 set: VizPick's own Tableau
// dashboard renders single-value "health" rings (e.g. "97 VizPick Health")
// rather than proportional multi-slice donuts, so donutSvg's design (slices
// summing to a whole) doesn't reproduce that look — gaugeSvg does.

// Palette. These are CSS custom properties, not hexes, because this SVG is
// injected INTO the document — inline SVG resolves var() from the page, so the
// charts follow the theme for free. When they were hexes the gauge numbers
// stayed near-black in dark mode, sitting inside a ring on a dark card.
//
// The fallbacks are the original hard-coded values, so a context that somehow
// renders this without the stylesheet still gets the light palette rather than
// black-on-black. Definitions live in styles/tokens.css.
//
// NOTE: modules/metricshot/lib/render_card.js deliberately keeps literal hexes
// — it is rasterised offscreen with no stylesheet attached, where var() has
// nothing to resolve against, and it posts onto white in Workvivo regardless
// of the viewer's theme.
const WM = {
  blue:  "var(--chart-met, #0053e2)",
  spark: "var(--chart-near, #ffc220)",
  green: "var(--chart-met, #2a8703)",
  yellow:"var(--chart-near, #ffc220)",
  amber: "var(--chart-near, #e07b00)",
  red:   "var(--chart-missed, #c53030)",
  ink:   "var(--chart-ink, #1a1a1a)",
  grid:  "var(--chart-track, #e2e5e9)",
  muted: "var(--chart-muted, #6b7280)",
};

// Goal-relative colour scale.
//
//   YESTERDAY (closed day — the number is final, so it can be judged)
//     >= goal                  blue    met the goal
//     within 5 pts below       orange  missed, but close
//     5+ pts below             RED     clear miss
//
//   TODAY (still accumulating — being under goal at 11am means nothing)
//     >= goal                  blue    already met the goal
//     anything below           black   deliberately NOT judged
//
//   NO PUBLISHED GOAL (Total Picked, Pallets %, the VizPick composite)
//     never judged — plain ink as text, neutral blue as a ring
//
// Why red rather than black for a clear miss: black is also the default text
// colour of an un-judged value, so using it for the worst numbers made a 56%
// Pick read exactly like a plain count and vanish into the card. Red is the
// only band that reads as a problem at a glance, and moving it there leaves
// black to mean one thing only — "not judged".
//
// Values are ROUNDED before comparison, because every surface that shows one
// rounds it to a whole percent; banding the raw value let 95.4 print as "95"
// while being coloured as though it were above 95.
// bandFor() returns one of these; `color` is painted directly onto SVG strokes,
// so it carries the same custom properties as WM above rather than a hex.
export const BANDS = {
  met:     { cls: "vizpick-met",     color: "var(--chart-met, #0053e2)" },
  near:    { cls: "vizpick-near",    color: "var(--chart-near, #e07b00)" },
  missed:  { cls: "vizpick-missed",  color: "var(--chart-missed, #c53030)" },
  neutral: { cls: "vizpick-neutral", color: "var(--chart-neutral, #0053e2)" },
};

// Points below goal at which "close" becomes a clear miss.
export const NEAR_BAND = 5;

/**
 * @param {number} value
 * @param {number|null|undefined} goal  Omit for a metric with no published goal.
 * @returns {{cls:string,color:string}|null}  null when there is no number.
 *
 * Current-day figures are graded exactly like closed ones. They were briefly
 * shown black-and-unjudged on the grounds that a mid-day number is incomplete,
 * but in practice that made the live tab unreadable at a glance — the whole
 * point of the rollup is to see who needs help NOW, and a wall of black says
 * nothing. A store at 65% against a 90% goal is behind whether or not the day
 * is over.
 */
export function bandFor(value, goal) {
  if (!Number.isFinite(value)) return null;
  if (goal == null || !Number.isFinite(goal)) return BANDS.neutral;
  const v = Math.round(value);
  if (v >= goal) return BANDS.met;
  if (v > goal - NEAR_BAND) return BANDS.near;
  return BANDS.missed;
}

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/**
 * Horizontal bar chart. data = [{ label, value }].
 */
export function hbarSvg(data, opts = {}) {
  const {
    width = 520,
    barH = 26,
    gap = 10,
    padL = 90,
    padR = 64,
    padT = 8,
    padB = 8,
    color = WM.blue,
    fmt = (v) => String(v),
  } = opts;

  if (!data || !data.length) return emptySvg(width, 120);

  const max = Math.max(...data.map((d) => Math.abs(d.value)), 1);
  const plotW = width - padL - padR;
  const height = padT + padB + data.length * (barH + gap) - gap;

  const bars = data
    .map((d, i) => {
      const y = padT + i * (barH + gap);
      const w = Math.max(2, (Math.abs(d.value) / max) * plotW);
      const cy = y + barH / 2;
      return (
        `<text x="${padL - 8}" y="${cy}" text-anchor="end" dominant-baseline="middle" ` +
        `font-size="12" fill="${WM.ink}">${esc(d.label)}</text>` +
        `<rect x="${padL}" y="${y}" width="${w.toFixed(1)}" height="${barH}" rx="4" fill="${color}"><title>${esc(
          d.label
        )}: ${esc(fmt(d.value))}</title></rect>` +
        `<text x="${padL + w + 6}" y="${cy}" dominant-baseline="middle" font-size="11" ` +
        `fill="${WM.muted}">${esc(fmt(d.value))}</text>`
      );
    })
    .join("");

  return (
    `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" ` +
    `preserveAspectRatio="xMinYMin meet" xmlns="http://www.w3.org/2000/svg">${bars}</svg>`
  );
}

/**
 * Donut chart. data = [{ label, value, color }]. Slices sum to a whole
 * (e.g. Clearance $ vs Deleted $). For a single value against a goal, use
 * gaugeSvg instead.
 */
export function donutSvg(data, opts = {}) {
  const { size = 200, thickness = 34, centerLabel = "", fmt = (v) => String(v) } = opts;
  if (!data || !data.length) return emptySvg(size, size);

  const total = data.reduce((s, d) => s + Math.max(0, d.value), 0) || 1;
  const r = (size - thickness) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circ = 2 * Math.PI * r;

  let offset = 0;
  const rings = data
    .map((d) => {
      const frac = Math.max(0, d.value) / total;
      const len = frac * circ;
      const seg =
        `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${d.color}" ` +
        `stroke-width="${thickness}" stroke-dasharray="${len.toFixed(2)} ${(circ - len).toFixed(2)}" ` +
        `stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})">` +
        `<title>${esc(d.label)}: ${esc(fmt(d.value))} (${(frac * 100).toFixed(1)}%)</title></circle>`;
      offset += len;
      return seg;
    })
    .join("");

  const center = centerLabel
    ? `<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="middle" ` +
      `font-size="15" font-weight="700" fill="${WM.ink}">${esc(centerLabel)}</text>`
    : "";

  const svg =
    `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" ` +
    `xmlns="http://www.w3.org/2000/svg">${rings}${center}</svg>`;

  const legend =
    `<ul class="vizpick-legend">` +
    data
      .map(
        (d) =>
          `<li><span class="vizpick-legend-dot" style="background:${d.color}"></span>` +
          `${esc(d.label)} — <strong>${esc(fmt(d.value))}</strong> ` +
          `(${((Math.max(0, d.value) / total) * 100).toFixed(1)}%)</li>`
      )
      .join("") +
    `</ul>`;

  return `<div class="vizpick-donut-wrap">${svg}${legend}</div>`;
}

/**
 * Single-value gauge ring — replicates VizPick's own "97 VizPick Health"
 * style donuts: one colored arc for `value` out of `max`, a light-gray
 * track for the remainder, and a bold centered number.
 *
 * Colour comes from the shared goal-relative scale (see bandFor): blue at or
 * above goal, orange just below on a closed day, black for a clear miss or for
 * any below-goal current-day figure. `goal` is both the caption and what
 * drives the colour; omit it for a metric with no published target and the
 * ring stays neutral blue, which is what Tableau does for VizPick Health.
 *
 * @param {number} value
 * @param {object} [opts]
 * @param {number} [opts.max=100]
 * @param {number} [opts.goal]        Caption AND colour threshold.
 * @param {string} [opts.label]       Small caption under the ring (e.g. "VizPick Health").
 * @param {string} [opts.title]       Tooltip name; defaults to `label`. Set it
 *   explicitly when the ring shows no caption but still needs a named tooltip.
 * @param {number} [opts.size=140]
 * @param {number} [opts.thickness=14]
 * @param {(v:number)=>string} [opts.fmt]  Center text formatter; defaults to the raw value.
 */
export function gaugeSvg(value, opts = {}) {
  const {
    max = 100,
    goal,
    label = "",
    // Tooltip name, for a gauge that deliberately renders no visible caption.
    title = label,
    size = 140,
    thickness = 14,
    fmt = (v) => String(Math.round(v)),
  } = opts;

  const v = Number.isFinite(value) ? value : 0;
  const frac = Math.max(0, Math.min(1, v / max));
  const r = (size - thickness) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circ = 2 * Math.PI * r;
  const len = frac * circ;

  // Same scale as the card metric text, so a ring and its number can never
  // disagree about whether the goal was met.
  const color = bandFor(v, goal)?.color ?? WM.blue;

  const track =
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${WM.grid}" stroke-width="${thickness}"/>`;
  // Butt caps (the SVG default), not round: Tableau's own VizPick rings have
  // square ends, and a rounded cap also overstates a small value by half the
  // stroke width at each end.
  const arc =
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="${thickness}" ` +
    `stroke-dasharray="${len.toFixed(2)} ${(circ - len).toFixed(2)}" ` +
    // A gauge with no visible caption (the big composite ring on a store card)
    // still needs a readable tooltip — "": 97" reads as a bug.
    `transform="rotate(-90 ${cx} ${cy})"><title>${title ? `${esc(title)}: ` : ""}${esc(fmt(v))}${goal != null ? ` (goal ${esc(fmt(goal))})` : ""}</title></circle>`;
  const center =
    `<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="middle" ` +
    `font-size="${Math.round(size * 0.22)}" font-weight="700" fill="${WM.ink}">${esc(fmt(v))}</text>`;

  const svg =
    `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" ` +
    `xmlns="http://www.w3.org/2000/svg">${track}${arc}${center}</svg>`;

  const caption = label
    ? `<div class="vizpick-gauge-label">${esc(label)}${goal != null ? `<span class="vizpick-gauge-goal"> Goal ${esc(fmt(goal))}</span>` : ""}</div>`
    : "";

  return `<div class="vizpick-gauge">${svg}${caption}</div>`;
}

function emptySvg(w, h) {
  return (
    `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
    `<text x="${w / 2}" y="${h / 2}" text-anchor="middle" dominant-baseline="middle" ` +
    `font-size="12" fill="${WM.muted}">No data yet</text></svg>`
  );
}

export const CHART_COLORS = WM;
