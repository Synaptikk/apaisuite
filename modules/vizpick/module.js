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

import { IS_SERVICE_WORKER } from "../../shared/alarms.js";
import { handlers, onAlarm, installAlarms, bootstrapIfNeeded } from "./service.js";

// This file is imported by BOTH the service worker (via shared/registry.js ->
// modules/_registry.js) and the shell page app.html, which imports the same
// registry to read manifests. Everything below is service-worker-only work, so
// it is gated: an extension page also receives chrome.alarms events, and an
// ungated onAlarm would run autoCheck() twice on every tick — once in the SW,
// once in any open suite tab. Those are separate module instances with
// separate `todayRun` guards, so the two crawls would fight over the same
// Tableau tabs and the same Store parameter.
if (IS_SERVICE_WORKER) {
  // MV3 SW wake constraint: the alarm listener MUST be registered during the
  // initial script execution, not inside register(), or a wake delivered
  // before register() runs is dropped.
  chrome.alarms.onAlarm.addListener(onAlarm);

  // The same constraint applies to INSTALLING the alarm, which is what was
  // actually broken: register() is called from app.js when the shell mounts a
  // module and never runs in the service worker at all. With the install
  // living there, the periodic check existed only while someone had the suite
  // tab open, and a browser that had never opened VizPick had no alarm at all.
  //
  // Top level here runs on every SW boot, which is the real "browser start"
  // hook. Both calls are internally rate-limited — installAlarms() no-ops when
  // the alarm already has the right period, bootstrapIfNeeded() skips if it
  // checked within the last 10 minutes — so an SW that wakes twenty times an
  // hour still drives Tableau at most once.
  installAlarms().catch((e) => console.warn("[vizpick] installAlarms failed:", e?.message ?? e));
  bootstrapIfNeeded().catch(() => {});
}

export default {
  manifest: {
    id:          "vizpick",
    name:        "VizPick Market Rollup",
    description: "Every store's VizPick backroom health for a chosen market, pulled from Tableau — no per-store search required.",
    version:     "0.1.0",
    status:      "alpha",

    ui: {
      kind:    "fullpage",
      // Sidebar + home-card glyph: the INNER markup of a 20x20 stroke icon.
      // The shell wraps it (app.js::iconSvgString) so every module shares one
      // viewBox, stroke width and currentColor. Omit it and the shell falls
      // back to the generic grid glyph.
      icon: `
        <circle cx="10" cy="10" r="6.6" opacity=".35"/>
        <path d="M10 3.4a6.6 6.6 0 0 1 5.7 9.9" stroke-width="2.1" stroke-linecap="round"/>
        <circle cx="10" cy="10" r="1.5"/>
      `,
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

  // The alarm install and the boot check now happen at top level above, so
  // they run in the service worker rather than only when the shell mounts
  // this module. Kept as a no-op: register() is part of the module contract
  // and a future shell-side hook belongs here, not back in the SW path.
  async register(_host) {},
};
