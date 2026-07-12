// modules/claimsdisposition/lib/pdf.js
//
// Presentation-ready PDF generator for the Claims Disposition dashboard.
// Replaces the browser-print approach (lib/print.js, deleted). The output is
// a multi-page designed report — cover, executive summary, store comparison
// table, daily trend chart, outlier events, and a methodology page — built
// from the SAME canonical record shape the on-screen dashboard consumes.
//
// Library: pdfmake (vendored at vendor/pdfmake/pdfmake.min.js, 1.39 MB).
// Loaded lazily via dynamic <script> tag injection — the bundle never costs
// the user anything until Export PDF is clicked. We use PDF's built-in
// Helvetica (one of the 14 standard fonts every reader has) instead of
// pdfmake's default Roboto, saving the 700 KB vfs_fonts.js bundle.
//
// SVG-in-PDF: pdfmake natively renders SVG as vector graphics. We render
// the trend line chart into a detached div via lib/chart.js (same code the
// dashboard uses) and serialize the resulting <svg> element straight into
// the pdfmake doc def — sharp at any zoom, no canvas rasterization.

import {
  filterRecords, summarize, byStore, dailyMarketSeries, fmtMoney, fmtPct,
} from "./metrics.js";
import { detectOutliers, scoreStores, riskFlagFromScore } from "./outliers.js";
import { formatDate, formatDateFmt } from "./dates.js";
import { createLineChart } from "./chart.js";
import { DISPOSITION_TYPES, MARKET_NUMBER } from "../data/schema.js";
import { RULE_REFERENCE, SEVERITY_LADDER } from "../components/outlierPanel.js";

// Walmart brand tokens — duplicated here (rather than parsing CSS vars) so
// the PDF rendering is independent of the live stylesheet. Update both if
// the brand changes.
const C = {
  blue:        "#0071CE",
  blueDark:    "#005AA8",
  yellow:      "#FFC220",
  ink:         "#1A1A1A",
  muted:       "#6B7280",
  border:      "#E5E7EB",
  borderSoft:  "#F1F2F4",
  bgSoft:      "#F6F7F9",
  critical:    "#DC2626",
  high:        "#F97316",
  watch:       "#F59E0B",
  normal:      "#16A34A",
};

const RISK_COLOR = {
  Critical: C.critical,
  High:     C.high,
  Watch:    C.watch,
  Normal:   C.normal,
};

const SEVERITY_BG = {
  Critical: "#FEE2E2",
  High:     "#FFEDD5",
  Medium:   "#FEF3C7",
  Low:      "#E8F7EC",
};
const SEVERITY_TEXT = {
  Critical: "#7F1D1D",
  High:     "#9A3412",
  Medium:   "#92500E",
  Low:      "#166534",
};

// ── pdfmake bootstrap ───────────────────────────────────────────────
// pdfmake ships as a UMD bundle that attaches `window.pdfMake`. We load it
// lazily via <script> injection on first generate. Cached after first load
// so subsequent exports reuse the same module — important for the user who
// might iterate on filters and re-export several times in one session.
//
// Two scripts are needed:
//   1. pdfmake.min.js  — the engine (1.39 MB)
//   2. vfs_fonts.js    — virtual file system holding font TTFs (~780 KB).
//                        The cdnjs build ships Roboto-Regular/Medium/
//                        Italic/MediumItalic.ttf — no Helvetica AFM
//                        metrics. So we use Roboto for the PDF (clean
//                        professional sans-serif, embeds at ~200 KB into
//                        the output). Bundle cost: ~2.2 MB, loaded ONCE
//                        per session on first export click.
let _pdfMakePromise = null;
function loadPdfMake() {
  if (_pdfMakePromise) return _pdfMakePromise;
  _pdfMakePromise = (async () => {
    if (!globalThis.pdfMake) {
      await injectScript(chrome.runtime.getURL("modules/claimsdisposition/vendor/pdfmake/pdfmake.min.js"));
      if (!globalThis.pdfMake) {
        throw new Error("pdfmake.min.js loaded but window.pdfMake is undefined");
      }
    }
    // vfs_fonts.js mutates window.pdfMake.vfs to add font TTFs. Only inject
    // if the vfs isn't populated yet (the bundle is idempotent but the
    // network/parse cost isn't).
    if (!globalThis.pdfMake.vfs || Object.keys(globalThis.pdfMake.vfs).length === 0) {
      await injectScript(chrome.runtime.getURL("modules/claimsdisposition/vendor/pdfmake/vfs_fonts.js"));
    }
    // Use Roboto (the only fully-embedded font in the cdnjs vfs bundle).
    // The vfs ships Roboto-Regular/Medium/Italic/MediumItalic — map them
    // to pdfmake's normal/bold/italics/bolditalics slots.
    globalThis.pdfMake.fonts = {
      Roboto: {
        normal:      "Roboto-Regular.ttf",
        bold:        "Roboto-Medium.ttf",
        italics:     "Roboto-Italic.ttf",
        bolditalics: "Roboto-MediumItalic.ttf",
      },
    };
    return globalThis.pdfMake;
  })();
  return _pdfMakePromise;
}

function injectScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload  = () => resolve();
    script.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(script);
  });
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Render the trend SVG to a string, then build the pdfmake document.
 * Returns the document definition object — pure (no I/O, no chrome.*).
 * Exported separately from `generateAndDownload` so it's trivially testable.
 *
 * @param {object} state - the view's state object ({ records, filters, ... })
 * @param {object} options - { author, generatedAt, sourcePullMeta }
 *   author: string|null      — "Generated by" line; null hides the line
 *   generatedAt: Date        — when the export happened
 *   sourcePullMeta: object   — { startDate, endDate, pulledAt } from the
 *                              IndexedDB pull record, for the cover
 */
export function buildDocDefinition(state, options) {
  const { records = [], filters = {} } = state;
  const { author, generatedAt = new Date(), sourcePullMeta = {} } = options;

  const filtered = filterRecords(records, filters);
  const sum = summarize(filtered);
  const storeRollup = byStore(filtered);
  const scoreByStore = scoreStores(filtered);
  const outlierEvents = detectOutliers(filtered);

  const realStoreNumbers = [...new Set(filtered.map((r) => r.storeNumber))].sort((a, b) => a - b);

  // ── Cover ──────────────────────────────────────────────────────
  const periodStart = filters.dateRange?.from ?? null;
  const periodEnd   = filters.dateRange?.to ?? null;
  const periodLabel = periodStart && periodEnd
    ? `${formatDate(periodStart)} – ${formatDate(periodEnd)}`
    : "(no date range)";
  const periodDays  = (periodStart && periodEnd)
    ? Math.round((periodEnd - periodStart) / 86_400_000) + 1
    : null;

  const filterSummary = activeFilterSummary(filters);

  const cover = {
    stack: [
      // Top brand strip
      {
        columns: [
          { width: 44, table: { widths: [44], body: [[{
            text: "W", alignment: "center", color: C.yellow,
            bold: true, fontSize: 26, fillColor: C.blue, margin: [0, 2, 0, 2],
          }]] }, layout: "noBorders" },
          { width: "*", margin: [12, 8, 0, 0], stack: [
            { text: "APAISuite", color: C.muted, fontSize: 10, characterSpacing: 1 },
            { text: "Claims Disposition Report", color: C.ink, fontSize: 22, bold: true, margin: [0, 2, 0, 0] },
            { text: `Market ${MARKET_NUMBER}`, color: C.blue, fontSize: 13, margin: [0, 2, 0, 0] },
          ]},
        ],
        margin: [0, 0, 0, 28],
      },

      // Period + scope card
      {
        table: {
          widths: [110, "*"],
          body: [
            metaRow("Period",          `${periodLabel}${periodDays ? `   (${periodDays} days)` : ""}`),
            metaRow("Stores included", realStoreNumbers.length
              ? `${realStoreNumbers.join(", ")}   (${realStoreNumbers.length})`
              : "(none — no records match current filters)"),
            metaRow("Active filters",  filterSummary),
          ],
        },
        layout: cardLayout(),
        margin: [0, 0, 0, 20],
      },

      // Top-line numbers
      {
        table: {
          widths: ["*", "*"],
          body: [[
            bigStatCell("Total claim events", sum.total.toLocaleString(),
                        `${sum.disposalCount.toLocaleString()} disposals · ${sum.donationCount.toLocaleString()} donations`),
            bigStatCell("Total value at cost", fmtMoney(sum.totalValue),
                        `${fmtMoney(sum.disposalValue)} disposal · ${fmtMoney(sum.donationValue)} donation`),
          ]],
        },
        layout: cardLayout({ fillBlue: true }),
        margin: [0, 0, 0, 36],
      },

      // Provenance footer
      { canvas: [{ type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineColor: C.border, lineWidth: 0.5 }] },
      {
        margin: [0, 10, 0, 0],
        table: {
          widths: [110, "*"],
          body: [
            metaRow("Generated",      formatGeneratedAt(generatedAt), { plain: true }),
            ...(author ? [metaRow("Generated by", author, { plain: true })] : []),
            metaRow("Data source",    "apscpi.wal-mart.com — Claims Disposition (Looker Studio embed)", { plain: true }),
            ...(sourcePullMeta.pulledAt ? [metaRow("Live pull at", formatGeneratedAt(new Date(sourcePullMeta.pulledAt)), { plain: true })] : []),
            metaRow("Methodology",    "See last page for outlier rule reference + severity ladder.", { plain: true }),
          ],
        },
        layout: noBorderLayout(),
      },
    ],
    pageBreak: "after",
  };

  // ── Executive summary ─────────────────────────────────────────
  const summaryCards = buildSummaryCards(sum, storeRollup, outlierEvents);
  const topRisk = [...storeRollup]
    .map((s) => ({ ...s, score: scoreByStore.get(s.storeNumber) ?? 0 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  const exec = {
    stack: [
      sectionTitle("Executive Summary"),
      sectionSub("Snapshot of every claim disposition event in the selected scope."),
      // 3×3 grid
      {
        margin: [0, 8, 0, 18],
        table: {
          widths: ["*", "*", "*"],
          body: chunk(summaryCards, 3),
        },
        layout: cardLayout(),
      },

      sectionTitle("Top Risk Stores", { size: 13 }),
      sectionSub("Composite outlier score across all rules. Investigate Critical/High first."),
      topRisk.length === 0
        ? mutedNote("No store-level outliers were detected in this scope.")
        : {
            margin: [0, 8, 0, 0],
            table: {
              widths: [40, "*", 70, 90],
              body: [
                tableHeader(["Rank", "Store", "Score", "Risk"]),
                ...topRisk.map((s, i) => [
                  { text: `#${i + 1}`, alignment: "center", color: C.muted, fontSize: 10 },
                  { stack: [
                    { text: `Store ${s.storeNumber}`, bold: true },
                    { text: `${s.total.toLocaleString()} claims · ${fmtMoney(s.totalValue)} at cost`, color: C.muted, fontSize: 9 },
                  ]},
                  { text: String(s.score), alignment: "center", bold: true },
                  riskBadge(riskFlagFromScore(s.score)),
                ]),
              ],
            },
            layout: tableLayout(),
          },
    ],
    pageBreak: "after",
  };

  // ── Store comparison table ────────────────────────────────────
  const fullStoreTable = [...storeRollup]
    .map((s) => {
      const score = scoreByStore.get(s.storeNumber) ?? 0;
      return { ...s, score, risk: riskFlagFromScore(score) };
    })
    .sort((a, b) => b.score - a.score);

  const storeTablePage = {
    stack: [
      sectionTitle("Store Comparison"),
      sectionSub("All stores in scope, sorted by outlier score. Click rows in the live dashboard to drill into details."),
      {
        margin: [0, 8, 0, 0],
        // Widths sum to ~412 — leaves headroom for tableLayout padding
        // (4 units per side × 10 cells = 80) under the LETTER inner width
        // of ~512. Using a flex '*' last column would also work but locking
        // numeric widths keeps the layout deterministic across record counts.
        table: {
          widths: [32, 42, 38, 56, 38, 56, 38, 38, 30, 50],
          headerRows: 1,
          body: [
            tableHeader(["Store", "Total", "Disp #", "Disp $", "Don #", "Don $", "Disp %", "Don %", "Score", "Risk"]),
            ...fullStoreTable.map((r) => [
              { text: String(r.storeNumber), bold: true, alignment: "center", fontSize: 9 },
              { text: r.total.toLocaleString(),         alignment: "right", fontSize: 8 },
              { text: r.disposalCount.toLocaleString(), alignment: "right", fontSize: 8 },
              { text: fmtMoney(r.disposalValue),        alignment: "right", fontSize: 8 },
              { text: r.donationCount.toLocaleString(), alignment: "right", fontSize: 8 },
              { text: fmtMoney(r.donationValue),        alignment: "right", fontSize: 8 },
              { text: fmtPct(r.disposalRate),           alignment: "right", fontSize: 8, color: C.muted },
              { text: fmtPct(r.donationRate),           alignment: "right", fontSize: 8, color: C.muted },
              { text: String(r.score),                  alignment: "center", bold: true, fontSize: 8 },
              riskBadge(r.risk, { compact: true }),
            ]),
          ],
        },
        layout: tableLayout({ tightPadding: true }),
      },
    ],
    pageBreak: "after",
  };

  // ── Daily trend chart ─────────────────────────────────────────
  const trendSvg = renderTrendSvg(filtered);
  const trendPage = {
    stack: [
      sectionTitle("Daily Trend"),
      sectionSub("Disposals and donations per day across the selected window. Higher line = more activity that day."),
      trendSvg
        ? { svg: trendSvg, width: 515, margin: [0, 12, 0, 4] }
        : mutedNote("No daily data points in the current scope."),
      // The SVG from lib/chart.js doesn't include the legend (it's emitted
      // as a sibling DOM node, not inside the <svg>). Render a small legend
      // strip here so the colors aren't ambiguous in print.
      trendSvg
        ? {
            margin: [0, 0, 0, 8],
            columns: [
              { width: "auto", columns: [
                { width: 10, canvas: [{ type: "rect", x: 0, y: 4, w: 10, h: 4, color: C.blue }] },
                { width: "auto", text: "  Disposals", fontSize: 9, color: C.muted, margin: [0, 0, 16, 0] },
              ]},
              { width: "auto", columns: [
                { width: 10, canvas: [{ type: "rect", x: 0, y: 4, w: 10, h: 4, color: C.yellow }] },
                { width: "auto", text: "  Donations", fontSize: 9, color: C.muted },
              ]},
              { text: "" }, // spacer
            ],
          }
        : null,
      mutedNote(trendCaption(filtered), { italics: true }),
    ].filter(Boolean),
    pageBreak: "after",
  };

  // ── Outlier events ────────────────────────────────────────────
  const outlierPages = buildOutlierSection(outlierEvents);

  // ── Methodology ───────────────────────────────────────────────
  const methodologyPage = {
    stack: [
      sectionTitle("Methodology"),
      sectionSub("Rules and thresholds used to flag outliers across the selected scope."),
      { text: "Outlier rules", style: "h3", margin: [0, 12, 0, 6] },
      {
        table: {
          widths: [30, "*", 180],
          headerRows: 1,
          body: [
            tableHeader(["Rule", "When it fires", "What it catches"]),
            ...RULE_REFERENCE.map((r) => [
              { text: r.id, bold: true, color: C.blue, alignment: "center" },
              { stack: [
                { text: r.title, bold: true },
                { text: r.trigger, fontSize: 9, color: C.muted, margin: [0, 2, 0, 0] },
              ]},
              { text: r.catches, fontSize: 9 },
            ]),
          ],
        },
        layout: tableLayout(),
      },

      { text: "Severity ladder", style: "h3", margin: [0, 18, 0, 6] },
      {
        table: {
          widths: [80, "*"],
          body: SEVERITY_LADDER.map((s) => [
            { text: s.z, bold: true, alignment: "center", color: C.ink },
            riskBadge(s.label === "Critical" || s.label === "High" || s.label === "Medium" || s.label === "Low" ? s.label : "Normal"),
          ]),
        },
        layout: cardLayout(),
      },

      mutedNote(
        "Multi-store rules (R1, R2, R6) are skipped when only one store is " +
        "in scope — mean = value and standard deviation = 0, so no signal is " +
        "possible. Per-day and per-hour rules (R3, R4, R5) still fire on " +
        "single-store data.",
        { italics: true, margin: [0, 16, 0, 0] },
      ),
    ],
  };

  // ── Document assembly ─────────────────────────────────────────
  return {
    pageSize: "LETTER",
    pageMargins: [50, 60, 50, 60],
    defaultStyle: { font: "Roboto", fontSize: 10, color: C.ink, lineHeight: 1.25 },
    styles: {
      h2: { fontSize: 16, bold: true, color: C.ink },
      h3: { fontSize: 12, bold: true, color: C.ink },
    },
    info: {
      title:    `Claims Disposition Report — Market ${MARKET_NUMBER}`,
      author:   author || "APAISuite",
      creator:  "APAISuite",
      subject:  `Claims Disposition · ${periodLabel}`,
      keywords: "claims, disposition, walmart, asset protection",
    },
    header: (currentPage) => currentPage === 1 ? null : {
      // Tiny brand strip on every page after the cover.
      margin: [50, 24, 50, 0],
      columns: [
        { text: "APAISuite · Claims Disposition", color: C.muted, fontSize: 9 },
        { text: periodLabel, alignment: "right", color: C.muted, fontSize: 9 },
      ],
    },
    footer: (currentPage, pageCount) => ({
      margin: [50, 0, 50, 24],
      columns: [
        { text: `Market ${MARKET_NUMBER} · Generated ${formatGeneratedAt(generatedAt)}`,
          color: C.muted, fontSize: 8 },
        { text: `Page ${currentPage} of ${pageCount}`,
          alignment: "right", color: C.muted, fontSize: 8 },
      ],
    }),
    content: [cover, exec, storeTablePage, trendPage, ...outlierPages, methodologyPage],
  };
}

/**
 * End-to-end: lazy-load pdfmake, build the doc, write the PDF to Downloads.
 * Returns { ok, filename, downloadId } on success.
 */
export async function generateAndDownload(state, options = {}) {
  const pdfMake = await loadPdfMake();
  const author = options.author ?? null;
  const generatedAt = options.generatedAt ?? new Date();

  const docDef = buildDocDefinition(state, {
    author,
    generatedAt,
    sourcePullMeta: options.sourcePullMeta ?? {},
  });

  // pdfmake's getBlob is callback-based — wrap in a Promise.
  const blob = await new Promise((resolve, reject) => {
    try {
      pdfMake.createPdf(docDef).getBlob(resolve);
    } catch (e) { reject(e); }
  });

  const filename = makeFilename(state, generatedAt);
  const objectUrl = URL.createObjectURL(blob);
  try {
    const downloadId = await chrome.downloads.download({
      url: objectUrl,
      filename,
      saveAs: false,
      conflictAction: "uniquify",
    });
    // Defer revoke a tick so chrome.downloads has captured the bytes.
    setTimeout(() => { try { URL.revokeObjectURL(objectUrl); } catch (_) {} }, 0);
    return { ok: true, filename, downloadId, bytes: blob.size };
  } catch (e) {
    URL.revokeObjectURL(objectUrl);
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/**
 * Best-effort author lookup: read the gscope `displayname` cookie via a
 * helper tab if one is open. Returns null on any failure — the cover just
 * drops the "Generated by" line. Mirrors the pattern in
 * sparkfraud/service.js::_buildSwiftHeaders but stays view-side (no SW
 * round-trip, no new permissions needed — chrome.tabs + chrome.scripting
 * are already on the manifest for the pull flow).
 */
export async function tryReadAuthor() {
  try {
    const tabs = await chrome.tabs.query({ url: "https://gscope.walmartlabs.com/*" });
    if (!tabs.length) return null;
    for (const tab of tabs) {
      try {
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => document.cookie,
        });
        if (!result) continue;
        // Cookies are inconsistently cased (displayName vs displayname).
        const ci = {};
        for (const part of result.split(/;\s*/)) {
          const i = part.indexOf("=");
          if (i < 0) continue;
          ci[part.slice(0, i).toLowerCase()] = decodeURIComponent(part.slice(i + 1));
        }
        const name = ci.displayname || ci.username || null;
        if (name) return name;
      } catch (_) { /* try next tab */ }
    }
  } catch (_) { /* no permission / no tab / etc — return null */ }
  return null;
}

// ── Internal helpers ──────────────────────────────────────────────

function activeFilterSummary(filters) {
  const parts = [];
  if (filters?.storeNumbers?.length) {
    parts.push(`Stores: ${filters.storeNumbers.join(", ")}`);
  }
  if (filters?.dispositionTypes?.length && filters.dispositionTypes.length < DISPOSITION_TYPES.length) {
    parts.push(`Dispositions: ${filters.dispositionTypes.join(", ")}`);
  } else {
    parts.push("All dispositions");
  }
  if (filters?.severity) {
    parts.push(`Severity ≥ ${filters.severity}`);
  } else {
    parts.push("All severities");
  }
  if (filters?.departments?.length) {
    parts.push(`Departments: ${filters.departments.join(", ")}`);
  }
  return parts.join(" · ");
}

function buildSummaryCards(sum, storeRollup, outlierEvents) {
  const hiDisp = highest(storeRollup, "disposalValue");
  const hiDon  = highest(storeRollup, "donationValue");
  return [
    statCard("Total Disposals", sum.disposalCount.toLocaleString(), "Items dispositioned as disposal", { accent: C.blue }),
    statCard("Total Donations", sum.donationCount.toLocaleString(), "Items dispositioned as donation", { accent: C.yellow }),
    statCard("Disposal $ Value", fmtMoney(sum.disposalValue), "At cost", { accent: C.blue }),
    statCard("Donation $ Value", fmtMoney(sum.donationValue), "At cost", { accent: C.yellow }),
    statCard("Disposal Rate", fmtPct(sum.disposalRate), "of all claim events"),
    statCard("Donation Rate", fmtPct(sum.donationRate), "of all claim events"),
    statCard("Highest Disposal Store", hiDisp ? `#${hiDisp.storeNumber}` : "—", hiDisp ? fmtMoney(hiDisp.disposalValue) : "", { accent: C.blue }),
    statCard("Highest Donation Store", hiDon  ? `#${hiDon.storeNumber}`  : "—", hiDon  ? fmtMoney(hiDon.donationValue)  : "", { accent: C.yellow }),
    statCard("Outlier Events", String(outlierEvents.length), "Across all rules", { accent: C.critical }),
  ];
}

function highest(rollup, key) {
  if (!rollup.length) return null;
  return rollup.reduce((best, s) => (s[key] > best[key] ? s : best), rollup[0]);
}

function buildOutlierSection(events) {
  if (!events.length) {
    return [{
      stack: [
        sectionTitle("Outlier Events"),
        sectionSub("Computed from the canonical rule set (see Methodology page)."),
        mutedNote("No outliers triggered in this scope."),
      ],
      pageBreak: "after",
    }];
  }
  const bySev = { Critical: [], High: [], Medium: [], Low: [] };
  for (const e of events) {
    const bucket = bySev[e.severity] ?? bySev.Low;
    bucket.push(e);
  }
  const order = ["Critical", "High", "Medium", "Low"];
  const stack = [
    sectionTitle("Outlier Events"),
    sectionSub(`${events.length} event${events.length === 1 ? "" : "s"} triggered. Grouped by severity, then by store.`),
  ];
  for (const sev of order) {
    const bucket = bySev[sev];
    if (!bucket.length) continue;
    stack.push({ text: `${sev}  (${bucket.length})`, bold: true, fontSize: 12, color: SEVERITY_TEXT[sev], margin: [0, 14, 0, 6] });
    stack.push({
      table: {
        widths: [30, 40, "*", 100],
        headerRows: 1,
        body: [
          tableHeader(["Rule", "Store", "What happened", "Metric"]),
          ...bucket.map((e) => [
            { text: e.ruleId, bold: true, color: C.blue, alignment: "center", fontSize: 9 },
            { text: String(e.storeNumber), alignment: "center", fontSize: 9 },
            { stack: [
              { text: e.explanation, fontSize: 9 },
              { text: `${e.dateLabel}${e.timeWindow ? " · " + e.timeWindow : ""}`, fontSize: 8, color: C.muted, margin: [0, 2, 0, 0] },
            ]},
            { stack: [
              { text: e.metric, fontSize: 8, color: C.muted },
              { text: `Actual: ${e.actualValue}`, fontSize: 9, bold: true, margin: [0, 1, 0, 0] },
              { text: `Expected: ${e.expectedRange}`, fontSize: 8, color: C.muted },
            ]},
          ]),
        ],
      },
      layout: tableLayout(),
    });
  }
  return [{ stack, pageBreak: "after" }];
}

function renderTrendSvg(records) {
  const dailySeries = dailyMarketSeries(records);
  if (!dailySeries.length) return null;
  // Render the chart into a detached but document-attached div so it has
  // real layout dimensions (createLineChart reads container.clientWidth).
  // The div lives off-screen for ~50ms then gets removed once we have the
  // serialized SVG.
  const offscreen = document.createElement("div");
  offscreen.style.cssText = "position:absolute;left:-99999px;top:0;width:1000px;visibility:hidden;";
  document.body.appendChild(offscreen);
  const slot = document.createElement("div");
  slot.style.width = "1000px";
  offscreen.appendChild(slot);
  let svgString = null;
  try {
    const chart = createLineChart(slot, {
      height: 240,
      data: dailySeries,
      xKey: "dateIso",
      xFormat: (iso) => formatDateFmt(iso, "M/d"),
      yFormat: (v) => v.toLocaleString(),
      series: [
        { key: "disposalCount", name: "Disposals", color: C.blue },
        { key: "donationCount", name: "Donations", color: C.yellow },
      ],
    });
    const svgEl = slot.querySelector("svg");
    if (svgEl) {
      // pdfmake's SVG parser requires xmlns on the root element.
      if (!svgEl.getAttribute("xmlns")) svgEl.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      // Convert percentage width/height to a viewBox so pdfmake can scale it.
      if (svgEl.getAttribute("width") === "100%" || svgEl.getAttribute("height") === "100%") {
        svgEl.setAttribute("width", "1000");
        svgEl.setAttribute("height", "240");
      }
      svgString = new XMLSerializer().serializeToString(svgEl);
    }
    chart.destroy();
  } catch (e) {
    console.warn("[claimsdisposition pdf] trend chart render failed:", e);
  } finally {
    offscreen.remove();
  }
  return svgString;
}

function trendCaption(records) {
  const series = dailyMarketSeries(records);
  if (!series.length) return "";
  let peakDay = series[0], peakValue = 0;
  for (const d of series) {
    const v = d.disposalCount + d.donationCount;
    if (v > peakValue) { peakValue = v; peakDay = d; }
  }
  const totalDispDays = series.filter((d) => d.disposalCount > 0).length;
  return `Peak activity: ${formatDate(peakDay.dateIso)} (${peakValue.toLocaleString()} events). ` +
         `Disposal activity recorded on ${totalDispDays} of ${series.length} days.`;
}

function makeFilename(state, generatedAt) {
  const periodFrom = state.filters?.dateRange?.from;
  const periodTo   = state.filters?.dateRange?.to;
  const isoFrom = periodFrom ? toIso(periodFrom) : "all";
  const isoTo   = periodTo   ? toIso(periodTo)   : "all";
  const stamp = formatStamp(generatedAt);
  return `APAISuite-claims/claims-disposition-${isoFrom}_to_${isoTo}_${stamp}.pdf`;
}

function toIso(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatStamp(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mn = String(d.getMinutes()).padStart(2, "0");
  return `${y}${m}${dd}-${hh}${mn}`;
}

function formatGeneratedAt(d) {
  // "2026-05-28 20:35 EDT" — long enough to be unambiguous, short enough
  // not to wrap.
  const date = formatDateFmt(d, "MMM d, yyyy");
  const hh = String(d.getHours()).padStart(2, "0");
  const mn = String(d.getMinutes()).padStart(2, "0");
  // Best-effort TZ abbreviation from the user's locale.
  const tz = d.toLocaleTimeString("en-US", { timeZoneName: "short" }).split(" ").pop();
  return `${date}  ${hh}:${mn} ${tz}`;
}

// ── pdfmake primitive helpers ──────────────────────────────────────

function sectionTitle(text, opts = {}) {
  return { text, fontSize: opts.size || 16, bold: true, color: C.ink, margin: [0, 0, 0, 2] };
}
function sectionSub(text) {
  return { text, fontSize: 10, color: C.muted, margin: [0, 0, 0, 4] };
}
function mutedNote(text, opts = {}) {
  return { text, fontSize: 10, color: C.muted, italics: opts.italics, margin: opts.margin || [0, 12, 0, 0] };
}

function metaRow(label, value, opts = {}) {
  return [
    { text: label, color: C.muted, bold: true, fontSize: 10, margin: [0, 4, 0, 4] },
    { text: value, color: C.ink, fontSize: 11, margin: [0, 4, 0, 4] },
  ];
}

function bigStatCell(label, value, sub) {
  return {
    margin: [12, 14, 12, 14],
    stack: [
      { text: label, color: C.muted, fontSize: 10, characterSpacing: 0.5 },
      { text: value, color: C.ink, fontSize: 22, bold: true, margin: [0, 4, 0, 0] },
      sub ? { text: sub, color: C.muted, fontSize: 9, margin: [0, 4, 0, 0] } : null,
    ].filter(Boolean),
  };
}

function statCard(title, value, sub, opts = {}) {
  return {
    margin: [8, 10, 8, 10],
    stack: [
      opts.accent ? { canvas: [{ type: "rect", x: 0, y: 0, w: 24, h: 3, color: opts.accent }] } : null,
      { text: title, color: C.muted, fontSize: 8, characterSpacing: 0.5, margin: [0, opts.accent ? 6 : 0, 0, 0] },
      { text: value, color: C.ink, fontSize: 17, bold: true, margin: [0, 3, 0, 0] },
      sub ? { text: sub, color: C.muted, fontSize: 8, margin: [0, 2, 0, 0] } : null,
    ].filter(Boolean),
  };
}

function riskBadge(label, opts = {}) {
  const fill = SEVERITY_BG[label] ?? SEVERITY_BG.Low;
  const text = RISK_COLOR[label] ?? C.normal;
  // Compact variant for tight tables — narrower pill, no outer margin.
  const width = opts.compact ? 46 : 70;
  const fontSize = opts.compact ? 8 : 9;
  return {
    margin: opts.compact ? [0, 1, 0, 1] : [0, 2, 0, 2],
    table: {
      widths: [width],
      body: [[{
        text: label, fillColor: fill, color: text, bold: true,
        fontSize, alignment: "center", margin: [0, 2, 0, 2],
      }]],
    },
    layout: "noBorders",
  };
}

function tableHeader(labels) {
  return labels.map((l) => ({
    text: l, bold: true, color: C.muted, fontSize: 8,
    fillColor: C.bgSoft, characterSpacing: 0.5,
    margin: [4, 6, 4, 6],
    alignment: "left",
  }));
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  // pad final row so the table has uniform columns
  while (out.length && out[out.length - 1].length < n) out[out.length - 1].push({ text: "" });
  return out;
}

// Layout: card-like — light border, full-row fill on first column for meta,
// no vertical/horizontal lines between cells.
function cardLayout(opts = {}) {
  return {
    hLineWidth: () => 0.5,
    vLineWidth: () => 0,
    hLineColor: () => C.border,
    paddingLeft:  () => 8,
    paddingRight: () => 8,
    paddingTop:   () => 6,
    paddingBottom:() => 6,
    fillColor: (rowIndex) => opts.fillBlue && rowIndex === 0 ? "#F5F9FF" : null,
  };
}

// Table layout: row borders + zebra-stripe. `tightPadding: true` shaves the
// per-cell padding for dense numeric tables (like Store Comparison) where
// the default 6-unit padding causes column overflow at LETTER width.
function tableLayout(opts = {}) {
  const pad = opts.tightPadding ? 3 : 6;
  return {
    hLineWidth: (i) => i === 0 || i === 1 ? 1 : 0.5,
    vLineWidth: () => 0,
    hLineColor: (i) => i <= 1 ? C.border : C.borderSoft,
    paddingLeft:  () => pad,
    paddingRight: () => pad,
    paddingTop:   () => opts.tightPadding ? 4 : 5,
    paddingBottom:() => opts.tightPadding ? 4 : 5,
    fillColor: (rowIndex) => rowIndex > 0 && rowIndex % 2 === 0 ? C.bgSoft : null,
  };
}

function noBorderLayout() {
  return {
    hLineWidth: () => 0,
    vLineWidth: () => 0,
    paddingLeft: () => 0,
    paddingRight: () => 0,
    paddingTop:  () => 1,
    paddingBottom:() => 1,
  };
}
