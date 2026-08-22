// modules/market120/module.js
//
// Market 120 Clearance & ISA Review — combined executive dashboard.
//
// Two independent metric families (never merged per user rule):
//   1. Clearance / Deleted — from Tableau Backroom/ClearanceDeleted (Market 120 aggregate).
//   2. ISA activity        — from Power BI ISA Detail + Backroom Adjustments.
//
// See docs/ (project's Trey/artifacts/PHASE_1_DISCOVERY.md) for the field/filter
// inventory that motivates this module.
//
// Pass 1 (this version): skeleton only. Refresh writes a stub payload so the
// UI plumbing can be verified end-to-end before wiring real capture scripts.

import { handlers } from "./service.js";

export default {
  manifest: {
    id:          "market120",
    name:        "Market 120 Clearance & ISA",
    description: "Executive Overview combining Tableau Clearance/Deleted (Market 120 aggregate) with Power BI ISA activity, per-family with alerts.",
    version:     "0.1.0",
    status:      "alpha",

    ui: {
      kind:    "fullpage",
      // Sidebar + home-card glyph: the INNER markup of a 20x20 stroke icon.
      // The shell wraps it (app.js::iconSvgString) so every module shares one
      // viewBox, stroke width and currentColor. Omit it and the shell falls
      // back to the generic grid glyph.
      icon: `
        <path d="M16.8 10.4V4.2a1 1 0 0 0-1-1H9.6a1 1 0 0 0-.7.3l-5.6 5.6a1 1 0 0 0 0 1.4l5.2 5.2a1 1 0 0 0 1.4 0l5.6-5.6a1 1 0 0 0 .3-.7z" stroke-linejoin="round"/>
        <circle cx="13.3" cy="6.7" r="1.1"/>
      `,
      view:    () => import("./view.js"),
    },

    service: {
      handlers,
    },

    permissions: {
      // Store-level Tableau crosstab capture drives the ClearanceDeleted tab,
      // so we need tabs+scripting and the Tableau host. Power BI host is
      // declared at the suite manifest level (shared with other modules).
      needs: ["storage", "tabs", "scripting"],
      hosts: ["https://stores.tableau.wal-mart.com/*"],
    },

    contentScripts: [],
    webRequestFilters: [],
  },

  async register(_host) {
    // Pass 1 has no alarms and no bootstrap pulls. Pass 2 adds an optional
    // periodic alarm when the user opts in.
  },
};
