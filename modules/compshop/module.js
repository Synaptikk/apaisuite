// modules/compshop/module.js
//
// Comp Shop Prep — the produce items 1458 comp shops (ALDI, Food City) from
// the Comp Shop Power BI report, each with its photo, a scannable barcode or
// PLU, our price, the competitor's last scanned price and any weekly-ad price
// running within a week either side of today (Flipp). Rows turn yellow when
// the competitor is slightly cheaper and red when the gap is large. Read-only:
// prices are entered in Me@ Comp Shop by hand, never from here.

import { handlers } from "./service.js";

export default {
  manifest: {
    id:          "compshop",
    group:       "storeops",
    name:        "Comp Shop Prep",
    description: "Produce competitors sell for less, with barcodes, our price, their price and ad dates.",
    version:     "0.1.0",
    status:      "alpha",
    ui: {
      kind: "fullpage",
      icon: `
        <path d="M4 5v10M6.5 5v10M9 5v10M12.5 5v10M15 5v10" stroke-linecap="round"/>
        <path d="M3 3h14v14H3z" fill="none" stroke-linejoin="round"/>
      `,
      view: () => import("./view.js"),
    },
    service: { handlers },
    permissions: {
      needs: ["scripting", "tabs"],
      hosts: ["https://app.powerbi.com/*", "https://backflipp.wishabi.com/*", "https://f.wishabi.net/*", "https://www.walmart.com/*"],
    },
    contentScripts: [],
    webRequestFilters: [],
  },
  async register(_host) {},
};
