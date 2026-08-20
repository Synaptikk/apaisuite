// modules/closinglist/module.js
//
// Module manifest + registration hook. See docs/ARCHITECTURE.md::2 for the
// contract. Adding a new module follows this same shape — see
// docs/MIGRATION_PLAN.md::Importing a new extension.

// service.js is imported STATICALLY because MV3 service workers cannot use
// dynamic import() — the HTML spec disallows it on ServiceWorkerGlobalScope
// (W3C ServiceWorker issue #1356). view.js stays as a lazy thunk because
// the suite shell loads it in the app.html page context where dynamic
// import is allowed and lazy loading still saves bytes on boot.
import { handlers as serviceHandlers, installDailySendAlarm, clearDailySendAlarm, onAlarm } from "./service.js";

// Alarm listener MUST be registered at top-level (during the SW's initial
// script execution) so Chrome will wake the SW when the daily noon alarm fires
// after idle-shutdown. Same constraint as webRequest listeners in service_worker.js.
chrome.alarms.onAlarm.addListener(onAlarm);

export default {
  manifest: {
    id:          "closinglist",
    name:        "ClosingList",
    description: "Closing-shift email draft from CaseVisibility schedule + IVR call-offs.",
    version:     "0.3.0",
    status:      "active",
    // Module uses the suite's default blue accent — no override.

    ui: {
      kind: "fullpage",
      view: () => import("./view.js"),
    },

    service: {
      handlers: serviceHandlers,
    },

    permissions: {
      needs: ["scripting", "tabs", "storage", "clipboardWrite", "alarms", "notifications"],
      hosts: [
        "https://radapps3.wal-mart.com/Protected/CaseVisibility/*",
        "https://ivrattcloud-prod.wal-mart.com/*",
        "https://graph.microsoft.com/*",
      ],
    },

    contentScripts: [
      {
        matches: ["https://radapps3.wal-mart.com/Protected/CaseVisibility/*"],
        js:      ["modules/closinglist/content/casevisibility.js"],
        run_at:  "document_idle",
      },
      {
        matches: ["https://ivrattcloud-prod.wal-mart.com/*"],
        js:      ["modules/closinglist/content/ivr.js"],
        run_at:  "document_idle",
      },
    ],

    // Capture the Authorization: Bearer token from Outlook's Graph API calls.
    // Stored in chrome.storage.session["closinglist.graphToken"] by the suite-wide
    // webRequest dispatcher in service_worker.js. Used at noon by the daily
    // auto-send alarm to POST to graph.microsoft.com/v1.0/me/sendMail.
    webRequestFilters: [
      {
        urls:        ["https://graph.microsoft.com/v1.0/*", "https://graph.microsoft.com/beta/*"],
        headerName:  "authorization",
        storageKey:  "graphToken",
        ttlMs:       3_300_000, // 55 minutes
        predicate:   { startsWith: "Bearer " },
      },
    ],
  },

  async register(_host) {
    // If a test-send was queued via the UI before the last reload, fire it now
    // by sending a message to the SW handler (so executeDailySend runs in SW
    // context where the IVR pendingIvrResolver is wired up correctly).
    const boot = await chrome.storage.local.get("closinglist.bootSend");
    if (boot["closinglist.bootSend"]) {
      await chrome.storage.local.remove("closinglist.bootSend");
      chrome.runtime.sendMessage({ module: "closinglist", type: "auto-send-trigger-now" })
        .catch((e) => console.error("[closinglist] boot send message failed:", e));
    }

    // Re-install the daily alarm if the user has auto-send enabled.
    // Idempotent: installDailySendAlarm is a no-op if the alarm already exists.
    // This runs on every SW boot, so a Chrome restart recovers the alarm.
    const s = await chrome.storage.sync.get("closinglist.autoSendEnabled");
    if (s["closinglist.autoSendEnabled"]) {
      await installDailySendAlarm();
    } else {
      // Ensure a stale alarm from a prior enable is cleaned up.
      await clearDailySendAlarm();
    }
  },
};
