// modules/safetyobs/module.js
//
// Safety Observations — type what you saw, the QR-poster survey gets filled
// and submitted; at 4:45 PM the "1458 management" Workvivo chat @mentions
// every scheduled coach still under 2 observations today; a ledger shows who
// is behind (2 per scheduled day) since the schedule import began.
// See service.js for the sources.

import { IS_SERVICE_WORKER } from "../../shared/alarms.js";
import { handlers, onCheckAlarm, ensureCheckAlarm, ALARM } from "./service.js";

// Top level + guarded, like every alarm in the suite (shared/alarms.js).
if (IS_SERVICE_WORKER) {
  chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === ALARM) onCheckAlarm(alarm); });
  ensureCheckAlarm().catch((e) => console.warn("[safetyobs] ensureCheckAlarm failed:", e?.message ?? e));
}

export default {
  manifest: {
    id:          "safetyobs",
    group:       "safety",
    name:        "Safety Observations",
    description: "Type an observation in plain words and it fills out the Safety Observation Survey for you. 4:45 PM Workvivo nudge for coaches under 2, and a ledger of who is behind.",
    version:     "0.1.0",
    status:      "alpha",
    ui: {
      kind: "fullpage",
      icon: `
        <path d="M10 2.5 3.5 5v4.5c0 4 2.8 7 6.5 8 3.7-1 6.5-4 6.5-8V5L10 2.5Z" stroke-linejoin="round"/>
        <path d="m7 10 2 2 4-4" stroke-linecap="round" stroke-linejoin="round"/>
      `,
      view: () => import("./view.js"),
    },
    service: { handlers },
    permissions: {
      needs: ["storage", "alarms", "scripting", "tabs"],
      hosts: [
        "https://forms.office.com/*", "https://forms.cloud.microsoft/*",
        "https://app.powerbi.com/*", "https://workvivo.walmart.com/*", "https://puppy-backend.walmart.com/*",
      ],
    },
    contentScripts: [],
    webRequestFilters: [],
  },
  async register(_host) {},
};
