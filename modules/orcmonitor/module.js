// modules/orcmonitor/module.js
//
// ORC Corridor Intelligence Monitor
// Real-time threat tracking: identifies ORC actors whose movement trajectory
// (based on their Auror event history) is consistent with approaching the
// analyst's target store. Reads the Auror JWT captured by the shell's
// declarative webRequest filter — no manual token steps required.

import { handlers as serviceHandlers } from "./service.js";

export default {
  manifest: {
    id:          "orcmonitor",
    name:        "ORC Corridor Monitor",
    description: "Identifies approaching ORC threats by tracking their event history trajectory along interstate corridors toward a selected store.",
    version:     "0.1.0",
    status:      "active",
    accent:      "#0071CE",   // APAISuite brand blue

    ui: {
      kind: "fullpage",
      view: () => import("./view.js"),
    },
    service: {
      handlers: serviceHandlers,
    },

    permissions: {
      needs: ["storage", "webRequest"],
      hosts: [
        "https://app.us.auror.co/*",
        "https://*.auror.co/*",
      ],
    },

    contentScripts: [],

    // Capture the Auror JWT the same way aurorbuddy does.
    // The shell SW registers this listener synchronously at boot so it
    // wakes the SW on every Auror request the user makes — no manual
    // token steps, no polling, no console snippets.
    webRequestFilters: [
      {
        urls: ["https://app.us.auror.co/*", "https://*.auror.co/*"],
        headerName: "authorization",
        storageKey: "auror.jwt",
        ttlMs: 20 * 60 * 1000,   // 20 min — matches aurorbuddy
        predicate: { startsWith: "Bearer " },
      },
    ],
  },

  async register(_host) {
    // No alarms. Analysis is user-triggered from the view.
  },
};
