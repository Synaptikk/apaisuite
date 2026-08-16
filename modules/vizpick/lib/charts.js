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
  yellow:"#ffc220",   // Walmart Spark yellow
  amber: "#e07b00",
  red:   "#c53030",
  ink:   "#1a1a1a",
  grid:  "#e2e5e9",
  muted: "#6b7280",
};

// Shared four-band scale for every VizPick percentage. These are ABSOLUTE
// thresholds, not offsets from each metric's goal:
//   >= 98            green
//   > 95  and < 98   yellow
//   > 90  and <= 95  orange
//   <= 90            red
// Exported so the gauge rings and the card metric text can never drift apart.
export const BANDS = {
  good:    { cls: "vizpick-good",    color: WM.green  },
  caution: { cls: "vizpick-caution", color: WM.yellow },
  warn:    { cls: "vizpick-warn",    color: WM.amber  },
  bad:     { cls: "vizpick-bad",     color: WM.red    },
};

/**
 * Band a percentage. Returns { cls, color }, or null for a non-finite value
 * so callers can render an explicit "no data" state instead of a false zero.
 *
 * The boundaries belong to the LOWER band — "95% and under" is orange and
 * "90% and under" is red — hence the strict `>` comparisons.
 */
export function bandFor(value) {
  if (!Number.isFinite(value)) return null;
  if (value >= 98) return BANDS.good;
  if (value > 95)  return BANDS.caution;
  if (value > 90)  return BANDS.warn;
  return BANDS.bad;
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
 * Colour comes from the shared absolute four-band scale (see bandFor):
 *   >= 98 green · > 95 yellow · > 90 orange · <= 90 red
 * `goal` is no longer what colours the ring — it is still rendered as the
 * caption so Tableau's own target stays visible. Pass `neutral: true` for a
 * value that isn't a percentage (the VizPick composite), which keeps the ring
 * blue because the bands don't apply to it.
 *
 * @param {number} value
 * @param {object} [opts]
 * @param {number} [opts.max=100]
 * @param {number} [opts.goal]        Shown as a caption; does not affect colour.
 * @param {boolean} [opts.neutral]    Render a blue ring (non-percentage value).
 * @param {string} [opts.label]       Small caption under the ring (e.g. "VizPick Health").
 * @param {number} [opts.size=140]
 * @param {number} [opts.thickness=14]
 * @param {(v:number)=>string} [opts.fmt]  Center text formatter; defaults to the raw value.
 */
export function gaugeSvg(value, opts = {}) {
  const {
    max = 100,
    goal,
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

  // Ring colour uses the same absolute four-band scale as the card metrics
  // (bandFor). `goal` no longer drives the colour — it is still shown as the
  // caption so the Tableau target stays visible — because the bands are
  // absolute percentages, not offsets from each metric's own goal.
  // `neutral: true` keeps the ring blue for values that aren't percentages
  // (e.g. the VizPick composite score).
  const color = opts.neutral ? WM.blue : (bandFor(v)?.color ?? WM.blue);

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
