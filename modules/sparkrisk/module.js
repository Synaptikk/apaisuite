// modules/sparkrisk/module.js
//
// SparkRisk - Pre-checkout timing analysis for Spark Shop & Deliver
//
// Identifies high-risk Spark driver sessions using order-level timing anomalies,
// driver deviation from personal baselines, and context-matched peer comparisons.

// Service handlers must be imported STATICALLY (MV3 requirement)
import { handlers as serviceHandlers } from "./service.js";

export default {
  manifest: {
    id:          "sparkrisk",
    name:        "SparkRisk",
    description: "Pre-checkout timing analysis for Spark Shop & Deliver fraud detection",
    version:     "2.0.0",
    status:      "active",

    ui: {
      kind: "fullpage",
      view: () => import("./view.js"),
    },

    service: {
      handlers: serviceHandlers,
    },

    permissions: {
      needs: ["storage", "tabs", "scripting"],
      hosts: [
        "https://wismo-dashboard.walmart.com/*",
        "https://wismo.walmart.com/*",
        "https://i5.walmartimages.com/*",
        "https://gscope.walmartlabs.com/*",
      ],
    },

    contentScripts: [
      {
        matches: ["https://gscope.walmartlabs.com/*"],
        js: ["content/capture.js"],
        runAt: "document_start",
        world: "MAIN",
      },
    ],

    // No webRequest filters - uses WISMO cookie-based auth
    webRequestFilters: [],
  },

  async register(_host) {
    // Fresh module - no migration needed
    console.log("[SparkRisk] Module registered");
  },
};
