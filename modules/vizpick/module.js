// modules/vizpick/module.js
//
// VizPick Market Rollup — see every store's VizPick backroom-fulfillment
// health (Cases Seen %, Location %, Pick %, Overstock %) for a chosen market
// at once, sourced from the same Tableau workbook Store Ops uses
// (OnlineGrocery/VizPick), without opening Tableau and searching store-by-
// store on the VizPick Details tab.
//
// Capture path mirrors modules/market120's Clearance/Deleted store capture:
// a MAIN-world content script passively rings-buffers VizQL/crosstab network
// responses from the user's own authenticated Tableau tab (read-only), and a
// background-tab orchestrator drives Download → Crosstab → CSV export.

import { handlers, onAlarm, installAlarms, bootstrapIfNeeded } from "./service.js";

// MV3 SW wake constraint: the alarm listener MUST be registered at the top
// level of a module that the service worker imports, not inside register(),
// or a wake delivered before register() runs is dropped.
chrome.alarms.onAlarm.addListener(onAlarm);

export default {
  manifest: {
    id:          "vizpick",
    name:        "VizPick Market Rollup",
    description: "Every store's VizPick backroom health for a chosen market, pulled from Tableau — no per-store search required.",
    version:     "0.1.0",
    status:      "alpha",

    ui: {
      kind:    "fullpage",
      view:    () => import("./view.js"),
    },

    service: {
      handlers,
    },

    permissions: {
      // Same host as market120 — already granted at the top-level manifest.
      needs: ["storage", "tabs", "scripting", "alarms"],
      hosts: ["https://stores.tableau.wal-mart.com/*"],
    },

    contentScripts: [
      { matches: ["https://stores.tableau.wal-mart.com/*"],
        js:      ["modules/vizpick/content/tableau_capture.js"],
        run_at:  "document_start",
        world:   "MAIN",
        all_frames: true },
    ],
    webRequestFilters: [],
  },

  async register(_host) {
    // Periodic stamp check (idempotent).
    await installAlarms();
    // And one on SW boot — which covers every browser start — so the cards are
    // already up to date when the module is opened. Rate-limited internally,
    // and it only re-exports when Tableau's stamp has actually moved.
    bootstrapIfNeeded().catch(() => {});
  },
};
