// modules/boblisa/module.js
//
// BoB and Lisa — "Bottom of Basket / Look Inside Always": finds the customer
// who paid, then paid again minutes later for the item a cashier missed.
// Same card token, second sale 1–15 minutes after the first, under 5 items,
// at least $3; training receipts (Money Center 92–94, Vision Center 98) matched by UPC.
// Manned lanes 9–25 = cashier miss; anywhere else = possible theft. Same
// register under 2 minutes = one customer ringing twice (skipped).
// Documented misses (lib/misses.js): the analyst's saved record per pair —
// cause, outcome, cashier, note — kept per store, exported as CSV.
// Source: EJ Viewer via registerls' route. See dev/BOBLISA_FINDINGS.md.

import { handlers } from "./service.js";

export default {
  manifest: {
    id:          "boblisa",
    name:        "BoB and Lisa",
    description: "Missed-item finder: a purchase followed minutes later by a second small purchase on the same card. Likely a large item missed at the register and caught at the door; also flags door-host training receipts.",
    version:     "0.2.0",
    status:      "alpha",
    ui: {
      kind: "fullpage",
      icon: `
        <path d="M3.5 7.5h13l-1.4 7.2a1.5 1.5 0 0 1-1.5 1.3H6.4a1.5 1.5 0 0 1-1.5-1.3z" stroke-linejoin="round"/>
        <path d="M7 7.5 9.2 3.6M13 7.5l-2.2-3.9" stroke-linecap="round"/>
        <path d="M8 10.5v2.5M10 10.5v2.5M12 10.5v2.5" stroke-linecap="round"/>
      `,
      view: () => import("./view.js"),
    },
    service: { handlers },
    permissions: {
      needs: ["storage", "tabs", "scripting"],
      hosts: [
        "https://ej.walmart.com/*",
        "https://apps.apprissretail.com/*",
      ],
    },
    contentScripts: [],
    webRequestFilters: [],
  },
  async register(_host) {},
};
