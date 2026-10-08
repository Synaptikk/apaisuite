// modules/doorcatch/module.js
//
// Door Catches — what door hosts found leaving the store that was not on the
// receipt. Hosts scan each item's barcode on qrcallbox.com/door (store link +
// pick your name); the catch (time, host, UPCs, quantities) lands in QRCallBox
// Firestore and this module lists it for review: mark reviewed / dismissed
// with a note, filter by host or status, export CSV, manage the host-name list.
// Server half: QRCallBox functions/src/http/doorcatch/index.js.

import { handlers } from "./service.js";

export default {
  manifest: {
    id:          "doorcatch",
    group:       "frontend",
    name:        "Door Catches",
    description: "Items door hosts scanned at the exit that were not on the receipt: when, who caught it, what and how many. Review, note and export.",
    version:     "0.1.0",
    status:      "alpha",
    ui: {
      kind: "fullpage",
      icon: `
        <path d="M4 17V4.5A1.5 1.5 0 0 1 5.5 3h6A1.5 1.5 0 0 1 13 4.5V17" stroke-linejoin="round"/>
        <path d="M2.5 17h15" stroke-linecap="round"/>
        <path d="M10.5 10.5h.01" stroke-linecap="round" stroke-width="2"/>
        <path d="M15 7v6M17 7v6" stroke-linecap="round"/>
      `,
      view: () => import("./view.js"),
    },
    service: { handlers },
    permissions: {
      needs: ["storage"],
      hosts: ["https://qrcallbox.com/*", "https://go-upc.com/*", "https://www.upcitemdb.com/*"],
    },
    contentScripts: [],
    webRequestFilters: [],
  },
  async register(_host) {},
};
