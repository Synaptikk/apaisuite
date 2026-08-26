// modules/digitalmetrics/module.js
import { IS_SERVICE_WORKER } from "../../shared/alarms.js";
import { handlers as serviceHandlers, onPullAlarm, installPullAlarm } from "./service.js";

// ── Automated-pull alarm ───────────────────────────────────────────────────
//
// Top-level, because an MV3 service worker only wakes for an event whose
// listener was attached during its initial evaluation; one added later exists
// until the worker idles out and then silently never fires again
// (MODULE_CONTRACT §4). register() cannot do it — that runs only in the shell
// page (app.js::mountModule), never in the worker.
//
// Guarded, because module.js is imported by BOTH contexts. Unguarded, the
// shell page registered its own listener and rewrote the alarm on every page
// load. shared/tests/alarm_install_sites.test.mjs pins both halves.
//
// The alarm is cheap: onPullAlarm() returns immediately unless the user has
// opted in via `digitalmetrics.pullEnabled`.
if (IS_SERVICE_WORKER) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "digitalmetrics.pull") onPullAlarm();
  });
  installPullAlarm().catch((e) =>
    console.warn("[digitalmetrics] installPullAlarm failed:", e?.message ?? e));
}

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
