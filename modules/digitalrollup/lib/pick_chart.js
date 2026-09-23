// modules/digitalrollup/lib/pick_chart.js
//
// The home store's pick rate through the day, as an SVG string. One builder
// for both uses: on screen (colours are theme tokens, so dark mode follows the
// suite) and as the image posted to Workvivo (fixed light colours, a title
// and a background, because a PNG has no stylesheet to inherit).
//
// One series, so no legend: the title names it. Today's average is a dashed
// reference line with its own label, not a second series. Colours go in
// `style` rather than presentation attributes because var() is only reliable
// there. Pure string building: no DOM, so it runs under node --test.

export const SCREEN_PALETTE = {
  line: "var(--apai-blue)",
  avg: "var(--apai-muted)",
  grid: "var(--apai-border)",
  text: "var(--apai-muted)",
  ink: "var(--apai-text, currentColor)",
  bg: null,
};

// Light-mode token values (styles/tokens.css), frozen for the exported image.
export const EXPORT_PALETTE = {
  line: "#0071CE",
  avg: "#5B6472",
  grid: "#E3E6EB",
  text: "#5B6472",
  ink: "#1F2937",
  bg: "#FFFFFF",
};

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fmt = (n) => Math.round(n).toLocaleString("en-US");
const clock = (t) => new Date(t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const hourLabel = (t) => new Date(t).toLocaleTimeString("en-US", { hour: "numeric" }).replace(/\s/g, "").toLowerCase();

/** A readable step (1, 2, 2.5, 5 × 10ⁿ) giving about `count` intervals up to max. */
export function niceStep(max, count = 3) {
  if (!(max > 0)) return 1;
  const rough = max / count;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= rough);
  return step;
}

/**
 * @param {Array<[number, number]>} points  [tMs, perHour] from rateSeries()
 * @param {object} o
 * @param {number|null} o.avg        today's average per hour (dashed line)
 * @param {number} o.width, o.height viewBox size
 * @param {object} o.palette         SCREEN_PALETTE | EXPORT_PALETTE
 * @param {string} [o.title]         export only: heading line
 * @param {string} [o.subtitle]      export only: the summary text
 * @returns {string} SVG markup, or "" with fewer than two points
 */
export function chartSvg(points, { avg = null, width = 320, height = 120, palette = SCREEN_PALETTE, title = "", subtitle = "" } = {}) {
  if (!Array.isArray(points) || points.length < 2) return "";
  const P = palette;
  const big = width >= 600;
  const fs = big ? 15 : 10;               // tick/label size
  const top = (title ? fs * 2.6 : 0) + (subtitle ? fs * 1.8 : 0) + (big ? 20 : 10);
  const left = big ? 64 : 38;
  const right = big ? 90 : 52;            // room for the end label
  const bottom = big ? 34 : 18;
  const x0 = left, x1 = width - right, y0 = height - bottom, y1 = top;

  const t0 = points[0][0], tN = points[points.length - 1][0];
  const vmax = Math.max(...points.map((p) => p[1]), avg ?? 0, 1);
  const step = niceStep(vmax * 1.1);
  const ymax = Math.ceil((vmax * 1.05) / step) * step;
  const X = (t) => x0 + (tN === t0 ? 0 : (t - t0) / (tN - t0)) * (x1 - x0);
  const Y = (v) => y0 - (Math.max(0, v) / ymax) * (y0 - y1);

  const parts = [];
  if (P.bg) parts.push(`<rect width="${width}" height="${height}" style="fill:${P.bg}"/>`);
  if (title) parts.push(`<text x="${left}" y="${fs * 1.9}" style="fill:${P.ink};font-size:${fs * 1.35}px;font-weight:700">${esc(title)}</text>`);
  if (subtitle) parts.push(`<text x="${left}" y="${fs * (title ? 3.8 : 1.6)}" style="fill:${P.text};font-size:${fs}px">${esc(subtitle)}</text>`);

  // Recessive grid: horizontal only, labelled at the left.
  for (let v = 0; v <= ymax + 1e-9; v += step) {
    const y = Y(v).toFixed(1);
    parts.push(`<line x1="${x0}" x2="${x1}" y1="${y}" y2="${y}" style="stroke:${P.grid};stroke-width:1"/>`);
    parts.push(`<text x="${x0 - 6}" y="${y}" dy="0.32em" text-anchor="end" style="fill:${P.text};font-size:${fs}px">${fmt(v)}</text>`);
  }

  // Hour ticks along the bottom, thinned so labels never collide.
  const HOUR = 3600e3;
  const span = tN - t0;
  const every = span <= 4 * HOUR ? 1 : span <= 8 * HOUR ? 2 : span <= 14 * HOUR ? 3 : 4;
  const firstHour = Math.ceil(t0 / HOUR) * HOUR;
  for (let t = firstHour; t <= tN; t += HOUR) {
    if (new Date(t).getHours() % every) continue;
    const x = X(t).toFixed(1);
    parts.push(`<text x="${x}" y="${y0 + fs + 4}" text-anchor="middle" style="fill:${P.text};font-size:${fs}px">${hourLabel(t)}</text>`);
  }
  // Under an hour of graph there may be no hour mark at all; name the ends.
  if (tN - t0 < HOUR) {
    parts.push(`<text x="${x0}" y="${y0 + fs + 4}" style="fill:${P.text};font-size:${fs}px">${esc(clock(t0))}</text>`);
    parts.push(`<text x="${x1}" y="${y0 + fs + 4}" text-anchor="end" style="fill:${P.text};font-size:${fs}px">${esc(clock(tN))}</text>`);
  }

  // Today's average: dashed reference, labelled at the right edge.
  if (avg != null && avg > 0) {
    const y = Y(avg).toFixed(1);
    parts.push(`<line x1="${x0}" x2="${x1}" y1="${y}" y2="${y}" style="stroke:${P.avg};stroke-width:1.25;stroke-dasharray:4 3"/>`);
    parts.push(`<text x="${x1 + 6}" y="${y}" dy="0.32em" style="fill:${P.text};font-size:${fs}px">avg ${fmt(avg)}</text>`);
  }

  // The series: 2px line, rounded joins, a marker and direct label at the end.
  const d = points.map(([t, v], i) => `${i ? "L" : "M"}${X(t).toFixed(1)},${Y(v).toFixed(1)}`).join("");
  parts.push(`<path d="${d}" style="fill:none;stroke:${P.line};stroke-width:${big ? 2.5 : 2};stroke-linejoin:round;stroke-linecap:round"/>`);
  const [tl, vl] = points[points.length - 1];
  const ex = X(tl).toFixed(1), ey = Y(vl).toFixed(1);
  parts.push(`<circle cx="${ex}" cy="${ey}" r="${big ? 5 : 4}" style="fill:${P.line};stroke:${P.bg || "var(--apai-bg-soft)"};stroke-width:2"/>`);
  // Nudged off the avg label when the two would overlap.
  const avgY = avg != null ? Y(avg) : -1e9;
  const labelY = Math.abs(Y(vl) - avgY) < fs * 1.3 ? avgY + (Y(vl) < avgY ? -fs * 1.3 : fs * 1.3) : Y(vl);
  parts.push(`<text x="${x1 + 6}" y="${labelY.toFixed(1)}" dy="0.32em" style="fill:${P.ink};font-size:${fs}px;font-weight:700">${fmt(vl)}/hr</text>`);

  // Hover layer hooks (screen only): plot bounds + time range, read by the view.
  const hook = P.bg ? "" : ` data-x0="${x0}" data-x1="${x1}" data-y0="${y0}" data-y1="${y1}" data-t0="${t0}" data-tn="${tN}" data-ymax="${ymax}"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"${hook} role="img" aria-label="Pick rate per hour through the day, latest ${fmt(vl)} per hour" style="font-family:'Segoe UI',Inter,Roboto,sans-serif">${parts.join("")}</svg>`;
}
