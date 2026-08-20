// modules/sparkscango/module.js
//
// Spark & Scan & Go — surfaces Walmart's Spark and Scan & Go exception
// feeds + audit metrics from a Power BI report, and bridges each exception
// row into SparkFraud's proven driver/order/trip lookup workflow.
//
// Follows the plugin-style module contract (docs/MODULE_CONTRACT.md). The
// Power BI capture pattern is cloned from livedashboard's
// content/powerbi_recognition_capture.js (MAIN-world fetch/XHR patch, ring
// buffer, SW-side polling via chrome.scripting.executeScript).

import { handlers, onAlarm, ALARM_NAMES, installAlarms } from "./service.js";

// MV3 SW wake constraint: alarm listener MUST be at top-level of the initial
// script execution. Same pattern livedashboard and workvivo use.
chrome.alarms.onAlarm.addListener(onAlarm);

export default {
  manifest: {
    id:          "sparkscango",
    name:        "Spark & Scan&Go",
    description: "Spark and Scan & Go exceptions, audits, and metrics — one-click investigation into SparkFraud driver/order lookups.",
    version:     "0.1.0",
    status:      "alpha",

    ui: {
      kind: "fullpage",
      view: () => import("./view.js"),
    },

    service: {
      handlers,
    },

    permissions: {
      needs: ["storage", "tabs", "scripting", "alarms"],
      hosts: [
        // Power BI (report tab)
        "https://app.powerbi.com/*",
        "https://*.pbidedicated.windows.net/*",
        // Dispatcher + gscope (investigation bridge — reuses SparkFraud's
        // top-level host permissions; declared here for clarity)
        "https://swift.walmart.com/*",
        "https://gscope.walmartlabs.com/*",
      ],
    },

    contentScripts: [
      // Declared in top-level manifest.json (informational here).
      { file: "content/powerbi_ssg_capture.js", matches: ["https://app.powerbi.com/*"], run_at: "document_start", world: "MAIN", all_frames: true },
    ],

    webRequestFilters: [],
  },

  async register(_host) {
    await installAlarms();
    // Bootstrap pulls are triggered from the view on first mount rather than
    // eagerly at boot — the source pages are heavy and the user should decide
    // when to consume them.
  },
};

export { ALARM_NAMES };
