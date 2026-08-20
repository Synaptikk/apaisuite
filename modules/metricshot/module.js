// modules/metricshot/module.js
//
// Metric Screenshot Scheduler.
//
// Captures a configured internal metric page (e.g. Tableau viz) on a schedule
// and posts the screenshot into a named Workvivo/Sendbird channel using the
// user's already-authenticated workvivo.walmart.com tab. No new credentials,
// no headless browser, no external server.
//
// Contract: docs/MODULE_CONTRACT.md. Handler dispatch: background/service_worker.js.

// Statically imported so the SW's message dispatcher can reach the handlers
// (MV3 SWs cannot use dynamic import — see the comment block at the top of
// background/service_worker.js).
import { handlers, onAlarm, register, bootInit } from "./service.js";

// This file is imported by BOTH the SW (via background/service_worker.js →
// shared/registry.js) AND app.html (via app.js → shared/registry.js). Alarm
// listeners fire in EVERY extension context that registered them, so without
// this guard, every scheduled tick ran twice while the shell was open — one
// tick per context. The image usually posted once (chrome.debugger.attach on
// the Tableau tab is single-owner, so the losing context errored out), but the
// caption and follow-up REST texts have no cross-context lock and both posted
// twice. Gate on the SW-only global (`ServiceWorkerGlobalScope`) so only the
// SW arms the tick + owns the run pipeline.
//
// Wake-on-alarm listener MUST be registered at top-level (during initial SW
// script execution). Same constraint as workvivo/module.js:23 and
// closinglist/module.js:17.
// `window` is defined in extension pages (app.html) and undefined in the
// MV3 service worker — the simplest reliable context discriminator.
// ServiceWorkerGlobalScope-based checks are unreliable because the constructor
// is defined as a global in normal browser pages too.
const IS_SW = typeof window === "undefined";

if (IS_SW) {
  chrome.alarms.onAlarm.addListener(onAlarm);

  // Run the boot sequence at SW boot — NOT only from register().
  //
  // register() runs in the app.html *page* context (app.js mounts the module and
  // calls it once per shell load). The background service worker never calls
  // register(), so if setup lived only there it would depend on the user having
  // the UI open, and it would not be recovered after a Chrome restart or SW
  // idle-shutdown. Result: manual "Run now" (routed through the always-loaded
  // message dispatcher) worked, but SCHEDULED posts silently stopped firing.
  //
  // bootInit() does two idempotent things: ensureSeed() (so a fresh install that
  // has never opened the UI still has the seed metric for tick() to find) and
  // installTickAlarm() (so the tick alarm exists and is re-armed on every wake).
  // Running it here — during the SW's initial top-level execution, which Chrome
  // re-runs on every wake — guarantees scheduled posts fire without the UI and
  // survive restarts. Safe to also run from register(); both calls are no-ops
  // once seeded + armed.
  bootInit().catch((e) => {
    console.error("[metricshot] bootInit at SW boot failed:", e);
  });
}

export default {
  manifest: {
    id:          "metricshot",
    name:        "Metric Shots",
    description: "Scheduled screenshots of internal metric dashboards, posted to Workvivo channels using your existing authenticated tab.",
    version:     "0.1.0",
    status:      "beta",
    accent:      "#0071CE",

    ui: {
      kind: "fullpage",
      view: () => import("./view.js"),
    },

    service: {
      handlers,
    },

    // Informational — the actual grant comes from the top-level manifest.json.
    permissions: {
      needs: ["alarms", "scripting", "tabs", "storage", "debugger"],
      hosts: [
        "https://stores.tableau.wal-mart.com/*",
        "https://workvivo.walmart.com/*",
        "https://api-*.sendbird.com/*",
      ],
    },

    contentScripts: [],
    webRequestFilters: [],
  },

  register,
};
