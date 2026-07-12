// modules/claimsdisposition/components/header.js
//
// Page header: Walmart "W" logo block, title, subtitle, Export PDF button.
// Ported from donor src/components/Header.jsx (28 LOC) + ExportButton.jsx (19 LOC).
//
// The Export PDF button now generates a real multi-page report via pdfmake
// (see lib/pdf.js). It used to call window.print() — that route was
// abandoned because the browser print dialog appends URL/timestamp headers
// and produces a screen-capture-looking PDF instead of a designed report.

import { h, replace } from "../lib/dom.js";

const SUBTITLE = "Disposal and Donation Trends";

export function createHeader() {
  // We need the latest state at click-time (filters, records, the most-
  // recent pull's metadata). update() stashes it here so the click handler
  // always reads fresh values rather than a stale closure from mount time.
  let lastState = null;
  let busy = false;

  const exportBtn = h("button",
    {
      type: "button",
      class: "cd-btn cd-btn-primary cd-no-print",
      title: "Generate a multi-page PDF report from the current filtered view",
    },
    downloadIcon(),
    h("span", { class: "cd-export-label" }, "Export PDF"),
  );

  // Capture click. Lazy-imports lib/pdf.js so the 1.4 MB pdfmake bundle
  // doesn't penalize initial dashboard mount — only loaded on first click.
  exportBtn.addEventListener("click", async () => {
    if (busy) return;
    if (!lastState || !lastState.records?.length) {
      // Belt-and-braces — the button shouldn't be clickable in this state
      // but guard anyway.
      console.warn("[claimsdisposition] Export PDF clicked with no records");
      return;
    }
    setBusy(true);
    try {
      // Late-bind the module so we don't hold the pdfmake bundle in memory
      // for users who never export.
      const { generateAndDownload, tryReadAuthor } = await import("../lib/pdf.js");
      // Best-effort author lookup runs in parallel with PDF gen — if it
      // hasn't resolved by the time the doc def is being built we just
      // fall back to no author line. It's typically < 100ms.
      const authorPromise = tryReadAuthor();
      const author = await Promise.race([
        authorPromise,
        new Promise((r) => setTimeout(() => r(null), 800)),
      ]);
      const result = await generateAndDownload(lastState, {
        author,
        generatedAt: new Date(),
        sourcePullMeta: lastState.sourcePullMeta ?? {},
      });
      if (!result.ok) {
        console.error("[claimsdisposition] PDF export failed:", result.error);
        alert(`PDF export failed: ${result.error}`);
      } else {
        console.log(`[claimsdisposition] wrote PDF (${Math.round(result.bytes / 1024)} KB) to ${result.filename}`);
      }
    } catch (e) {
      console.error("[claimsdisposition] PDF export threw:", e);
      alert(`PDF export threw: ${e?.message ?? e}`);
    } finally {
      setBusy(false);
    }
  });

  function setBusy(b) {
    busy = b;
    exportBtn.disabled = b;
    const label = exportBtn.querySelector(".cd-export-label");
    if (label) label.textContent = b ? "Generating…" : "Export PDF";
  }

  const root = h("div", { class: "cd-header" },
    h("h1", null, "Claims Disposition Dashboard"),
    h("span", { class: "cd-header-subtitle" }, SUBTITLE),
    h("div", { class: "cd-header-actions cd-no-print" }, exportBtn),
  );

  return {
    root,
    update(state) {
      lastState = state;
      // Disable when there's no data — clicking would just print an
      // empty report.
      const hasData = !!state.records?.length;
      if (!busy) exportBtn.disabled = !hasData;
    },
    destroy() { /* no listeners outside the click handler — it lives with the button */ },
  };
}

function downloadIcon() {
  // Inline SVG matches donor ExportButton.jsx exactly (16×16 download arrow).
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.innerHTML = `
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  `;
  return svg;
}
