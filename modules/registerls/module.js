// modules/registerls/module.js
//
// Register L/S Triage — clears the APPRISS WorkView register long/short
// queue of till flips and bouncebacks, and points at the shortages that
// deserve video. Sources: WorkView (queue), Power BI long/short grid (via
// the Live Dashboard register engine), APPRISS Cash Research (10-day
// ledger), EJ Viewer (receipts). See dev/REGISTER_LS_FINDINGS.md and
// dev/REGISTER_LS_BUILD_PROMPT.md.

import { handlers } from "./service.js";

export default {
  manifest: {
    id:          "registerls",
    name:        "Register L/S Triage",
    description: "Register long/short triage: WorkView queue × Power BI grid × Cash Research × EJ — flips and bouncebacks out, video-worthy shortages up.",
    version:     "0.1.0",
    status:      "alpha",
    ui: {
      kind: "fullpage",
      icon: `
        <rect x="3" y="5" width="14" height="10" rx="1.6"/>
        <path d="M6 15v2.2M14 15v2.2M3 9h14" stroke-linecap="round"/>
        <path d="M7.2 12.4h2.4M11.2 12.4h2.2" stroke-linecap="round"/>
      `,
      view: () => import("./view.js"),
    },
    service: { handlers },
    permissions: {
      needs: ["storage", "tabs", "scripting"],
      hosts: [
        "https://apps.apprissretail.com/*",
        "https://ej.walmart.com/*",
        "https://app.powerbi.com/*",
        "https://*.pbidedicated.windows.net/*",
      ],
    },
    contentScripts: [
      { matches: ["https://app.powerbi.com/*"], js: ["modules/registerls/content/powerbi_cash_recycler_capture.js"], run_at: "document_start", world: "MAIN" },
      { matches: ["https://app.powerbi.com/*"], js: ["modules/registerls/content/powerbi_cft_capture.js"], run_at: "document_start", world: "MAIN" },
      // The long/short grid capture is livedashboard's content script.
    ],
    webRequestFilters: [],
  },
  async register(_host) {},
};
