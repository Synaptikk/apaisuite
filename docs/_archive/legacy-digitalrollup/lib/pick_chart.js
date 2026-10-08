// modules/digitalrollup/lib/pick_chart.js
//
// The home store's picks per clock hour from the board's day start (5 AM) to
// now, as an SVG string. One builder for both uses: on screen (theme tokens,
// so dark mode follows the suite) and as the image posted to Workvivo (fixed
// light colours, a title and a background, since a PNG has no stylesheet).
//
// Bars, not a line: each hour is a discrete count. Three kinds, from
// lib/pick_history.js::hourlyBars —
//   hour    measured, solid blue
//   now     the current hour so far, lighter blue, labelled "so far"
//   before  the stretch before recording started: ONE muted bar at its
//           average rate across those hours, because only its total is known.
//           Drawing per-hour bars there would invent a shape.
// Today's average per hour is a dashed reference line. One series, so no
// legend; the title names it. Colours go in `style` because var() is only
// reliable there. Pure string building: runs under node --test.

export const SCREEN_PALETTE = {
  bar: "var(--apai-blue)",
  before: "var(--apai-border)",
  avg: "var(--apai-muted)",
  grid: "var(--apai-border-soft)",
  text: "var(--apai-muted)",
  ink: "var(--apai-text, currentColor)",
  bg: null,
};

// Light-mode token values (styles/tokens.css), frozen for the exported image.
export const EXPORT_PALETTE = {
  bar: "#0071CE",
  before: "#D5D9E0",
  avg: "#5B6472",
  grid: "#EEF0F3",
  text: "#5B6472",
  ink: "#1F2937",
  bg: "#FFFFFF",
};

const HOUR = 3600e3;
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fmt = (n) => Math.round(n).toLocaleString("en-US");
const clock = (t) => new Date(t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
/** "5a", "12p" — short enough to sit under every bar. */
const hourLabel = (t) => {
  const h = new Date(t).getHours();
  return `${h % 12 || 12}${h < 12 ? "a" : "p"}`;
};
const hourRange = (a) => `${clock(a).replace(":00", "")}–${clock(a + HOUR).replace(":00", "")}`;

/** A readable step (1, 2, 2.5, 5 × 10ⁿ) giving about `count` intervals up to max. */
export function niceStep(max, count = 3) {
  if (!(max > 0)) return 1;
  const rough = max / count;
  const mag = 10 ** Math.floor(Math.log10(rough));
  return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= rough);
}

/** Top-rounded bar anchored to the baseline (4px data end, square foot). */
function barPath(x, y, w, h, r) {
  if (h <= 0 || w <= 0) return "";
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/**
 * @param {ReturnType<import("./pick_history.js").hourlyBars>} day
 * @param {object} o
 * @param {number} o.width, o.height  viewBox size
 * @param {object} o.palette          SCREEN_PALETTE | EXPORT_PALETTE
 * @param {string} [o.title]          export only: heading line
 * @param {string} [o.subtitle]       export only: the summary text
 * @returns {string} SVG markup, or "" when there is nothing to draw
 */
export function barChartSvg(day, { width = 320, height = 130, palette = SCREEN_PALETTE, title = "", subtitle = "" } = {}) {
  if (!day || (!day.hours.length && !day.before)) return "";
  const P = palette;
  const big = width >= 600;
  const fs = big ? 14 : 9.5;
  const top = (title ? fs * 2.7 : 0) + (subtitle ? fs * 1.9 : 0) + (big ? 24 : 12);
  const left = big ? 56 : 34;
  const right = big ? 76 : 46;          // room for the avg label
  const bottom = big ? 30 : 16;
  const x0 = left, x1 = width - right, y0 = height - bottom, y1 = top;

  // Slots run from the day start to the end of the current hour, so the
  // "so far" bar has a full slot and the axis reads as whole hours.
  const lastEnd = day.hours.length ? day.hours[day.hours.length - 1].start + HOUR : Math.ceil(day.asOf / HOUR) * HOUR;
  const slots = Math.max(1, Math.round((lastEnd - day.dayStart) / HOUR));
  const slotW = (x1 - x0) / slots;
  const X = (t) => x0 + ((t - day.dayStart) / HOUR) * slotW;
  const gap = Math.min(2, slotW * 0.2);  // 2px surface gap between bars

  const vals = [...day.hours.map((h) => h.picked), day.before?.perHour ?? 0, day.dayAvgPerHour ?? 0, 1];
  const step = niceStep(Math.max(...vals) * 1.1);
  const ymax = Math.ceil((Math.max(...vals) * 1.08) / step) * step;
  const Y = (v) => y0 - (Math.max(0, v) / ymax) * (y0 - y1);

  const parts = [];
  if (P.bg) parts.push(`<rect width="${width}" height="${height}" style="fill:${P.bg}"/>`);
  if (title) parts.push(`<text x="${left}" y="${fs * 1.9}" style="fill:${P.ink};font-size:${fs * 1.4}px;font-weight:700">${esc(title)}</text>`);
  if (subtitle) parts.push(`<text x="${left}" y="${fs * (title ? 3.9 : 1.6)}" style="fill:${P.text};font-size:${fs}px">${esc(subtitle)}</text>`);

  // Recessive horizontal grid, labelled at the left.
  for (let v = 0; v <= ymax + 1e-9; v += step) {
    const y = Y(v).toFixed(1);
    parts.push(`<line x1="${x0}" x2="${x1}" y1="${y}" y2="${y}" style="stroke:${P.grid};stroke-width:1"/>`);
    parts.push(`<text x="${x0 - 5}" y="${y}" dy="0.32em" text-anchor="end" style="fill:${P.text};font-size:${fs}px">${fmt(v)}</text>`);
  }

  // Before recording: one wide muted bar at the average rate.
  const hits = [];
  if (day.before && day.before.end > day.before.start) {
    const bx = X(day.before.start) + gap / 2, bw = X(day.before.end) - X(day.before.start) - gap;
    const by = Y(day.before.perHour);
    parts.push(`<path d="${barPath(bx, by, bw, y0 - by, big ? 5 : 3)}" style="fill:${P.before}"/>`);
    const note = `before recording · avg ${fmt(day.before.perHour)}/hr`;
    if (bw > (big ? 150 : 90)) {
      parts.push(`<text x="${(bx + bw / 2).toFixed(1)}" y="${(by + (y0 - by) / 2).toFixed(1)}" dy="0.32em" text-anchor="middle" style="fill:${P.text};font-size:${fs * 0.95}px">${esc(note)}</text>`);
    }
    hits.push({ x: X(day.before.start), w: X(day.before.end) - X(day.before.start),
      tip: `${clock(day.before.start)}–${clock(day.before.end)}: ${fmt(day.before.picked)} picked, avg ${fmt(day.before.perHour)}/hr (recording had not started, so no hour-by-hour detail)` });
  }

  // Measured hours, and the current hour so far.
  for (const h of day.hours) {
    const bx = X(h.start) + gap / 2, bw = slotW - gap;
    const by = Y(h.picked);
    const now = h.kind === "now";
    parts.push(`<path d="${barPath(bx, by, bw, y0 - by, big ? 5 : 3)}" style="fill:${P.bar};${now ? "fill-opacity:0.4" : ""}"/>`);
    // Values on bars only in the image — a posted picture has no hover.
    if (big && bw > 30) {
      parts.push(`<text x="${(bx + bw / 2).toFixed(1)}" y="${(by - 6).toFixed(1)}" text-anchor="middle" style="fill:${P.ink};font-size:${fs * 0.85}px;font-weight:${now ? 400 : 600}">${fmt(h.picked)}${now ? " so far" : ""}</text>`);
    }
    hits.push({ x: X(h.start), w: slotW,
      tip: now
        ? `${hourLabel(h.start)} so far: ${fmt(h.picked)} picked (as of ${clock(h.end)})`
        : `${hourRange(h.start)}: ${fmt(h.picked)} picked` });
  }

  // Hour labels under every slot that has room; thinned evenly when not.
  const labelEvery = Math.max(1, Math.ceil((big ? 30 : 17) / slotW));
  for (let i = 0; i < slots; i++) {
    const t = day.dayStart + i * HOUR;
    if (new Date(t).getHours() % labelEvery) continue;
    parts.push(`<text x="${(X(t) + slotW / 2).toFixed(1)}" y="${y0 + fs + 3}" text-anchor="middle" style="fill:${P.text};font-size:${fs}px">${hourLabel(t)}</text>`);
  }

  // Today's average per hour since the day start.
  if (day.dayAvgPerHour > 0) {
    const y = Y(day.dayAvgPerHour).toFixed(1);
    parts.push(`<line x1="${x0}" x2="${x1}" y1="${y}" y2="${y}" style="stroke:${P.avg};stroke-width:1.25;stroke-dasharray:4 3"/>`);
    parts.push(`<text x="${x1 + 5}" y="${y}" dy="0.32em" style="fill:${P.text};font-size:${fs}px">avg ${fmt(day.dayAvgPerHour)}</text>`);
  }

  // Screen only: invisible full-height hit areas carrying the hover text.
  if (!P.bg) {
    for (const h of hits) {
      parts.push(`<rect class="dmr-bar-hit" x="${h.x.toFixed(1)}" y="${y1}" width="${h.w.toFixed(1)}" height="${(y0 - y1).toFixed(1)}" data-tip="${esc(h.tip)}" style="fill:transparent"/>`);
    }
  }

  const last = day.hours[day.hours.length - 1];
  const aria = `Items picked per hour since ${clock(day.dayStart)}${last ? `, ${fmt(last.picked)} so far this hour` : ""}, average ${fmt(day.dayAvgPerHour)} per hour`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(aria)}" style="font-family:'Segoe UI',Inter,Roboto,sans-serif">${parts.join("")}</svg>`;
}
