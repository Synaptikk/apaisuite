// modules/claimsdisposition/module.js
//
// Module manifest + registration hook. Imported by modules/_registry.js.
//
// ClaimsDisposition is a live analytics dashboard for shrink-claims data.
// It pulls per-store rows directly from the Looker Studio embed at
// apscpi.wal-mart.com/.../Claims_Disposition.html via the same-origin
// `batchedDataV2` POST (driven from the SW via chrome.scripting +
// chrome.tabs into a background datastudio.google.com tab), caches each
// pull in IndexedDB (`apaisuite-claimsdisposition.pulls`, last 30 kept),
// and renders the dashboard from whichever pull the user selects in the
// source picker. The CSV-download path exports per-store CSVs to
// ~/Downloads/APAISuite-claims/.
//
// Merged from the (now-deleted) `claimspull` module in v0.3.0 — see the
// 2026-05-28 commit and project memory `project_claimsdisposition_store_ids`
// for the recon notes that informed the request shape.

import { handlers as serviceHandlers } from "./service.js";

export default {
  manifest: {
    id:          "claimsdisposition",
    name:        "Claims Disposition",
    description: "Live shrink-claims analytics: pulls per-store data on demand from the Looker Studio embed, caches up to 30 pulls in IndexedDB, exports per-store CSVs.",
    version:     "0.3.0",
    status:      "beta",

    ui: {
      kind: "fullpage",
      view: () => import("./view.js"),
    },
    service: {
      handlers: serviceHandlers,
    },

    // The Pull path needs:
    //   tabs/scripting → open the embed in a background tab + executeScript
    //                    the same-origin fetch
    //   downloads      → write per-store CSVs to ~/Downloads
    //   storage        → chrome.storage.session for the progress doc the
    //                    view subscribes to (IndexedDB doesn't need this
    //                    permission — it's allowed for extension pages by
    //                    default)
    permissions: {
      needs: ["tabs", "scripting", "storage", "downloads"],
      hosts: [
        "https://datastudio.google.com/*",
        "https://lookerstudio.google.com/*",
        "https://apscpi.wal-mart.com/*",
      ],
    },

    contentScripts: [],
    webRequestFilters: [],
  },

  async register(_host) {
    // No persistent setup. No alarms (pulls are user-triggered, with an
    // auto-pull on first mount when IndexedDB is empty — handled view-side).
    // No SW listeners that need top-level registration.
  },
};
