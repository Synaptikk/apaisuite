// modules/compliance/module.js
//
// Compliance Tasks — the store's Enviance (Cority) facility tasks: weekly
// eyewash + hazwaste, monthly SPCC / fire extinguisher / emergency lights /
// safety assessment / AP security tour. A calendar of what is due against the
// store's "done by the 10th" rule, what each form asks and what this store
// usually answers (learned from its last completions), a printable paper copy
// to walk, and a fill-in panel that saves the walked answers to Enviance or
// completes the task. Reads and writes through the user's Enviance session in
// a go.enviance.com tab (lib/enviance.js).

import { handlers } from "./service.js";

export default {
  manifest: {
    id:          "compliance",
    group:       "safety",
    name:        "Compliance Tasks",
    description: "Facility compliance tasks: calendar, paper copy and one-click submit.",
    version:     "0.1.0",
    status:      "alpha",
    ui: {
      kind: "fullpage",
      icon: `
        <rect x="3.5" y="4" width="13" height="13" rx="1.5"/>
        <path d="M3.5 8h13M7 2.5v3M13 2.5v3" stroke-linecap="round"/>
        <path d="M7 12.2l1.8 1.8 4-4" stroke-linecap="round" stroke-linejoin="round"/>
      `,
      view: () => import("./view.js"),
    },
    service: { handlers },
    permissions: {
      needs: ["storage", "scripting", "tabs"],
      hosts: ["https://go.enviance.com/*"],
    },
    contentScripts: [],
    webRequestFilters: [],
  },
  async register(_host) {},
};
