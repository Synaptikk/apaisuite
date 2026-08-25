// modules/digitalmetrics/content/tableau_capture.js
//
// MAIN-world content script for stores.tableau.wal-mart.com.
//
// Exposes a small driver over Tableau's embedded JS API so the service worker
// can apply the store/date filters and pull summary data for the Associate
// Performance worksheet.
//
// ── Coexistence with modules/metricshot ────────────────────────────────────
// metricshot ALSO runs a MAIN-world script on this host. It works by
// monkey-patching window.fetch to ring-buffer VizQL responses. This script
// touches neither fetch nor XHR — it only reads window.tableau — so the two
// cannot interfere. The namespaced global below keeps it that way if this
// ever grows.
//
// Public API (SW reads via chrome.scripting.executeScript world:"MAIN"):
//   __APAISUITE_DIGITALMETRICS_TABLEAU.ready()
//   __APAISUITE_DIGITALMETRICS_TABLEAU.filters()
//   __APAISUITE_DIGITALMETRICS_TABLEAU.applyFilter(name, values)
//   __APAISUITE_DIGITALMETRICS_TABLEAU.summary(worksheetPattern)

(() => {
  const KEY = "__APAISUITE_DIGITALMETRICS_TABLEAU";
  if (window[KEY]) return;

  /** The embedded viz, however this build of Tableau exposes it. */
  function viz() {
    if (window.tableau?.VizManager?.getVizs) {
      const all = window.tableau.VizManager.getVizs();
      if (all?.length) return all[0];
    }
    // Newer embeds put the viz on the custom element itself.
    const el = document.querySelector("tableau-viz, tableau-authoring-viz");
    return el || null;
  }

  function sheets() {
    const v = viz();
    if (!v) return [];
    const wb = v.getWorkbook?.();
    const active = wb?.getActiveSheet?.();
    if (!active) return [];
    // A dashboard contains worksheets; a worksheet is its own single sheet.
    return active.getSheetType?.() === "dashboard"
      ? active.getWorksheets?.() || []
      : [active];
  }

  function findSheet(pattern) {
    const want = String(pattern || "").toLowerCase();
    const all = sheets();
    return all.find((s) => s.getName?.().toLowerCase().includes(want)) || all[0] || null;
  }

  const api = {
    /** Is the viz loaded enough to drive? */
    ready() {
      try { return sheets().length > 0; } catch { return false; }
    },

    /** Filter names on the active sheet, so the SW can match them loosely. */
    async filters(worksheetPattern) {
      const sheet = findSheet(worksheetPattern);
      if (!sheet) return { ok: false, reason: "no worksheet" };
      const list = await sheet.getFiltersAsync();
      return {
        ok: true,
        filters: list.map((f) => ({
          name: f.getFieldName?.() ?? "",
          type: f.getFilterType?.() ?? "unknown",
        })),
      };
    },

    async applyFilter(worksheetPattern, fieldName, values) {
      const sheet = findSheet(worksheetPattern);
      if (!sheet) return { ok: false, reason: "no worksheet" };
      try {
        await sheet.applyFilterAsync(fieldName, values, "replace");
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: String(e?.message ?? e) };
      }
    },

    /**
     * Summary rows as plain objects, keyed by column name.
     *
     * Returns Tableau's MELTED shape (Measure Names / Measure Values);
     * lib/data/tableau.js pivots it. Deliberately not pivoted here — this runs
     * in the page and should stay as thin and as replaceable as possible.
     */
    async summary(worksheetPattern) {
      const sheet = findSheet(worksheetPattern);
      if (!sheet) return { ok: false, reason: "no worksheet" };

      try {
        const data = await sheet.getSummaryDataAsync({ maxRows: 0, ignoreSelection: true });
        const cols = data.getColumns().map((c) => c.getFieldName());
        const rows = data.getData().map((row) => {
          const out = {};
          row.forEach((cell, i) => { out[cols[i]] = cell.formattedValue ?? cell.value; });
          return out;
        });
        return { ok: true, columns: cols, rows };
      } catch (e) {
        return { ok: false, reason: String(e?.message ?? e) };
      }
    },
  };

  Object.defineProperty(window, KEY, { value: Object.freeze(api), configurable: false });
})();
