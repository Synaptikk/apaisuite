// modules/digitalmetrics/module.js
import { handlers as serviceHandlers, onPullAlarm } from "./service.js";

// ── Automated-pull alarm ───────────────────────────────────────────────────
//
// Registered at TOP-LEVEL script execution, not inside register() or a
// handler. An MV3 service worker only wakes for an event whose listener was
// attached during the worker's initial evaluation; a listener added later
// exists only until the worker idles out, and then silently never fires again
// (MODULE_CONTRACT §4, and the same pattern as modules/workvivo/module.js).
//
// The alarm itself is cheap — onPullAlarm() returns immediately unless the
// user has opted in via `digitalmetrics.pullEnabled`.
const PULL_ALARM = "digitalmetrics.pull";
const PULL_PERIOD_MIN = 60;

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PULL_ALARM) onPullAlarm();
});

// create() with the same name replaces any existing alarm, so this is safe to
// run on every worker boot.
chrome.alarms.create(PULL_ALARM, { periodInMinutes: PULL_PERIOD_MIN, delayInMinutes: 5 });

export default {
  manifest: {
    id:          "digitalmetrics",
    name:        "Digital Metrics",
    description: "Digital fulfilment performance analytics, schedule import, and daily task assignments.",
    version:     "0.1.0",
    status:      "beta",
    accent:      "#0071CE",

    ui: {
      kind: "fullpage",
      // Sidebar + home-card glyph: the INNER markup of a 20x20 stroke icon.
      // The shell wraps it (app.js::iconSvgString). Without one the shell
      // falls back to the generic grid glyph.
      //
      // A plotted trend line with points, deliberately unlike its neighbours:
      // digitalrollup is bare bars and vizpick is a gauge ring, and all three
      // sit next to each other in the sidebar.
      icon: `
        <path d="M3.2 16.8V3.6" stroke-linecap="round" opacity=".45"/>
        <path d="M3.2 16.8h13.6" stroke-linecap="round" opacity=".45"/>
        <path d="M5.8 13.4l3.1-3.4 2.8 2.1 4.1-5" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/>
        <circle cx="8.9" cy="10" r="1.15" fill="currentColor" stroke="none"/>
        <circle cx="11.7" cy="12.1" r="1.15" fill="currentColor" stroke="none"/>
      `,
      view: () => import("./view.js"),
    },

    service: {
      handlers: serviceHandlers,
    },

    permissions: {
      needs: ["storage", "unlimitedStorage", "tabs", "scripting", "clipboardWrite", "alarms"],
      hosts: [
        "https://firestore.googleapis.com/*",
        "https://identitytoolkit.googleapis.com/*",
        "https://securetoken.googleapis.com/*",
        "https://stores.tableau.wal-mart.com/*",
        "https://workforce-planning-portal.us-walmart.prod.polaris.walmart.com/*",
      ],
    },

    // Declared in the top-level manifest.json too — there is no build step that
    // propagates this (MODULE_CONTRACT §9). Keep both in sync.
    //
    // modules/metricshot also runs a MAIN-world script on this host. It patches
    // window.fetch; this one only reads window.tableau, so they coexist. See
    // the header of content/tableau_capture.js.
    contentScripts: [
      {
        matches:    ["https://stores.tableau.wal-mart.com/*"],
        js:         ["modules/digitalmetrics/content/tableau_capture.js"],
        run_at:     "document_start",
        world:      "MAIN",
        all_frames: true,
      },
    ],

    webRequestFilters: [],
  },

  async register(_host) {},
};
