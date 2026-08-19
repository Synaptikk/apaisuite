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
import { handlers, onAlarm, register } from "./service.js";

// Wake-on-alarm listener MUST be registered at top-level (during initial SW
// script execution). Same constraint as workvivo/module.js:23 and
// closinglist/module.js:17.
chrome.alarms.onAlarm.addListener(onAlarm);

export default {
  manifest: {
    id:          "metricshot",
    name:        "Metric Shots",
    description: "Scheduled screenshots of internal metric dashboards, posted to Workvivo channels using your existing authenticated tab.",
    version:     "0.1.0",
    status:      "beta",
    accent:      "#0071CE",

    ui: {
      kind: "fullpage",
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

    contentScripts: [],
    webRequestFilters: [],
  },

  register,
};
