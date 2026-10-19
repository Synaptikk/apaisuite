// modules/digitalschedule/module.js
//
// ScheduleRight (was Digital Schedule; id kept as digitalschedule so saved queues,
// rules and undo history carry over) — the wfm-schedule tools in the suite, for
// any workgroup / team / role / job code: read a week from the
// Polaris Workforce Planning scheduler, show coverage against its Hours
// Guidance graph (blue = exactly on guidance), queue shift edits by hand or
// from the guidance fitter, check them with the scheduler's own validator, save
// them, and undo a save. Everything runs in the user's own signed-in scheduler
// tab (lib/page.js); the CLI twin is .claude/skills/wfm-schedule.

import { handlers } from "./service.js";

export default {
  manifest: {
    id:          "digitalschedule",
    group:       "storeops",
    name:        "ScheduleRight",
    description: "Any team, role or job code: week coverage vs the WFM Hours Guidance graph, shift edits checked by the scheduler's validator, fit-to-guidance suggestions, undo.",
    version:     "0.2.0",
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
