// modules/metricshot/lib/render_card.js
//
// Build the posted image from the REAL VizQL rows instead of screenshotting
// Tableau. Input is parseVizPickResponse() output; output is a self-contained
// SVG string that lib/rasterize.js turns into the PNG we post.
//
// Pure — no chrome.*, no DOM. Node-testable.
//
// Two deliberate choices:
//
//   * Self-contained SVG. Every colour and font size is an inline attribute.
//     The rasteriser hands the markup to an Image with no stylesheet attached,
//     so anything that relied on external CSS would render black-on-black.
//
//   * The palette is duplicated from vizpick/lib/charts.js rather than
//     imported. Importing would make metricshot fail to load whenever vizpick
//     is absent — exactly the cross-module fragility that already exists
//     between licenseintake and aurorbuddy (see docs/AUTH_AUDIT.md). These are
//     six colour constants; a broken import is not worth saving them.
//     Keep in sync with charts.js::BANDS if the brand colours change.

const WM = {
  blue:   "#0053e2",
  orange: "#e07b00",
  red:    "#c53030",
  ink:    "#1a1a1a",
  muted:  "#6b7280",
  rule:   "#e5e7eb",
  bg:     "#ffffff",
};

// Mirrors charts.js::NEAR_BAND — within this many points of goal is "close".
const NEAR_BAND = 5;

// Mirrors format_message.js so the picture and the text below it never
// disagree about which bins are urgent.
const TIERS = [
  { minHours: 12, label: "URGENT >12h", color: WM.red },
  { minHours:  9, label: "HIGH >9h",    color: WM.orange },
  { minHours:  6, label: "AGED >6h",    color: WM.blue },
];

const PICK_GOAL_PCT = 80;
const MAX_DEPT_ROWS = 12;

const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Truncate BEFORE escaping, never after. Slicing escaped text splits entities
// — a department called "Dry Grocery & More" became "…&a", which is malformed
// XML, and an SVG that fails to parse silently rasterises to nothing.
const truncate = (s, n) => {
  const t = String(s ?? "");
  return t.length > n ? t.slice(0, n - 1) + "\u2026" : t;
};

// parseVizPickResponse gives pick % as a 0..1 fraction, but a hand-built
// metric or a future column change could hand us 0..100. Normalise rather
// than render a bar at 0.87% of its goal.
function toPct(v) {
  if (!Number.isFinite(v)) return null;
  return v <= 1.0001 ? v * 100 : v;
}

function bandColor(pct, goal) {
  if (!Number.isFinite(pct)) return WM.muted;
  const v = Math.round(pct);
  if (v >= goal) return WM.blue;
  if (v > goal - NEAR_BAND) return WM.orange;
  return WM.red;
}

/**
 * @param {object} parsed  parseVizPickResponse() output
 * @param {object} meta    { metricName, store, capturedAt, pickGoal }
 * @returns {{svg: string, width: number, height: number}}
 */
export function renderMetricCard(parsed, meta = {}) {
  const {
    metricName = "VizPick Backroom Health",
    store = null,
    capturedAt = null,
    pickGoal = PICK_GOAL_PCT,
  } = meta;

  const depts = (parsed?.departmentBreakout ?? [])
    .map((d) => ({ dept: d.dept, pct: toPct(d.pickPct), picked: d.totalPicked }))
    .filter((d) => d.dept && Number.isFinite(d.pct))
    .sort((a, b) => a.pct - b.pct)          // worst first — that's the point of the post
    .slice(0, MAX_DEPT_ROWS);

  const locs = parsed?.locationDetails ?? [];
  const tierCounts = TIERS.map((t) => ({
    ...t,
    count: locs.filter((l) => Number.isFinite(l.hoursSinceLastScan) && l.hoursSinceLastScan >= t.minHours).length,
  }));

  const W = 900;
  const padX = 32;
  const headerH = 96;
  const tileH = 92;
  const rowH = 30;
  const chartTop = headerH + tileH + 44;
  const H = chartTop + Math.max(1, depts.length) * rowH + 52;

  const parts = [];
  parts.push(`<rect width="${W}" height="${H}" fill="${WM.bg}"/>`);

  // ── Header ──────────────────────────────────────────────────────────────
  parts.push(
    `<text x="${padX}" y="46" font-family="Bogle, Helvetica Neue, Arial, sans-serif" ` +
      `font-size="28" font-weight="700" fill="${WM.ink}">${esc(metricName)}</text>`,
  );
  const sub = [store ? `Store ${esc(store)}` : null, capturedAt ? esc(capturedAt) : null]
    .filter(Boolean)
    .join("  ·  ");
  if (sub) {
    parts.push(
      `<text x="${padX}" y="72" font-family="Bogle, Helvetica Neue, Arial, sans-serif" ` +
        `font-size="15" fill="${WM.muted}">${sub}</text>`,
    );
  }
  parts.push(`<line x1="${padX}" y1="${headerH - 8}" x2="${W - padX}" y2="${headerH - 8}" stroke="${WM.rule}" stroke-width="1"/>`);

  // ── Aged-bin tiles ──────────────────────────────────────────────────────
  const tileW = (W - padX * 2 - 24) / 3;
  tierCounts.forEach((t, i) => {
    const x = padX + i * (tileW + 12);
    const y = headerH + 6;
    parts.push(`<rect x="${x}" y="${y}" width="${tileW}" height="${tileH - 12}" rx="8" fill="${t.color}" opacity="0.08"/>`);
    parts.push(
      `<text x="${x + 16}" y="${y + 34}" font-family="Bogle, Helvetica Neue, Arial, sans-serif" ` +
        `font-size="30" font-weight="700" fill="${t.color}">${t.count}</text>`,
    );
    parts.push(
      `<text x="${x + 16}" y="${y + 58}" font-family="Bogle, Helvetica Neue, Arial, sans-serif" ` +
        `font-size="13" fill="${WM.muted}">${esc(t.label)} unscanned</text>`,
    );
  });

  // ── Department pick % bars ──────────────────────────────────────────────
  // Two separate <text> elements, not one with a <tspan>. A tspan without its
  // own x inherits the parent's, and several renderers restart it there
  // instead of continuing inline — which drew the caption on top of the title.
  parts.push(
    `<text x="${padX}" y="${chartTop - 16}" font-family="Bogle, Helvetica Neue, Arial, sans-serif" ` +
      `font-size="15" font-weight="700" fill="${WM.ink}">Pick % by department</text>`,
  );
  parts.push(
    `<text x="${W - padX}" y="${chartTop - 16}" text-anchor="end" ` +
      `font-family="Bogle, Helvetica Neue, Arial, sans-serif" font-size="13" fill="${WM.muted}">` +
      `goal ${pickGoal}% · lowest first</text>`,
  );

  if (!depts.length) {
    parts.push(
      `<text x="${W / 2}" y="${chartTop + 28}" text-anchor="middle" ` +
        `font-family="Bogle, Helvetica Neue, Arial, sans-serif" font-size="14" fill="${WM.muted}">` +
        `No department rows in this capture</text>`,
    );
  } else {
    const labelW = 150;
    const barX = padX + labelW;
    const barMaxW = W - padX - barX - 76;
    // Goal marker, drawn behind the bars so a bar can cross it.
    const goalX = barX + barMaxW * (pickGoal / 100);
    parts.push(
      `<line x1="${goalX.toFixed(1)}" y1="${chartTop - 4}" x2="${goalX.toFixed(1)}" ` +
        `y2="${chartTop + depts.length * rowH}" stroke="${WM.muted}" stroke-width="1" stroke-dasharray="3 3"/>`,
    );
    depts.forEach((d, i) => {
      const y = chartTop + i * rowH;
      const barH = 18;
      const w = Math.max(2, barMaxW * Math.min(1, d.pct / 100));
      const color = bandColor(d.pct, pickGoal);
      parts.push(
        `<text x="${padX}" y="${y + barH - 4}" font-family="Bogle, Helvetica Neue, Arial, sans-serif" ` +
          `font-size="13" fill="${WM.ink}">${esc(truncate(d.dept, 22))}</text>`,
      );
      parts.push(`<rect x="${barX}" y="${y}" width="${barMaxW}" height="${barH}" rx="4" fill="${WM.rule}"/>`);
      parts.push(`<rect x="${barX}" y="${y}" width="${w.toFixed(1)}" height="${barH}" rx="4" fill="${color}"/>`);
      parts.push(
        `<text x="${barX + barMaxW + 10}" y="${y + barH - 4}" ` +
          `font-family="Bogle, Helvetica Neue, Arial, sans-serif" font-size="13" font-weight="700" ` +
          `fill="${color}">${Math.round(d.pct)}%</text>`,
      );
    });
  }

  parts.push(
    `<text x="${padX}" y="${H - 18}" font-family="Bogle, Helvetica Neue, Arial, sans-serif" ` +
      `font-size="11" fill="${WM.muted}">Rendered by APAISuite from VizPick source data — not a screenshot.</text>`,
  );

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    parts.join("") +
    `</svg>`;

  return { svg, width: W, height: H };
}
