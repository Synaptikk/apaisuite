// modules/metricshot/module.js
//
// Metric Screenshot Scheduler.
//
// Captures a configured internal metric page (e.g. Tableau viz) on a schedule
// and posts the screenshot into a named Workvivo/Sendbird channel using the
// user's already-authenticated workvivo.walmart.com tab. No new credentials,
// no headless browser, no external server.
//
// Contract: docs/MODULE_CONTRACT.md. Handler dispatch: background/service_worker.js.

// Statically imported so the SW's message dispatcher can reach the handlers
// (MV3 SWs cannot use dynamic import — see the comment block at the top of
// background/service_worker.js).
import { IS_SERVICE_WORKER } from "../../shared/alarms.js";
import { handlers, onAlarm, register } from "./service.js";

// Wake-on-alarm listener MUST be registered at top-level (during initial SW
// script execution). Same constraint as workvivo/module.js and
// closinglist/module.js.
//
// Gated to the service worker: this file is imported by the shell page too,
// and extension pages receive alarm events as well — ungated, every tick
// would fire tick() once in the SW and once in each open suite tab, each
// posting its own screenshot to Workvivo.
//
// installTickAlarm() is NOT called here on purpose: metricshot's alarm is
// started and stopped by the user's schedule, not installed unconditionally.
// It already reads before creating, so it does not have the period-reset bug
// described in shared/alarms.js.
if (IS_SERVICE_WORKER) {
  chrome.alarms.onAlarm.addListener(onAlarm);
}

export default {
  manifest: {
    id:          "metricshot",
    name:        "Metric Shots",
    description: "Scheduled store metric cards, rendered locally from VizPick data and posted to Workvivo channels using your existing authenticated tab.",
    version:     "0.1.0",
    status:      "beta",
    accent:      "#0071CE",

    ui: {
      kind: "fullpage",
      // Sidebar + home-card glyph: the INNER markup of a 20x20 stroke icon.
      // The shell wraps it (app.js::iconSvgString) so every module shares one
      // viewBox, stroke width and currentColor. Omit it and the shell falls
      // back to the generic grid glyph.
      icon: `
        <path d="M3 6.6V4.4a1 1 0 0 1 1-1h2.2M13.8 3.4H16a1 1 0 0 1 1 1v2.2M17 13.4v2.2a1 1 0 0 1-1 1h-2.2M6.2 16.6H4a1 1 0 0 1-1-1v-2.2" stroke-linecap="round"/>
        <path d="M7 13.2V9.6M10 13.2V7M13 13.2v-2.4" stroke-linecap="round"/>
      `,
      view: () => import("./view.js"),
    },

    service: {
      handlers,
    },

    // Informational — the actual grant comes from the top-level manifest.json.
    permissions: {
      // "offscreen" replaced "debugger": the posted image is rendered from
      // VizPick's own rows and rasterised in an offscreen document, instead of
      // being screenshotted over CDP. See lib/capture.js.
      needs: ["alarms", "scripting", "tabs", "storage", "offscreen"],
      hosts: [
        "https://stores.tableau.wal-mart.com/*",
        "https://workvivo.walmart.com/*",
        "https://api-*.sendbird.com/*",
      ],
    },

    contentScripts: [
      {
        matches:    ["https://stores.tableau.wal-mart.com/*"],
        js:         ["modules/metricshot/content/tableau_capture.js"],
        run_at:     "document_start",
        world:      "MAIN",
        all_frames: true,
      },
      {
        matches:    ["https://workvivo.walmart.com/*"],
        js:         ["modules/metricshot/content/wv_session_sniffer.js"],
        run_at:     "document_start",
        world:      "MAIN",
        all_frames: false,
      },
    ],
    webRequestFilters: [],
  },

  register,
};
