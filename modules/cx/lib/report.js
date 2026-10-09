// modules/cx/lib/report.js
//
// The Cx read as a PDF: something you can attach to an email or put in front of
// a market meeting.
//
// pdfmake is already vendored under `modules/vizpick/vendor/` (and again under
// claimsdisposition). It is a ~2 MB pair of files, so this module loads that
// copy by runtime URL rather than shipping a third — the same cross-module reuse
// digitalrollup makes of metricshot's Workvivo poster, and for the same reason:
// a second copy would drift.
//
// The document definition is a PURE function of the model, so it can be unit
// tested without a browser (lib/tests/report.test.mjs). Only `generateCxPdf`
// touches the DOM, and only the view page ever calls it.

import { withWeekday } from "../../../shared/dates.js";

const PDFMAKE_BASE = "modules/vizpick/vendor/pdfmake";

/** Everything the document draws, in the order it draws it. */
export function cxDocDefinition(model) {
  const { storeNbr, generatedAt, scores, analysis, market, narrative } = model;

  const content = [
    { text: "Customer Experience", style: "title" },
    {
      columns: [
        { text: `Store ${storeNbr ?? "—"}`, style: "subtitle" },
        { text: fmtDate(generatedAt), style: "subtitleRight", alignment: "right" },
      ],
      margin: [0, 0, 0, 14],
    },
  ];

  // ── The written read ──────────────────────────────────────────────────
  if (narrative?.text) {
    content.push({ text: "The read", style: "h2" });
    content.push({
      text: `From store ${storeNbr ?? "—"}'s comments and scores only.`,
      style: "caption", margin: [0, 0, 0, 8],
    });
    content.push(...markdownToPdf(narrative.text));
  }

  // ── Market ────────────────────────────────────────────────────────────
  if (market?.rows?.length) {
    content.push({ text: "The market", style: "h2", margin: [0, 14, 0, 6] });
    content.push({
      text: `Market ${market.marketNbr ?? "—"}, ${market.period ?? "latest published week"}.`
        + (market.market?.nps != null ? ` Market NPS ${market.market.nps}.` : "")
        + (market.homeRank ? ` Store ${storeNbr} ranks ${ordinal(market.homeRank)} of ${market.counts.scored}.` : ""),
      style: "caption", margin: [0, 0, 0, 8],
    });
    content.push(table(
      ["#", "Store", "NPS", "vs LY", "vs market"],
      market.rows.map((r) => [
        r.rank ?? "—",
        { text: String(r.store), style: r.isHome ? "homeStore" : undefined },
        r.nps ?? "—",
        { text: signed(r.vsLy), style: r.vsLy < 0 ? "bad" : "good" },
        { text: signed(r.vsMarket), style: r.vsMarket < 0 ? "bad" : "good" },
      ]),
      [24, "*", 50, 55, 65],
    ));
    content.push({
      text: "Scores only; comments cover your store.",
      style: "caption", margin: [0, 6, 0, 0],
    });
  }

  // ── Scorecard ─────────────────────────────────────────────────────────
  const npsLatest = latestNps(scores);
  if (npsLatest) {
    content.push({ text: "This store", style: "h2", margin: [0, 16, 0, 6] });
    content.push({
      columns: [
        { width: 110, stack: [
          { text: String(npsLatest.ty), style: "bigNumber" },
          { text: `NPS · ${npsLatest.label}`, style: "caption" },
        ] },
        { width: "*", stack: [
          { text: [
            { text: "vs last year  ", style: "caption" },
            { text: signed(npsLatest.ty - (npsLatest.ly ?? npsLatest.ty)), style: npsLatest.ly != null && npsLatest.ty < npsLatest.ly ? "bad" : "good" },
            { text: `   (last year ${npsLatest.ly ?? "—"})`, style: "caption" },
          ] },
          { text: "The week shown is still in progress; on one store that can be a handful of surveys.", style: "caption", margin: [0, 4, 0, 0] },
        ] },
      ],
      margin: [0, 0, 0, 10],
    });

    const subRows = subscoreRows(scores);
    if (subRows.length) {
      content.push(table(
        ["Sub-score", "This year", "Last year", "Change"],
        subRows.map((r) => [r.label, fix(r.ty), fix(r.ly), { text: signed(r.delta, 2), style: r.delta < 0 ? "bad" : "good" }]),
        ["*", 60, 60, 60],
      ));
    }
  }

  // ── Comment analysis ──────────────────────────────────────────────────
  if (analysis) {
    const a = analysis;
    content.push({ text: "What the comments say", style: "h2", margin: [0, 14, 0, 6] });
    content.push({
      text: `Store ${storeNbr ?? "—"} only. `
        + `${num(a.counts.filtered)} comments, ${a.counts.firstDay} to ${a.counts.lastDay}. `
        + `Ratings: ${num(a.ratings.bands.promoter)} at 5 stars, ${num(a.ratings.bands.passive)} at 4, ${num(a.ratings.bands.detractor)} at 1-3.`,
      style: "caption", margin: [0, 0, 0, 10],
    });

    if (a.themes.negative.length) {
      content.push({ text: "Going wrong", style: "h3" });
      content.push(table(
        ["Theme", "Negative", "Positive", "% of opinions negative"],
        a.themes.negative.slice(0, 8).map((t) => [
          t.label, num(t.negative), num(t.positive),
          t.negativeShare == null ? "—" : `${Math.round(t.negativeShare * 100)}%`,
        ]),
        ["*", 60, 60, 120],
      ));
      const quotes = a.themes.negative.slice(0, 3)
        .flatMap((t) => (t.examples?.negative ?? []).slice(0, 2).map((ex) => ({ theme: t.label, ex })));
      if (quotes.length) {
        content.push({ text: "In their words", style: "h4", margin: [0, 8, 0, 4] });
        for (const q of quotes) {
          content.push({
            text: [
              { text: `${q.theme} · ${withWeekday(q.ex.day ?? "")} · ${q.ex.journey ?? ""} · ${q.ex.score ?? "?"}★  `, style: "caption" },
              { text: clip(q.ex.text, 280), style: "quote" },
            ],
            margin: [0, 0, 0, 5],
          });
        }
      }
    }

    if (a.themes.positive.length) {
      content.push({ text: "Going right", style: "h3", margin: [0, 10, 0, 4] });
      content.push(table(
        ["Theme", "Positive", "Negative"],
        a.themes.positive.slice(0, 6).map((t) => [t.label, num(t.positive), num(t.negative)]),
        ["*", 60, 60],
      ));
    }

    const movers = (a.movement?.movers ?? []).filter((m) => !m.thin).slice(0, 8);
    if (movers.length) {
      content.push({ text: "What changed", style: "h3", margin: [0, 12, 0, 4] });
      content.push({
        text: `Last ${a.movement.windowDays} days against the ${a.movement.windowDays} before, as negative mentions per 100 comments.`,
        style: "caption", margin: [0, 0, 0, 4],
      });
      content.push(table(
        ["Theme", "Direction", "Before", "Now", "Change"],
        movers.map((m) => [
          m.label,
          { text: m.direction === "worse" ? "WORSE" : m.direction === "better" ? "better" : "flat",
            style: m.direction === "worse" ? "bad" : m.direction === "better" ? "good" : undefined },
          m.priorRate, m.recentRate,
          { text: signed(m.deltaRate, 1), style: m.deltaRate > 0 ? "bad" : "good" },
        ]),
        ["*", 70, 50, 50, 55],
      ));
    }
  }

  return {
    info: { title: `Cx — store ${storeNbr ?? ""}`, author: "APAISuite" },
    pageSize: "LETTER",
    pageMargins: [40, 40, 40, 46],
    footer: (page, count) => ({
      columns: [
        { text: "", style: "caption", margin: [40, 0, 0, 0] },
        { text: `${page} / ${count}`, alignment: "right", style: "caption", margin: [0, 0, 40, 0] },
      ],
      margin: [0, 12, 0, 0],
    }),
    content,
    styles: {
      title:         { fontSize: 20, bold: true, color: "#0071CE" },
      subtitle:      { fontSize: 11, color: "#5B6472" },
      subtitleRight: { fontSize: 11, color: "#5B6472" },
      h2:            { fontSize: 14, bold: true, color: "#005AA8", margin: [0, 10, 0, 6] },
      h3:            { fontSize: 11, bold: true, margin: [0, 6, 0, 4] },
      h4:            { fontSize: 10, bold: true, color: "#5B6472" },
      bigNumber:     { fontSize: 34, bold: true },
      caption:       { fontSize: 8, color: "#5B6472" },
      quote:         { fontSize: 9, italics: true },
      good:          { color: "#1A7F37", bold: true },
      bad:           { color: "#B91C1C", bold: true },
      homeStore:     { bold: true, color: "#0071CE" },
      th:            { fontSize: 9, bold: true, color: "#374151" },
      td:            { fontSize: 9 },
      body:          { fontSize: 10 },
      bullet:        { fontSize: 10, margin: [0, 0, 0, 3] },
    },
    defaultStyle: { fontSize: 10, lineHeight: 1.25 },
  };
}

// ── helpers ─────────────────────────────────────────────────────────────

function table(headers, rows, widths) {
  return {
    // Whole tables move to the next page rather than splitting across one.
    // With the forced section breaks gone this is what stops a row landing
    // alone under a header, and every table here is well under a page.
    unbreakable: true,
    table: {
      headerRows: 1,
      widths,
      body: [
        headers.map((h) => ({ text: h, style: "th" })),
        ...rows.map((r) => r.map((c) => (typeof c === "object" && c !== null ? { style: "td", ...c } : { text: String(c ?? "—"), style: "td" }))),
      ],
    },
    layout: {
      hLineWidth: (i, node) => (i === 0 || i === 1 || i === node.table.body.length ? 0.6 : 0.3),
      vLineWidth: () => 0,
      hLineColor: (i) => (i === 1 ? "#9AA3AF" : "#E5E7EB"),
      paddingTop: () => 3, paddingBottom: () => 3,
    },
    margin: [0, 0, 0, 6],
  };
}

/**
 * The narrative's markdown, as pdfmake nodes.
 *
 * Deliberately small: the prose comes from one prompt with a fixed heading
 * structure (`## …`, `- …`, `**bold**`), so a full parser would be more code
 * than the input can justify. Anything unrecognised falls through as a plain
 * paragraph rather than being dropped.
 */
export function markdownToPdf(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    const h = /^#{2,4}\s+(.*)$/.exec(line);
    if (h) { out.push({ text: stripInline(h[1]), style: "h3", margin: [0, 8, 0, 3] }); continue; }

    const li = /^[-*+]\s+(.*)$/.exec(line);
    if (li) { out.push({ text: inlineRuns(li[1]), style: "bullet", margin: [10, 0, 0, 3] }); continue; }

    out.push({ text: inlineRuns(line), style: "body", margin: [0, 0, 0, 4] });
  }
  return out;
}

/** `**bold**` → pdfmake text runs. Everything else is left as written. */
export function inlineRuns(s) {
  const runs = [];
  const re = /\*\*([^*]+)\*\*/g;
  let last = 0, m;
  while ((m = re.exec(s))) {
    if (m.index > last) runs.push({ text: s.slice(last, m.index) });
    runs.push({ text: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < s.length) runs.push({ text: s.slice(last) });
  return runs.length ? runs : [{ text: s }];
}

const stripInline = (s) => s.replace(/\*\*/g, "");

function latestNps(scores) {
  const periods = (scores?.nps?.periods ?? []).filter((p) => p.ty != null);
  const last = periods[periods.length - 1];
  return last ? { label: last.labelLong ?? last.label, ty: last.ty, ly: last.ly } : null;
}

function subscoreRows(scores) {
  const periods = scores?.subscores?.periods ?? [];
  const last = [...periods].reverse().find((p) => Object.values(p.scores ?? {}).some((v) => v.ty != null));
  if (!last) return [];
  // Label from the same table the panel uses, so the PDF and the screen cannot
  // drift apart.
  const defs = scores?.subscoreDefs ?? [];
  return defs
    .map((d) => ({ label: d.label, ...(last.scores[d.key] ?? {}) }))
    .filter((r) => r.ty != null)
    .map((r) => ({ ...r, delta: r.ly == null ? 0 : Math.round((r.ty - r.ly) * 100) / 100 }));
}

const num = (n) => (n == null ? "—" : Number(n).toLocaleString());
const fix = (n) => (n == null ? "—" : Number(n).toFixed(2));
const clip = (s, n) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
export function ordinal(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n);
  // 11th, 12th, 13th are the exceptions the last-digit rule gets wrong.
  const teens = v % 100;
  if (teens >= 11 && teens <= 13) return `${v}th`;
  return `${v}${{ 1: "st", 2: "nd", 3: "rd" }[v % 10] ?? "th"}`;
}

function signed(v, decimals = 0) {
  if (v == null || Number.isNaN(v)) return "—";
  const n = Number(v);
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(decimals)}`;
}

function fmtDate(ts) {
  const d = ts ? new Date(ts) : new Date();
  return d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

// ── generation (view page only) ─────────────────────────────────────────

let pdfMakePromise = null;
function loadPdfMake() {
  if (pdfMakePromise) return pdfMakePromise;
  const inject = (src) => new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`couldn't load ${src}`));
    document.head.appendChild(s);
  });
  pdfMakePromise = (async () => {
    if (!globalThis.pdfMake) await inject(chrome.runtime.getURL(`${PDFMAKE_BASE}/pdfmake.min.js`));
    if (!globalThis.pdfMake) throw new Error("the PDF library loaded but did not start");
    if (!globalThis.pdfMake.vfs || !Object.keys(globalThis.pdfMake.vfs).length) {
      await inject(chrome.runtime.getURL(`${PDFMAKE_BASE}/vfs_fonts.js`));
    }
    globalThis.pdfMake.fonts = {
      Roboto: { normal: "Roboto-Regular.ttf", bold: "Roboto-Medium.ttf", italics: "Roboto-Italic.ttf", bolditalics: "Roboto-MediumItalic.ttf" },
    };
    return globalThis.pdfMake;
  })().catch((e) => { pdfMakePromise = null; throw e; });
  return pdfMakePromise;
}

/**
 * Build and save the report. Resolves the filename used.
 *
 * `getBlob` + `chrome.downloads`, NOT pdfmake's own `.download()`. The library
 * builds the document fine either way — a 15.7 KB blob, verified — but its
 * `.download()` uses an anchor + blob URL that silently lands no file from an
 * extension page: the callback fires, nothing is written, and nothing throws.
 * The downloads API writes a real entry and reports its failures.
 */
export async function generateCxPdf(model) {
  const pdfMake = await loadPdfMake();
  const day = new Date(model.generatedAt ?? Date.now()).toISOString().slice(0, 10);
  const name = `cx-${model.storeNbr ?? "store"}-${day}.pdf`;

  const blob = await new Promise((resolve, reject) => {
    try { pdfMake.createPdf(cxDocDefinition(model)).getBlob(resolve); }
    catch (e) { reject(e); }
  });
  if (!blob?.size) throw new Error("the PDF came back empty");

  const url = URL.createObjectURL(blob);
  try {
    await new Promise((resolve, reject) => {
      chrome.downloads.download({ url, filename: name, saveAs: false }, (id) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (id == null) return reject(new Error("the download did not start"));
        resolve(id);
      });
    });
  } finally {
    // Revoked on a delay: the download reads the blob URL asynchronously after
    // the callback, and revoking immediately truncates the file.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  return name;
}
