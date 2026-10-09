// modules/punchlookup/module.js
//
// Punch Lookup — type part of an associate's name (or a WIN), pick a date
// range, and get every Global Time & Attendance punch in order: time, the
// second it was pressed, what it was made on, the store access point, device
// GPS when present, plus the day's scheduled / worked hours, pay codes, job,
// department and attendance flags. Print it, copy it into an email, or CSV it.
// Shared cases: the person with GTA access pulls the punches into a case
// folder in their OneDrive and shares it with the investigators, who add their
// observations live in the suite (case_service.js, lib/onedrive.js).

import { handlers } from "./service.js";
import { HOST_TAB_ALARM, closeIdleHostTab } from "./lib/onedrive.js";

// Top level, so it survives the service worker sleeping: closes the
// background my.wal-mart.com tab that shared-case saves run in once idle.
chrome.alarms.onAlarm.addListener((a) => { if (a.name === HOST_TAB_ALARM) closeIdleHostTab(); });

export default {
  manifest: {
    id:          "punchlookup",
    group:       "ap",
    name:        "Punch Lookup",
    description: "Time-clock punches and shared wage & hour cases.",
    version:     "0.1.0",
    status:      "alpha",
    ui: {
      kind: "fullpage",
      icon: `
        <circle cx="10" cy="10" r="7"/>
        <path d="M10 6v4l2.5 2.5" stroke-linecap="round" stroke-linejoin="round"/>
      `,
      view: () => import("./view.js"),
    },
    service: { handlers },
    permissions: {
      needs: ["scripting", "tabs"],
      hosts: ["https://timesheet.cloud.wal-mart.com/*", "https://my.wal-mart.com/*"],
    },
    contentScripts: [],
    webRequestFilters: [],
  },
  async register(_host) {},
};
