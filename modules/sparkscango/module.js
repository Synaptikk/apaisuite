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

import { IS_SERVICE_WORKER } from "../../shared/alarms.js";
import { handlers, onAlarm, ALARM_NAMES, installAlarms } from "./service.js";

// MV3 SW wake constraint: the alarm listener MUST be at top level of the
// initial script execution, and so must the install — see shared/alarms.js.
// Same pattern livedashboard, workvivo, digitallocks and vizpick use.
if (IS_SERVICE_WORKER) {
  chrome.alarms.onAlarm.addListener(onAlarm);
  installAlarms().catch((e) =>
    console.warn("[sparkscango] installAlarms failed:", e?.message ?? e));
}

export default {
  manifest: {
    id:          "sparkscango",
    name:        "Spark & Scan&Go",
    description: "Spark and Scan & Go exceptions, audits, and metrics — one-click investigation into SparkFraud driver/order lookups.",
    version:     "0.1.0",
    status:      "alpha",

    ui: {
      kind: "fullpage",
      // Sidebar + home-card glyph: the INNER markup of a 20x20 stroke icon.
      // The shell wraps it (app.js::iconSvgString) so every module shares one
      // viewBox, stroke width and currentColor. Omit it and the shell falls
      // back to the generic grid glyph.
      icon: `
        <rect x="5.4" y="2.8" width="8.2" height="14.4" rx="1.6"/>
        <path d="M7.6 6.6v4.2M9.4 6.6v4.2M11.4 6.6v4.2" stroke-linecap="round"/>
        <path d="M7.4 14.2h4.2" stroke-linecap="round" opacity=".5"/>
        <path d="M17.2 3.1v2.4M16 4.3h2.4" stroke-linecap="round"/>
      `,
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

  // Alarms are installed at top level above, in the service worker.
  // Bootstrap pulls are triggered from the view on first mount rather than
  // eagerly at boot — the source pages are heavy and the user should decide
  // when to consume them.
  async register(_host) {},
};

export { ALARM_NAMES };
