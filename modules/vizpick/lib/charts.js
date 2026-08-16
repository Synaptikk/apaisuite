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

const WM = {
  blue:  "#0053e2",
  spark: "#ffc220",
  green: "#2a8703",
  amber: "#b06f00",
  red:   "#c53030",
  ink:   "#1a1a1a",
  grid:  "#e2e5e9",
  muted: "#6b7280",
};

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
 * Color is goal-driven (traffic-light), matching what we observed live in
 * Tableau (green when at/above goal, red when clearly under, amber in the
 * narrow band just below goal):
 *   value >= goal            → green
 *   value >= goal - warnBand → amber
 *   else                     → red
 * If no goal is given, the ring is always blue (neutral — no threshold to
 * judge against).
 *
 * @param {number} value
 * @param {object} [opts]
 * @param {number} [opts.max=100]
 * @param {number} [opts.goal]        Threshold for green; omit for neutral blue.
 * @param {number} [opts.warnBand=5]  Percentage points below goal that count as amber.
 * @param {string} [opts.label]       Small caption under the ring (e.g. "VizPick Health").
 * @param {number} [opts.size=140]
 * @param {number} [opts.thickness=14]
 * @param {(v:number)=>string} [opts.fmt]  Center text formatter; defaults to the raw value.
 */
export function gaugeSvg(value, opts = {}) {
  const {
    max = 100,
    goal,
    warnBand = 5,
    label = "",
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

  let color = WM.blue;
  if (goal != null) {
    color = v >= goal ? WM.green : v >= goal - warnBand ? WM.amber : WM.red;
  }

  const track =
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${WM.grid}" stroke-width="${thickness}"/>`;
  const arc =
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="${thickness}" ` +
    `stroke-linecap="round" stroke-dasharray="${len.toFixed(2)} ${(circ - len).toFixed(2)}" ` +
    `transform="rotate(-90 ${cx} ${cy})"><title>${esc(label)}: ${esc(fmt(v))}${goal != null ? ` (goal ${esc(fmt(goal))})` : ""}</title></circle>`;
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
