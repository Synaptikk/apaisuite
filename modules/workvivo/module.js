// modules/workvivo/module.js
//
// QRCallBox ↔ Workvivo token-heartbeat module.
//
// Purpose: the QRCallBox notification system needs a fresh Sendbird
// `access_token` to post into Workvivo chat channels. Walmart's SAML/MFA
// auth means a cloud function cannot reauth on its own. This module is the
// keep-alive: while the user has workvivo.walmart.com open, it reads the
// live access_token every hour and POSTs it to a QRCallBox cloud function.
// QRCallBox then has an always-fresh token to use when QR scans happen.
//
// See APAISuite/CLAUDE.md for the cross-repo integration notes, and
// QRCallBox/Workvivo/WORKVIVO.md for the auth discovery that motivated it.

// Statically imported (MV3 SW contract — see service_worker.js notes).
import { IS_SERVICE_WORKER } from "../../shared/alarms.js";
import { handlers, installHeartbeatAlarm, onAlarm } from "./service.js";

// Alarm wiring is service-worker-only and lives at top level — during the
// SW's initial script execution — so Chrome will wake the SW on a matching
// alarm event later. Same constraint as webRequest listeners; see
// service_worker.js::"Side effect: every module's top-level work runs at SW
// boot", and shared/alarms.js for why the INSTALL has to be here too rather
// than in register(), which only ever runs in the shell page.
if (IS_SERVICE_WORKER) {
  chrome.alarms.onAlarm.addListener(onAlarm);
  installHeartbeatAlarm().catch((e) =>
    console.warn("[workvivo] installHeartbeatAlarm failed:", e?.message ?? e));
}

export default {
  manifest: {
    id:          "workvivo",
    name:        "QRCallBox",
    description: "Keeps QRCallBox notifications working by silently couriering your Workvivo/Sendbird token to qrcallbox.com once an hour while you have Workvivo open.",
    version:     "0.2.0",
    status:      "beta",

    ui: {
      kind: "fullpage",
      // Sidebar + home-card glyph: the INNER markup of a 20x20 stroke icon.
      // The shell wraps it (app.js::iconSvgString) so every module shares one
      // viewBox, stroke width and currentColor. Omit it and the shell falls
      // back to the generic grid glyph.
      icon: `
        <rect x="2.8" y="2.8" width="5.4" height="5.4" rx="1.2"/>
        <rect x="11.8" y="2.8" width="5.4" height="5.4" rx="1.2"/>
        <rect x="2.8" y="11.8" width="5.4" height="5.4" rx="1.2"/>
        <path d="M11.8 11.8h2.4v2.4h-2.4zM15 15h2.2v2.2H15z" stroke-linejoin="round"/>
      `,
      view: () => import("./view.js"),
    },

    service: {
      handlers,
    },

    // Permissions consumed by this module (informational; the actual grant
    // is whatever the top-level manifest.json declares):
    //   - alarms        chrome.alarms for periodic heartbeat
    //   - scripting     chrome.scripting.executeScript({world:"MAIN"})
    //   - tabs          chrome.tabs.query to find workvivo.walmart.com tabs
    //   - storage       chrome.storage.sync for endpoint+key+status
    // Host permission "https://workvivo.walmart.com/*" is already covered
    // by the suite-wide "https://*.walmart.com/*" wildcard. The QRCallBox
    // cloud function host is added separately in the top-level manifest.
    permissions: {
      needs: ["alarms", "scripting", "tabs", "storage"],
      hosts: [
        "https://workvivo.walmart.com/*",
        // Endpoint host — keep in sync with manifest.json::host_permissions
        "https://*.cloudfunctions.net/*",
        "https://*.run.app/*",
      ],
    },

    // No content scripts. Token reads are pull-driven from the SW via
    // chrome.scripting.executeScript({world:"MAIN"}) — see lib/extract.js.
    contentScripts: [],

    // No webRequest header capture (we read window.v2.chatConfig directly).
    webRequestFilters: [],
  },

  // The heartbeat alarm is installed at top level above, in the service
  // worker. Kept as a no-op: register() is part of the module contract and
  // shell-side setup belongs here, not the alarm.
  async register(_host) {},
};
