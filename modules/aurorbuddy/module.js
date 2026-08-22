// modules/aurorbuddy/module.js
//
// AurorBuddy — Auror × APPRISS/Secure cross-reference for fraud
// investigation. Migrated from the standalone AurorBuddy donor extension
// (see docs/SOURCE_MAPPING.md).

// service.js is imported STATICALLY because MV3 service workers cannot use
// dynamic import() — the HTML spec disallows it on ServiceWorkerGlobalScope
// (W3C ServiceWorker issue #1356). view.js stays as a lazy thunk because
// the suite shell loads it in the app.html page context where dynamic
// import is allowed and lazy loading still saves bytes on boot.
import { handlers as serviceHandlers } from "./service.js";

// Firestore + usage_metrics expose their own retry-queue alarms. The
// chrome.alarms.onAlarm listener MUST be registered synchronously at SW
// top level for Chrome to wake the SW when the alarm fires — registering
// inside a message handler defeats the purpose. See MEMORY rule
// "Static import service.js + declarative webRequestFilters".
import { IS_SERVICE_WORKER } from "../../shared/alarms.js";
import { onAlarm as onFirestoreAlarm } from "./lib/firestore.js";
import { onAlarm as onMetricsAlarm }   from "./lib/usage_metrics.js";
import { onAlarm as onWorkflowAlarm, scheduleCleanupAlarm } from "./lib/workflow_status.js";

// Gated to the service worker as well: this file is imported by the shell
// page too, and extension pages receive alarm events — ungated, each tick
// would run the queue flush and the expiry sweep once in the SW and once in
// every open suite tab, double-writing to Firestore. See shared/alarms.js.
//
// All three of these schedulers already read before creating, so none has the
// period-reset bug that hit vizpick/digitallocks/workvivo/livedashboard/
// sparkscango/sparkfraud.
if (IS_SERVICE_WORKER && typeof chrome !== "undefined" && chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    onFirestoreAlarm(alarm?.name);
    onMetricsAlarm(alarm?.name);
    onWorkflowAlarm(alarm?.name);
  });
  // Schedule the 72h-expired cleanup alarm (every 6h). Idempotent —
  // bails if the alarm already exists.
  scheduleCleanupAlarm();
}

export default {
  manifest: {
    id:          "aurorbuddy",
    name:        "AurorBuddy",
    description: "Cross-reference Auror suspects against APPRISS/Secure activity, save evidence, and pre-fill Auror events.",
    version:     "0.1.62",
    status:      "active",
    accent:      "#FFC220",   // Auror yellow — see styles/tokens.css per-module block

    ui: {
      kind: "fullpage",
      // Sidebar + home-card glyph: the INNER markup of a 20x20 stroke icon.
      // The shell wraps it (app.js::iconSvgString) so every module shares one
      // viewBox, stroke width and currentColor. Omit it and the shell falls
      // back to the generic grid glyph.
      icon: `
        <circle cx="9.1" cy="9.1" r="5.9"/>
        <path d="M13.4 13.4L17 17" stroke-linecap="round"/>
        <circle cx="9.1" cy="7.6" r="1.7"/>
        <path d="M6.4 12.2a3.1 3.1 0 0 1 5.4 0" stroke-linecap="round"/>
      `,
      view: () => import("./view.js"),
    },
    service: {
      handlers: serviceHandlers,
    },

    permissions: {
      // `debugger` was previously required for the CCTV download path
      // (lib/evidence_downloader.js read the m3u8 segment bodies with CDP
      // Network.getResponseBody). That feature was removed so the suite could
      // drop the permission entirely; nothing here needs CDP any more.
      needs: ["storage", "webRequest", "scripting", "cookies", "downloads", "tabs"],
      hosts: [
        "https://app.us.auror.co/*",
        "https://*.auror.co/*",
        "https://wmtus.apprissretailcloud.com/*",
        "https://*.walmart.com/*",
        "https://*.wal-mart.com/*",
      ],
    },

    // No declarative content scripts — all page automation is imperative via
    // chrome.scripting.executeScript from service.js (SSO auto-click,
    // /event/new form drive, store-finder DOM scrape, etc.).
    contentScripts: [],

    // Declarative webRequest filters. MUST be declared here (not registered
    // imperatively from service.js) because chrome.webRequest listeners
    // need to be added SYNCHRONOUSLY at SW top level for Chrome to wake the
    // SW on matching events. The shell SW reads this list and registers
    // listeners during its initial script execution. See
    // background/service_worker.js + memory/feedback_sw_eager_load.md.
    //
    // Each captured value is written to chrome.storage.session under
    // "<moduleId>.<storageKey>". Modules read via host.auth.getCapturedHeader.
    webRequestFilters: [
      {
        urls: ["https://app.us.auror.co/*", "https://*.auror.co/*"],
        headerName: "authorization",
        storageKey: "auror.jwt",
        ttlMs: 20 * 60 * 1000,
        predicate: { startsWith: "Bearer " },
      },
    ],
  },

  async register(_host) {
    // No legacy-key migration: the standalone AurorBuddy extension lives at
    // its own extension id with isolated chrome.storage; this is a fresh
    // install. See docs/SOURCE_MAPPING.md::Original extensions retirement
    // status.
  },
};
