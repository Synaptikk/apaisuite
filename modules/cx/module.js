// modules/cx/module.js
//
// Cx — the store's customer-experience read: the graded NPS and sub-scores from
// the Hoops ops-portal, over a year of the store's own Medallia customer
// comments broken down by theme and sentiment, and a written summary of what is
// going wrong and what is going right.
//
// The point of the module is the join. Hoops tells you the number moved;
// Medallia's comments tell you why, but its own dashboard shows them as an
// undifferentiated stream and the portal's GenAI summary has been frozen since
// January. So the breakdown here is computed from the tags on the comments —
// ranked, compared against the previous window, and only then handed to a model
// to write up.
//
// Sources, field ids and the measured cost of a pull: dev/CX_FINDINGS.md.

// STATIC import — an MV3 service worker cannot dynamic-import, so the handlers
// object must exist by the time the SW boots. Only view.js is lazy.
import { IS_SERVICE_WORKER } from "../../shared/alarms.js";
import { handlers, onAlarm, installAlarms, bootstrapIfNeeded } from "./service.js";

// This file is imported by BOTH the service worker (via modules/_registry.js)
// and the shell page, which reads the same registry for manifests. Everything
// below is service-worker-only, so it is gated: extension pages receive
// chrome.alarms events too, and an ungated listener would run the refresh once
// in the SW and once in every open suite tab, as separate module instances with
// separate in-flight guards that would not dedupe.
if (IS_SERVICE_WORKER) {
  // MV3 wake constraint: the listener must be registered during initial script
  // execution, or a wake delivered before register() runs is dropped.
  chrome.alarms.onAlarm.addListener(onAlarm);

  // The same constraint applies to INSTALLING the alarm — register() only ever
  // runs when the shell mounts the module, so an alarm installed there exists
  // only while a suite tab is open. See docs/MODULE_CONTRACT.md.
  installAlarms().catch((e) => console.warn("[cx] installAlarms failed:", e?.message ?? e));

  // Tops up existing history; deliberately never starts a cold 52-week pull,
  // which opens a tab and runs for two minutes.
  bootstrapIfNeeded().catch(() => {});
}

export default {
  manifest: {
    id:          "cx",
    name:        "Cx",
    description: "Store NPS, customer-service scores and what the comments say is going right and wrong.",
    version:     "0.1.0",
    accent:      "#0071CE",
    status:      "alpha",

    ui: {
      kind: "fullpage",
      // Inner markup of a 20x20 stroke glyph; the shell supplies the viewBox,
      // stroke width and currentColor (app.js::iconSvgString). A speech bubble
      // with a rising line in it: comments plus a trend.
      icon: `
        <path d="M3 5.5a1.5 1.5 0 0 1 1.5-1.5h11A1.5 1.5 0 0 1 17 5.5v7a1.5 1.5 0 0 1-1.5 1.5H8l-3.5 3v-3H4.5A1.5 1.5 0 0 1 3 12.5z"/>
        <path d="M6 11l2.5-3 2 2L14 6.5" stroke-linecap="round" stroke-linejoin="round"/>
      `,
      view: () => import("./view.js"),
    },

    // PLAIN OBJECT, not a thunk — the static import above already evaluated.
    service: { handlers },

    // Informational only; the real grant is the top-level manifest.json.
    permissions: {
      // `tabs` + `scripting` drive the Medallia anchor tab (its CSRF token is
      // only ever in the page HTML) and the Hoops cookie fallback.
      needs: ["storage", "unlimitedStorage", "tabs", "scripting", "alarms"],
      hosts: [
        "https://hoops.wal-mart.com/*",
        "https://walmart.medallia.com/*",
        // The internal AI gateway for the written read. Sends no CORS headers,
        // so this only works from the service worker.
        "https://puppy-backend.walmart.com/*",
      ],
    },

    contentScripts: [],
    webRequestFilters: [],
  },

  // The alarm install and the boot top-up happen at top level above so they run
  // in the service worker rather than only when the shell mounts this module.
  async register(_host) {},
};
