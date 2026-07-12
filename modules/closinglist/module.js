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
import { handlers as serviceHandlers } from "./service.js";

export default {
  manifest: {
    id:          "closinglist",
    name:        "ClosingList",
    description: "Closing-shift email draft from CaseVisibility schedule + IVR call-offs.",
    version:     "0.2.0",
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
      needs: ["scripting", "tabs", "storage", "clipboardWrite"],
      hosts: [
        "https://radapps3.wal-mart.com/Protected/CaseVisibility/*",
        "https://ivrattcloud-prod.wal-mart.com/*",
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

    webRequestFilters: [],
  },

  // register() runs once on shell boot for every registered module. Use it
  // for one-time setup (legacy-key migration, warm caches, ...). Keep it
  // light — heavy work should happen on first mount() instead.
  async register(_host) {
    // No legacy-key migration: per the retirement plan (see
    // docs/SOURCE_MAPPING.md::Original extensions retirement status), the
    // standalone ClosingList extension stays installed alongside the suite
    // during the verification window. It has its own extension id and its
    // own isolated chrome.storage namespace, so there's nothing to migrate
    // — the suite is genuinely a fresh install with its own DEFAULTS.
    //
    // When/if the user wants to carry their saved prefs over, call
    // migrateLegacyKeys (from shared/storage.js) here with the donor's
    // unnamespaced sync/local keys.
  },
};
