// modules/sparkfraud/module.js
//
// SparkFraud — correlate register events to Spark/Express
// delivery trips for fraud investigation. Migrated from the
// standalone SparkFraud donor extension (see docs/SOURCE_MAPPING.md).

// service.js is imported STATICALLY because MV3 service workers cannot use
// dynamic import() — the HTML spec disallows it on ServiceWorkerGlobalScope
// (W3C ServiceWorker issue #1356). Same shape as the other modules.
import { handlers as serviceHandlers } from "./service.js";

export default {
  manifest: {
    id:          "sparkfraud",
    name:        "SparkFraud",
    description: "Correlate register events to candidate Spark/Express delivery trips and order items.",
    version:     "0.1.0",
    status:      "active",
    // Uses the suite's default blue accent — no override.

    ui: {
      kind: "fullpage",
      // Sidebar + home-card glyph: the INNER markup of a 20x20 stroke icon.
      // The shell wraps it (app.js::iconSvgString) so every module shares one
      // viewBox, stroke width and currentColor. Omit it and the shell falls
      // back to the generic grid glyph.
      icon: `
        <path d="M5.6 3.4h7.6a1 1 0 0 1 1 1v12.2l-2-1.3-2 1.3-2-1.3-2 1.3V4.4a1 1 0 0 1 1-1z" stroke-linejoin="round"/>
        <path d="M7.6 7.4h4M7.6 10.2h4" stroke-linecap="round"/>
        <path d="M16.4 4.2v2.6M15.1 5.5h2.6" stroke-linecap="round"/>
      `,
      view: () => import("./view.js"),
    },
    service: {
      handlers: serviceHandlers,
    },

    permissions: {
      // `browsingData` is used ONLY by the clearGscopeState handler (the
      // 🧹 recovery button). Kept per the PERMISSIONS_MATRIX decision to
      // retain in v1 + revisit in Phase 6.
      needs: ["cookies", "storage", "tabs", "scripting", "browsingData"],
      hosts: [
        "https://gscope.walmartlabs.com/*",
        "https://gscope.walmart.com/*",
        "https://swift.walmart.com/*",
        "https://i5.walmartimages.com/*",
        "https://i.walmartimages.com/*",
        "https://www.walmart.com/*",
      ],
    },

    // MAIN-world capture script — install-guard name is suite-prefixed to
    // avoid collision with the standalone donor (see content/capture.js).
    contentScripts: [
      {
        matches: [
          "https://gscope.walmartlabs.com/mfe/ordermanagement/orderresolution*",
          "https://gscope.walmartlabs.com/mfe/spark/dashboard*",
        ],
        js:         ["modules/sparkfraud/content/capture.js"],
        run_at:     "document_start",
        world:      "MAIN",
        all_frames: true,
      },
    ],

    // No webRequest filters — SparkFraud uses cookie-based auth via in-tab
    // fetch (the readCookiesViaTab workaround for Walmart corp Edge's gutted
    // chrome.cookies API). No headers to capture passively.
    webRequestFilters: [],
  },

  async register(_host) {
    // No legacy-key migration: the standalone SparkFraud lives at its own
    // extension id with isolated chrome.storage; this is a fresh install.
    // See docs/SOURCE_MAPPING.md::Original extensions retirement status.
  },
};
