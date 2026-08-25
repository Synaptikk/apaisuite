// modules/assocpurchases/module.js
//
// Associate Purchases — cross-reference manager markdowns against associate
// discount-card purchases to surface two fraud patterns:
//   1. Self-purchase: an associate who did a markdown then bought that item.
//   2. Cross-purchase (non-food, ≤1 h): any associate who bought a just-marked-
//      down item using their discount card within one hour of the markdown event.
//
// Data sources:
//   • MUMD report  — sf-reports-ui.walmart.com/mumd/detail-mumd-report
//   • APPRISS      — apps.apprissretail.com/walmart-usa (markdown purchase discount card search)
//
// Name resolution: MUMD WINs (ses008s) → real names via Workvivo quick-search.
// Both sf-reports-ui.walmart.com and the APPRISS host are already covered by
// the suite's host_permissions. The APPRISS origin + tenant prefix live in
// shared/appriss.js — never hardcode them here.

import { handlers as serviceHandlers } from "./service.js";

export default {
  manifest: {
    id:          "assocpurchases",
    name:        "Associate Purchases",
    description: "Detect associates who mark items down then purchase them (or buy just-marked items within 1 hour). Pulls from MUMD report + APPRISS discount-card search.",
    version:     "0.1.0",
    status:      "beta",

    ui: {
      kind: "fullpage",
      view: () => import("./view.js"),
    },
    service: {
      handlers: serviceHandlers,
    },

    permissions: {
      needs: ["tabs", "scripting", "storage"],
      hosts: [
        "https://sf-reports-ui.walmart.com/*",
        "https://apps.apprissretail.com/*",
        "https://workvivo.walmart.com/*",
      ],
    },

    contentScripts:    [],
    webRequestFilters: [],
  },

  async register(_host) {},
};
