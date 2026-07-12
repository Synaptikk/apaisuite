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
