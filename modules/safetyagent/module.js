// modules/safetyagent/module.js
//
// Safety Agent Dashboard — SafeIQ's computer-vision hazard alerts for one
// store, reviewed by camera, disposition tag, associate and hour, with the
// no_hazard_found share front and centre.
//
// Data path: SafeIQ Studio's dashboards are thin HTML over a raw SQL endpoint
// (see lib/sql.js). The endpoint wants the session's X-SafePass-Token header,
// which the page adds to its own API calls; the shell SW captures it from any
// SafeIQ request via the declarative filter below, and service.js replays it
// from the worker. No scraping of the dashboard UI.

import { handlers } from "./service.js";

export default {
  manifest: {
    id:          "safetyagent",
    name:        "Safety Agent Dashboard",
    description: "SafeIQ camera hazard alerts by camera, disposition tag, associate and hour — which cameras keep firing on nothing, who closes them, and how fast.",
    version:     "0.1.0",
    accent:      "#C2410C",
    status:      "alpha",
    ui: {
      kind: "fullpage",
      icon: `
        <rect x="3" y="6.5" width="14" height="10" rx="2"/>
        <circle cx="10" cy="11.5" r="3"/>
        <path d="M7.4 6.5 8.5 4.5h3l1.1 2" stroke-linejoin="round"/>
      `,
      view: () => import("./view.js"),
    },
    service: { handlers },
    permissions: {
      needs: ["storage", "tabs", "scripting", "webRequest"],
      hosts: ["https://safeiq.stage.walmart.net/*", "https://safeiq.walmart.net/*",
              "https://safeiqcv.stage.walmart.net/*", "https://safeiqcv.walmart.net/*"],
    },
    contentScripts: [],
    // The SafePass token is a per-session UUID the SafeIQ page sends on every
    // /api call. Captured here, read in service.js via getCapturedHeader —
    // keep storageKey in sync with service.js::TOKEN_KEY.
    webRequestFilters: [
      {
        urls: ["https://safeiq.stage.walmart.net/api/*", "https://safeiq.walmart.net/api/*"],
        headerName: "x-safepass-token",
        storageKey: "safepass.token",
        ttlMs: 6 * 60 * 60 * 1000,
      },
    ],
  },
  async register(_host) {},
};
