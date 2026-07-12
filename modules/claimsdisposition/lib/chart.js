// modules/claimsdisposition/lib/chart.js
//
// Vanilla SVG chart helper — replaces Recharts for the 6 chart instances
// in the donor (2 line charts, 4 bar charts).
//
// Supports:
//   * Grouped bar charts (multiple series per category)
//   * Line charts (multiple series, monotone-style smoothing optional)
//   * X axis: discrete (band scale) or ordinal date strings (point scale)
//   * Y axis: linear, with auto-tick computation
//   * Optional dashed reference lines
//   * Hover tooltip + simple legend (rendered as sibling divs to the SVG)
//   * Responsive width via ResizeObserver
//
// API:
//   createBarChart(container, opts)  => { update(opts), destroy() }
//   createLineChart(container, opts) => { update(opts), destroy() }
//
// `opts` shape (shared for both):
//   {
//     height: number,                          // required
//     margin?: { top, right, bottom, left },   // default { top: 12, right: 16, bottom: 32, left: 48 }
//     data: object[],                          // datum array
//     xKey: string,                            // datum field for x category
//     xFormat?: (v) => string,                 // axis label formatter
//     series: [{ key, name, color, dot? }],    // one entry per series
//     yFormat?: (v) => string,                 // y-axis label formatter
//     yMin?: number,                           // override y-scale lower bound
//     yMax?: number,                           // override y-scale upper bound
//     tooltip?: (datum, seriesMeta) => string, // HTML/string for hover
//     referenceLines?: [{ y, color, label }],  // dashed reference lines
//     smooth?: boolean,                        // line chart: catmull-rom-ish smoothing (default false)
//   }

import { h, clear, replace } from "./dom.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const DEFAULT_MARGIN = { top: 12, right: 16, bottom: 32, left: 48 };

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    el.setAttribute(k, String(v));
  }
  return el;
}

// ── Y-axis tick computation (D3-ish nice ticks) ─────────────────
function niceTicks(min, max, targetCount = 5) {
  if (min === max) {
    if (min === 0) return [0, 1];
    const pad = Math.abs(min) * 0.5;
    return [min - pad, min, min + pad];
  }
  const range = max - min;
  const roughStep = range / targetCount;
  const pow10 = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const norm = roughStep / pow10;
  let step;
  if      (norm < 1.5) step = 1 * pow10;
  else if (norm < 3)   step = 2 * pow10;
  else if (norm < 7)   step = 5 * pow10;
  else                 step = 10 * pow10;
  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = niceMin; v <= niceMax + step / 2; v += step) ticks.push(Number(v.toFixed(10)));
  return ticks;
}

// ── Linear interpolation between two points (for hover tracking) ──
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ── Shared chart scaffolding (svg + tooltip + legend + ResizeObserver) ──
function mountScaffold(container, opts) {
  container.classList.add("cd-chart");
  container.style.height = `${opts.height}px`;
  container.style.position = "relative";

  const tooltip = h("div", { class: "cd-chart-tooltip" });
  const legend  = h("div", { class: "cd-chart-legend" });
  const svgWrap = document.createElementNS(SVG_NS, "svg");
  svgWrap.setAttribute("width", "100%");
  svgWrap.setAttribute("height", "100%");

  // Container layout: SVG fills the cd-chart box. Legend hangs below as a
  // sibling positioned via margin since cd-chart is height-locked. The
  // legend is inserted as the container's NEXT sibling so it lives just
  // below the chart in the card. Caller is responsible for having already
  // attached `container` to the DOM before calling mountScaffold.
  //
  // (A previous version of this helper did `h("div", null, container)` here
  // with a "no-op" comment — that was wrong: h() uses appendChild which
  // re-parents the node. The line silently detached the chart slot from
  // its containing card, leaving the chart invisible. Removed.)
  container.appendChild(svgWrap);
  container.appendChild(tooltip);
  container.parentNode?.insertBefore(legend, container.nextSibling);

  return { svg: svgWrap, tooltip, legend };
}

function renderLegend(legendEl, series) {
  replace(legendEl,
    ...series.map((s) =>
      h("span", { class: "cd-chart-legend-item" },
        h("span", { class: "cd-chart-legend-swatch", style: { background: s.color } }),
        s.name,
      ),
    ),
  );
}

// ── Bar chart ───────────────────────────────────────────────────

export function createBarChart(container, initialOpts) {
  const { svg, tooltip, legend } = mountScaffold(container, initialOpts);
  let opts = initialOpts;
  let ro;

  function draw() {
    clear(svg);
    const margin = { ...DEFAULT_MARGIN, ...(opts.margin || {}) };
    const W = container.clientWidth || 600;
    const H = opts.height;
    const innerW = Math.max(10, W - margin.left - margin.right);
    const innerH = Math.max(10, H - margin.top - margin.bottom);

    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

    const g = svgEl("g", { transform: `translate(${margin.left}, ${margin.top})` });
    svg.appendChild(g);

    const data = opts.data || [];
    const series = opts.series || [];
    if (!data.length || !series.length) return;

    // Band scale for x (discrete categories)
    const bandW = innerW / data.length;
    const groupGap = bandW * 0.15;
    const groupInnerW = bandW - groupGap;
    const barW = groupInnerW / series.length;

    // Y scale (extend max for reference lines too)
    let yMin = opts.yMin ?? 0;
    let yMax = opts.yMax ?? 0;
    for (const d of data) for (const s of series) {
      const v = Number(d[s.key]) || 0;
      if (v > yMax) yMax = v;
      if (v < yMin) yMin = v;
    }
    if (opts.referenceLines) for (const r of opts.referenceLines) {
      if (r.y > yMax) yMax = r.y;
      if (r.y < yMin) yMin = r.y;
    }
    const ticks = niceTicks(yMin, yMax, 5);
    const yDomain = [ticks[0], ticks[ticks.length - 1]];
    const yToPx = (v) => innerH - ((v - yDomain[0]) / (yDomain[1] - yDomain[0] || 1)) * innerH;

    // Grid + Y axis labels
    for (const t of ticks) {
      const y = yToPx(t);
      g.appendChild(svgEl("line", {
        class: "cd-chart-grid-line", x1: 0, x2: innerW, y1: y, y2: y,
      }));
      g.appendChild(svgEl("text", {
        class: "cd-chart-axis-label",
        x: -8, y: y + 3, "text-anchor": "end",
      })).textContent = opts.yFormat ? opts.yFormat(t) : String(t);
    }

    // X axis line
    g.appendChild(svgEl("line", {
      class: "cd-chart-axis-line", x1: 0, x2: innerW, y1: innerH, y2: innerH,
    }));

    // X axis labels (skip every other if crowded)
    const xLabelStep = Math.max(1, Math.ceil((data.length * 50) / innerW));
    data.forEach((d, i) => {
      if (i % xLabelStep !== 0) return;
      const x = i * bandW + bandW / 2;
      const t = svgEl("text", {
        class: "cd-chart-axis-label",
        x, y: innerH + 16, "text-anchor": "middle",
      });
      t.textContent = opts.xFormat ? opts.xFormat(d[opts.xKey]) : String(d[opts.xKey]);
      g.appendChild(t);
    });

    // Reference lines (dashed)
    if (opts.referenceLines) {
      for (const r of opts.referenceLines) {
        const y = yToPx(r.y);
        g.appendChild(svgEl("line", {
          class: "cd-chart-ref-line",
          x1: 0, x2: innerW, y1: y, y2: y,
          stroke: r.color || "var(--apai-muted)",
        }));
        if (r.label) {
          const txt = svgEl("text", {
            class: "cd-chart-axis-label",
            x: innerW - 4, y: y - 4, "text-anchor": "end",
            fill: r.color || "var(--apai-muted)",
          });
          txt.textContent = r.label;
          g.appendChild(txt);
        }
      }
    }

    // Bars
    data.forEach((d, i) => {
      const xBase = i * bandW + groupGap / 2;
      series.forEach((s, si) => {
        const v = Number(d[s.key]) || 0;
        const y = yToPx(v);
        const yZero = yToPx(0);
        const barH = Math.max(0, yZero - y);
        const x = xBase + si * barW;
        const rect = svgEl("rect", {
          x, y, width: Math.max(0, barW - 1), height: barH,
          fill: s.color, rx: 2, ry: 2,
        });
        rect.style.cursor = "pointer";
        rect.addEventListener("mousemove", (ev) => showTooltip(ev, d, s));
        rect.addEventListener("mouseleave", hideTooltip);
        g.appendChild(rect);
      });
    });
  }

  function showTooltip(ev, datum, seriesMeta) {
    const html = opts.tooltip
      ? opts.tooltip(datum, seriesMeta)
      : `<strong>${opts.xFormat ? opts.xFormat(datum[opts.xKey]) : datum[opts.xKey]}</strong><br>${seriesMeta.name}: ${datum[seriesMeta.key]}`;
    tooltip.innerHTML = html;
    tooltip.classList.add("is-visible");
    positionTooltip(ev);
  }

  function positionTooltip(ev) {
    const rect = container.getBoundingClientRect();
    const x = ev.clientX - rect.left + 10;
    const y = ev.clientY - rect.top  + 10;
    const tw = tooltip.offsetWidth || 0;
    const th = tooltip.offsetHeight || 0;
    tooltip.style.left = `${clamp(x, 0, rect.width  - tw - 4)}px`;
    tooltip.style.top  = `${clamp(y, 0, rect.height - th - 4)}px`;
  }

  function hideTooltip() {
    tooltip.classList.remove("is-visible");
  }

  function update(newOpts) {
    opts = { ...opts, ...newOpts };
    renderLegend(legend, opts.series || []);
    draw();
  }

  renderLegend(legend, opts.series || []);
  draw();

  ro = new ResizeObserver(() => draw());
  ro.observe(container);

  return {
    update,
    destroy() {
      ro?.disconnect();
      tooltip.remove();
      legend.remove();
      clear(svg);
      container.classList.remove("cd-chart");
    },
  };
}

// ── Line chart ──────────────────────────────────────────────────

export function createLineChart(container, initialOpts) {
  const { svg, tooltip, legend } = mountScaffold(container, initialOpts);
  let opts = initialOpts;
  let ro;

  // Single overlay rect captures mouse events; we find the nearest point.
  let overlayRect = null;

  function draw() {
    clear(svg);
    const margin = { ...DEFAULT_MARGIN, ...(opts.margin || {}) };
    const W = container.clientWidth || 600;
    const H = opts.height;
    const innerW = Math.max(10, W - margin.left - margin.right);
    const innerH = Math.max(10, H - margin.top - margin.bottom);

    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const g = svgEl("g", { transform: `translate(${margin.left}, ${margin.top})` });
    svg.appendChild(g);

    const data = opts.data || [];
    const series = opts.series || [];
    if (!data.length || !series.length) return;

    // Point scale on x: indices [0..N-1] map across innerW.
    const xToPx = (i) => (data.length === 1 ? innerW / 2 : (i / (data.length - 1)) * innerW);

    // Y scale across all series + reference lines
    let yMin = opts.yMin ?? 0;
    let yMax = opts.yMax ?? 0;
    for (const d of data) for (const s of series) {
      const v = Number(d[s.key]) || 0;
      if (v > yMax) yMax = v;
      if (v < yMin) yMin = v;
    }
    if (opts.referenceLines) for (const r of opts.referenceLines) {
      if (r.y > yMax) yMax = r.y;
      if (r.y < yMin) yMin = r.y;
    }
    const ticks = niceTicks(yMin, yMax, 5);
    const yDomain = [ticks[0], ticks[ticks.length - 1]];
    const yToPx = (v) => innerH - ((v - yDomain[0]) / (yDomain[1] - yDomain[0] || 1)) * innerH;

    // Grid + Y labels
    for (const t of ticks) {
      const y = yToPx(t);
      g.appendChild(svgEl("line", {
        class: "cd-chart-grid-line", x1: 0, x2: innerW, y1: y, y2: y,
      }));
      const lbl = svgEl("text", {
        class: "cd-chart-axis-label",
        x: -8, y: y + 3, "text-anchor": "end",
      });
      lbl.textContent = opts.yFormat ? opts.yFormat(t) : String(t);
      g.appendChild(lbl);
    }

    // X axis line
    g.appendChild(svgEl("line", {
      class: "cd-chart-axis-line", x1: 0, x2: innerW, y1: innerH, y2: innerH,
    }));

    // X labels (skip every other if crowded — aim for ~50px between labels)
    const xLabelStep = Math.max(1, Math.ceil((data.length * 50) / innerW));
    data.forEach((d, i) => {
      if (i % xLabelStep !== 0) return;
      const x = xToPx(i);
      const t = svgEl("text", {
        class: "cd-chart-axis-label",
        x, y: innerH + 16, "text-anchor": "middle",
      });
      t.textContent = opts.xFormat ? opts.xFormat(d[opts.xKey]) : String(d[opts.xKey]);
      g.appendChild(t);
    });

    // Reference lines
    if (opts.referenceLines) {
      for (const r of opts.referenceLines) {
        const y = yToPx(r.y);
        g.appendChild(svgEl("line", {
          class: "cd-chart-ref-line",
          x1: 0, x2: innerW, y1: y, y2: y,
          stroke: r.color || "var(--apai-muted)",
        }));
      }
    }

    // Series lines
    for (const s of series) {
      let d = "";
      data.forEach((row, i) => {
        const x = xToPx(i);
        const y = yToPx(Number(row[s.key]) || 0);
        d += (i === 0 ? "M" : "L") + x.toFixed(2) + "," + y.toFixed(2) + " ";
      });
      g.appendChild(svgEl("path", {
        d, fill: "none", stroke: s.color, "stroke-width": 2,
        "stroke-linejoin": "round", "stroke-linecap": "round",
      }));
      if (s.dot) {
        data.forEach((row, i) => {
          g.appendChild(svgEl("circle", {
            cx: xToPx(i), cy: yToPx(Number(row[s.key]) || 0),
            r: 2.5, fill: s.color,
          }));
        });
      }
    }

    // Hover overlay
    overlayRect = svgEl("rect", {
      x: 0, y: 0, width: innerW, height: innerH, fill: "transparent",
    });
    overlayRect.style.cursor = "crosshair";
    g.appendChild(overlayRect);

    // Crosshair line + focused dots (toggled on mousemove)
    const crosshair = svgEl("line", {
      class: "cd-chart-grid-line", y1: 0, y2: innerH, stroke: "var(--apai-muted)",
    });
    crosshair.style.display = "none";
    g.appendChild(crosshair);

    const focusDots = series.map((s) =>
      svgEl("circle", { r: 4, fill: s.color, stroke: "#FFFFFF", "stroke-width": 2 }),
    );
    for (const d of focusDots) { d.style.display = "none"; g.appendChild(d); }

    overlayRect.addEventListener("mousemove", (ev) => {
      const rect = svg.getBoundingClientRect();
      const x = ev.clientX - rect.left - margin.left;
      // Find nearest data index
      const idx = data.length === 1 ? 0 : Math.round((x / innerW) * (data.length - 1));
      const i = clamp(idx, 0, data.length - 1);
      const px = xToPx(i);
      crosshair.setAttribute("x1", px);
      crosshair.setAttribute("x2", px);
      crosshair.style.display = "block";
      series.forEach((s, si) => {
        const y = yToPx(Number(data[i][s.key]) || 0);
        focusDots[si].setAttribute("cx", px);
        focusDots[si].setAttribute("cy", y);
        focusDots[si].style.display = "block";
      });
      const lbl = opts.xFormat ? opts.xFormat(data[i][opts.xKey]) : String(data[i][opts.xKey]);
      const lines = [`<strong>${lbl}</strong>`];
      for (const s of series) {
        const v = data[i][s.key];
        const vStr = opts.yFormat ? opts.yFormat(v) : String(v);
        lines.push(`<span style="color:${s.color}">●</span> ${s.name}: ${vStr}`);
      }
      tooltip.innerHTML = lines.join("<br>");
      tooltip.classList.add("is-visible");
      positionTooltip(ev);
    });

    overlayRect.addEventListener("mouseleave", () => {
      crosshair.style.display = "none";
      for (const d of focusDots) d.style.display = "none";
      tooltip.classList.remove("is-visible");
    });
  }

  function positionTooltip(ev) {
    const rect = container.getBoundingClientRect();
    const x = ev.clientX - rect.left + 12;
    const y = ev.clientY - rect.top  + 12;
    const tw = tooltip.offsetWidth || 0;
    const th = tooltip.offsetHeight || 0;
    tooltip.style.left = `${clamp(x, 0, rect.width  - tw - 4)}px`;
    tooltip.style.top  = `${clamp(y, 0, rect.height - th - 4)}px`;
  }

  function update(newOpts) {
    opts = { ...opts, ...newOpts };
    renderLegend(legend, opts.series || []);
    draw();
  }

  renderLegend(legend, opts.series || []);
  draw();
  ro = new ResizeObserver(() => draw());
  ro.observe(container);

  return {
    update,
    destroy() {
      ro?.disconnect();
      tooltip.remove();
      legend.remove();
      clear(svg);
      container.classList.remove("cd-chart");
    },
  };
}
