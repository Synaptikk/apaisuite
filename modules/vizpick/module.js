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

import { handlers } from "./service.js";

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
      needs: ["storage", "tabs", "scripting"],
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
    // No alarms/bootstrap pulls yet — manual Refresh only, same as
    // market120 Pass 1. A periodic alarm can be added later if wanted.
  },
};
