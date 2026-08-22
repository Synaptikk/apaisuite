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
      // Sidebar + home-card glyph: the INNER markup of a 20x20 stroke icon.
      // The shell wraps it (app.js::iconSvgString) so every module shares one
      // viewBox, stroke width and currentColor. Omit it and the shell falls
      // back to the generic grid glyph.
      icon: `
        <circle cx="9.4" cy="11" r="5.9"/>
        <path d="M9.4 8.2v2.8l2 1.4" stroke-linecap="round"/>
        <path d="M7.4 3.2h4M9.4 3.2v1.9" stroke-linecap="round"/>
        <path d="M16.8 3.1v2.4M15.6 4.3h2.4" stroke-linecap="round"/>
      `,
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
