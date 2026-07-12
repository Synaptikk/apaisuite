// modules/livedashboard/module.js
//
// Live Dashboard module. Header/home surface for AP operational signals.
// See docs/live_dashboard_backend/ for the full discovery package.
//
// Phase 1 (this version):
//   - Source A (absences) — bridge to existing closinglist IVR scraper
//   - Source D (CVP)      — Hoops tRPC pull, per-store, current week
//   - Sources B/C/E placeholder widgets ("Phase 2 / V1.5 pending")

import { handlers, onAlarm, ALARM_NAMES, installAlarms, bootstrapIfNeeded } from "./service.js";

// MV3 SW wake constraint: alarm listener MUST be registered at top-level of
// the SW's initial script execution. Same constraint workvivo follows.
chrome.alarms.onAlarm.addListener(onAlarm);

export default {
  manifest: {
    id:          "livedashboard",
    name:        "Live Dashboard",
    description: "Daily AP operational dashboard: callouts, compliance, accident evidence, CVP, register exceptions.",
    version:     "0.1.0",
    status:      "beta",

    ui: {
      // "home-header" = not in sidebar, not a routed page. The shell's
      // renderHome() looks up this module and mounts its view above the
      // module-card grid. Cleanup is tracked the same way as fullpage
      // mounts so navigating away from #/home releases listeners.
      kind:    "home-header",
      surface: "home-header",
      view:    () => import("./view.js"),
    },

    service: {
      handlers,
    },

    permissions: {
      needs: ["storage", "tabs", "scripting", "alarms"],
      hosts: [
        // CVP (Hoops) — uses *.wal-mart.com wildcard already in manifest
        "https://hoops.wal-mart.com/*",
        // Absences — uses closinglist's existing IVR setup, not new
        "https://ivrattcloud-prod.wal-mart.com/*",
        // Compliance (Phase 2) — not yet in top-level manifest
        // "https://go.enviance.com/*",
      ],
    },

    // No new content scripts in Phase 1 (Absences reuses closinglist's
    // existing ivr.js declaration).
    contentScripts: [],

    // No webRequest header capture needed — Hoops uses session cookies only.
    webRequestFilters: [],
  },

  async register(_host) {
    // Install/refresh the periodic alarms. Idempotent.
    await installAlarms();
    // On initial dashboard open, fan out pulls for any empty/stale source
    // so widgets populate without waiting for the first alarm tick. The
    // call is fire-and-forget — pulls broadcast source_complete on their
    // own; view.js's subscriber re-paints as data arrives. Already-fresh
    // sources are skipped so re-opening the dashboard 5 min later doesn't
    // re-pull anything heavy.
    await bootstrapIfNeeded();
  },
};

export { ALARM_NAMES };
