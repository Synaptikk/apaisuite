// modules/stockingplan/module.js
import { handlers as serviceHandlers } from "./service.js";

export default {
  manifest: {
    id:          "stockingplan",
    name:        "StockingPlan",
    description: "Overnight stocking plan: freight from CaseVisibility → labour hours → associate assignments.",
    version:     "0.1.0",
    status:      "active",

    ui: {
      kind: "fullpage",
      // Sidebar + home-card glyph: the INNER markup of a 20x20 stroke icon.
      // The shell wraps it (app.js::iconSvgString) so every module shares one
      // viewBox, stroke width and currentColor. Omit it and the shell falls
      // back to the generic grid glyph.
      icon: `
        <rect x="2.8" y="11.4" width="6" height="5.4" rx=".9"/>
        <rect x="9.6" y="11.4" width="6" height="5.4" rx=".9"/>
        <rect x="6.2" y="5.9" width="6" height="5.4" rx=".9"/>
        <path d="M17.6 3a2.5 2.5 0 1 0 0 4.6 3 3 0 0 1 0-4.6z" stroke-linejoin="round"/>
      `,
      view: () => import("./view.js"),
    },

    service: {
      handlers: serviceHandlers,
    },

    permissions: {
      needs: ["scripting", "tabs", "storage", "clipboardWrite"],
      hosts: [
        "https://radapps3.wal-mart.com/Protected/CaseVisibility/*",
      ],
    },

    contentScripts: [
      {
        matches: ["https://radapps3.wal-mart.com/Protected/CaseVisibility/*"],
        js:      ["modules/stockingplan/content/casevisibility.js"],
        run_at:  "document_idle",
      },
    ],

    webRequestFilters: [],
  },

  async register(_host) {},
};
