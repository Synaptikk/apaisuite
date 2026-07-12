// modules/claimsbuddy/module.js
//
// Module manifest + registration hook. Imported by modules/_registry.js.

import { handlers as serviceHandlers } from "./service.js";

export default {
  manifest: {
    id:          "claimsbuddy",
    name:        "ClaimsBuddy",
    description: "Cross-references CAS, VEE, ClearSight, and DataFile to surface claims with inefficient or missing evidence.",
    version:     "0.1.0",
    status:      "active",

    ui: {
      kind: "fullpage",
      view: () => import("./view.js"),
    },

    service: {
      handlers: serviceHandlers,
    },

    permissions: {
      // nativeMessaging gates the VEE bridge. The bridge itself is
      // installed by modules/claimsbuddy/native_host/setup.cmd (a one-time
      // browser-side click won't reach the registry — see VEE_ENDPOINTS_
      // REFERENCE.md and the donor's native_host/setup.ps1 for why).
      needs: ["storage", "unlimitedStorage", "tabs", "cookies", "nativeMessaging"],
      hosts: [
        "https://storage.googleapis.com/cas_storage/*",
        "https://www.riskonnectclearsight.com/*",
        "https://wmlink.wal-mart.com/*",
      ],
    },

    contentScripts: [
      {
        matches: ["https://www.riskonnectclearsight.com/Walmart/StormsPackages/Storms.Wrapper/*"],
        js:      ["modules/claimsbuddy/content/clearsight_content.js"],
        run_at:  "document_idle",
      },
    ],

    webRequestFilters: [],
  },

  async register(_host) {
    // No legacy-key migration — per the suite-wide coexistence convention,
    // the donor ClaimsBuddy extension stays installed while the suite is
    // being verified. Donor has its own storage namespace; suite is a
    // genuinely fresh install with fresh DEFAULTS.
  },
};
