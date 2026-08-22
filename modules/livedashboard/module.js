// modules/livedashboard/module.js
//
// Live Dashboard module. Header/home surface for AP operational signals.
// See docs/live_dashboard_backend/ for the full discovery package.
//
// Phase 1 (this version):
//   - Source A (absences) — bridge to existing closinglist IVR scraper
//   - Source D (CVP)      — Hoops tRPC pull, per-store, current week
//   - Sources B/C/E placeholder widgets ("Phase 2 / V1.5 pending")

import { IS_SERVICE_WORKER } from "../../shared/alarms.js";
import { handlers, onAlarm, ALARM_NAMES, installAlarms, bootstrapIfNeeded } from "./service.js";

// MV3 SW wake constraint: the alarm listener MUST be registered during the
// SW's initial script execution. The INSTALL has to be here too — see
// shared/alarms.js: register() runs only when the shell page mounts a module,
// so installing there both missed the SW entirely and reset every alarm's
// countdown on each page load. Gated because extension pages receive alarm
// events as well, and these handlers drive background tabs.
if (IS_SERVICE_WORKER) {
  chrome.alarms.onAlarm.addListener(onAlarm);
  installAlarms().catch((e) =>
    console.warn("[livedashboard] installAlarms failed:", e?.message ?? e));
}

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
      // Sidebar + home-card glyph: the INNER markup of a 20x20 stroke icon.
      // The shell wraps it (app.js::iconSvgString) so every module shares one
      // viewBox, stroke width and currentColor. Omit it and the shell falls
      // back to the generic grid glyph.
      icon: `
        <path d="M3 14.5a7 7 0 0 1 14 0"/>
        <path d="M10 14.5l3.6-3.6" stroke-linecap="round"/>
        <circle cx="10" cy="14.5" r="1.15" fill="currentColor" stroke="none"/>
        <path d="M3 17.2h14" stroke-linecap="round" opacity=".45"/>
      `,
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
    // Alarms are installed at top level above, in the service worker.
    //
    // This bootstrap deliberately stays here: unlike the alarms, it is a
    // dashboard-OPEN behaviour, and its pulls drive Hoops/IVR pages. Moving
    // it to SW boot would make those run on every browser start whether or
    // not anyone looks at the dashboard.
    //
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
