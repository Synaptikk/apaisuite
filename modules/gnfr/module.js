// modules/gnfr/module.js
//
// Supply Orders — the store's MyGNFR (mygnfr.walmart.com) supply carts in one
// readable place: every cart with who ordered it (name + job title), where
// each line is (approval → PO → shipped → delivered), what's late or stuck on
// an approver, items the store orders regularly that haven't been reordered,
// possible double orders, and spend by area / person / month. Read-only: the
// module never submits, edits or approves anything in MyGNFR.

import { handlers } from "./service.js";

export default {
  manifest: {
    id:          "gnfr",
    group:       "storeops",
    name:        "Supply Orders",
    description: "MyGNFR store carts made readable: who ordered what, where every order is, what's late or waiting on approval, and regular supplies nobody has reordered.",
    version:     "0.1.0",
    status:      "alpha",
    ui: {
      kind: "fullpage",
      icon: `
        <path d="M3 4h2l2 9h8l2-6H6.2" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="8.5" cy="16" r="1.2"/>
        <circle cx="14" cy="16" r="1.2"/>
      `,
      view: () => import("./view.js"),
    },
    service: { handlers },
    permissions: {
      needs: ["scripting", "tabs"],
      hosts: ["https://mygnfr.walmart.com/*"],
    },
    contentScripts: [],
    webRequestFilters: [],
  },
  async register(_host) {},
};
