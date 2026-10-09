// modules/digitalschedule/module.js
//
// Digital Schedule — the wfm-schedule tools in the suite: read a week from the
// Polaris Workforce Planning scheduler, show coverage against its Hours
// Guidance graph (blue = exactly on guidance), queue shift edits by hand or
// from the guidance fitter, check them with the scheduler's own validator, save
// them, and undo a save. Everything runs in the user's own signed-in scheduler
// tab (lib/page.js); the CLI twin is .claude/skills/wfm-schedule.

import { handlers } from "./service.js";

export default {
  manifest: {
    id:          "digitalschedule",
    group:       "digital",
    name:        "Digital Schedule",
    description: "Week coverage vs the WFM Hours Guidance graph, shift edits checked by the scheduler's validator, fit-to-guidance suggestions, undo.",
    version:     "0.1.0",
    status:      "alpha",
    ui: {
      kind: "fullpage",
      // calendar grid with one filled bar
      icon: `
        <rect x="3" y="4" width="14" height="13" rx="2"/>
        <path d="M3 8h14M7 2.5v3M13 2.5v3" stroke-linecap="round"/>
        <path d="M6 12h5" stroke-width="2.2" stroke-linecap="round"/>
      `,
      view: () => import("./view.js"),
    },
    service: { handlers },
    permissions: {
      needs: ["scripting", "tabs", "storage"],
      hosts: ["https://workforce-planning-portal.us-walmart.prod.polaris.walmart.com/*"],
    },
    contentScripts: [],
    webRequestFilters: [],
  },
  async register(_host) {},
};
