// modules/digitaldashboard/module.js
//
// Digital Dashboard — store 1458's live OPD metrics from the GIF app:
// picks per hour, express per hour, and an on-demand break watch.
//
// Layout is deliberately VizPick's market rollup (same header, market picker,
// panel and card grid) so the two read as one family. What it is NOT is
// VizPick's charting: there are no gauge rings here. The GIF app publishes
// figures on four unrelated scales — percentages, a pick RATE, minute counts
// and raw queue depths — and a ring implies a 0–100 fill that three of those
// four do not have.
//
// Source is an API, not a dashboard capture: see lib/gif_api.js. That makes
// this the only module in the suite with no content script, no export driving
// and no capture ring.

// STATIC import — an MV3 service worker cannot dynamic-import, so the handlers
// object must already exist by the time the SW boots. Only view.js is lazy.
import { IS_SERVICE_WORKER } from "../../shared/alarms.js";
import { handlers, onAlarm, installAlarms, bootstrapIfNeeded } from "./service.js";

// This file is imported by BOTH the service worker (via modules/_registry.js)
// and the shell page app.html, which reads the same registry for manifests.
// Everything below is service-worker-only, so it is gated: extension pages
// receive chrome.alarms events too, and an ungated listener would run the
// refresh once in the SW and once in every open suite tab — separate module
// instances with separate in-flight guards, so they would not dedupe.
if (IS_SERVICE_WORKER) {
  // MV3 wake constraint: the listener MUST be registered during initial script
  // execution, not inside register(), or a wake delivered before register()
  // runs is dropped.
  chrome.alarms.onAlarm.addListener(onAlarm);

  // The same constraint applies to INSTALLING the alarm, and that is the half
  // that was actually broken across six modules until 2026-08-20: register()
  // is called by app.js when the shell mounts a module and never runs in the
  // service worker at all, so the alarm existed only while the suite tab was
  // open. Top level here runs on every SW boot, which is the real browser-start
  // hook. Both calls are internally rate-limited.
  installAlarms().catch((e) => console.warn("[digitaldashboard] installAlarms failed:", e?.message ?? e));
  bootstrapIfNeeded().catch(() => {});
}

export default {
  manifest: {
    id:          "digitaldashboard",
    group:       "digital",
    name:        "Digital Dashboard",
    description: "Store 1458 OPD metrics from GIF — picks/hr, express/hr, Pick Hours history, and an on-demand break watch — via the local GIF daemon.",
    version:     "0.1.0",
    status:      "alpha",

    ui: {
      kind: "fullpage",
      // Inner markup of a 20x20 stroke glyph; the shell supplies viewBox,
      // stroke width and currentColor (app.js::iconSvgString).
      icon: `
        <path d="M3.5 16.5v-5M8.5 16.5v-9M13.5 16.5v-6M18.5 16.5v-11" stroke-width="2.1" stroke-linecap="round"/>
      `,
      view: () => import("./view.js"),
    },

    service: { handlers },

    permissions: {
      // `tabs` + `scripting` let the !command listener run in the Workvivo tab
      // (via metricshot/sendbird). `alarms` runs the sampler + listener.
      needs: ["storage", "tabs", "scripting", "alarms"],
      // The GIF daemon is local; workvivo.walmart.com is for the !command
      // listener (shared with metricshot). Both are already in manifest.json.
      hosts: ["http://127.0.0.1/*", "https://workvivo.walmart.com/*"],
    },

    contentScripts: [],
    webRequestFilters: [],
  },

  // The alarm install and the boot refresh happen at top level above so they
  // run in the service worker, not only when the shell mounts this module.
  // Kept as a no-op: register() is part of the module contract, and a future
  // shell-side hook belongs here rather than back in the SW path.
  async register(_host) {},
};
