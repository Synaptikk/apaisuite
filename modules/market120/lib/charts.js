// modules/market120/lib/charts.js
//
// Tiny dependency-free inline-SVG chart helpers. MV3's content-security-policy
// forbids remote <script> (so Chart.js-from-CDN is out) and bundling a charting
// lib is overkill for two simple charts — YAGNI. These return SVG strings you
// drop straight into innerHTML.
//
// Colors come from Walmart tokens via CSS custom properties so they track the
// suite theme (we read them as currentColor / var() inside the SVG).

const WM = {
  blue: "#0053e2",
  spark: "#ffc220",
  green: "#2a8703",
  ink: "#1a1a1a",
  grid: "#e2e5e9",
  muted: "#6b7280",
};

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/**
 * Horizontal bar chart. data = [{ label, value }].
 * Renders labels on the left, value bars, and a value annotation at bar end.
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
 * Donut chart. data = [{ label, value, color }]. Renders slices + a centered
 * total, and returns SVG + a small legend block appended below.
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
    `<ul class="mkt120-legend">` +
    data
      .map(
        (d) =>
          `<li><span class="mkt120-legend-dot" style="background:${d.color}"></span>` +
          `${esc(d.label)} — <strong>${esc(fmt(d.value))}</strong> ` +
          `(${((Math.max(0, d.value) / total) * 100).toFixed(1)}%)</li>`
      )
      .join("") +
    `</ul>`;

  return `<div class="mkt120-donut-wrap">${svg}${legend}</div>`;
}

function emptySvg(w, h) {
  return (
    `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
    `<text x="${w / 2}" y="${h / 2}" text-anchor="middle" dominant-baseline="middle" ` +
    `font-size="12" fill="${WM.muted}">No data yet</text></svg>`
  );
}

export const CHART_COLORS = WM;
