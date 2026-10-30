// modules/qrcallbox/module.js
//
// QRCallBox inside the suite: the store-side qrcallbox.com screens (scans,
// insights, team, posters, admin approvals) under the user's own QRCallBox
// sign-in. The Workvivo token courier is the separate `workvivo` module.

import { handlers } from "./service.js";

export default {
  manifest: {
    id:          "qrcallbox",
    group:       "integrations",
    name:        "QRCallBox",
    description: "Your store's QRCallBox without the website: customer scans and how they were answered, busiest areas and hours, who's signed up, QR posters to print, and account approvals for admins.",
    version:     "0.1.0",
    status:      "beta",

    ui: {
      kind: "fullpage",
      icon: `
        <rect x="2.8" y="2.8" width="5.4" height="5.4" rx="1.2"/>
        <rect x="11.8" y="2.8" width="5.4" height="5.4" rx="1.2"/>
        <rect x="2.8" y="11.8" width="5.4" height="5.4" rx="1.2"/>
        <path d="M12 12.5h5M12 15h5M12 17.5h3" stroke-linecap="round"/>
      `,
      view: () => import("./view.js"),
    },

    service: { handlers },

    permissions: {
      needs: ["storage", "tabs"],
      hosts: [
        "https://qrcallbox.com/*",
        "https://firestore.googleapis.com/*",
        "https://identitytoolkit.googleapis.com/*",
        "https://securetoken.googleapis.com/*",
      ],
    },

    contentScripts: [],
    webRequestFilters: [],
  },

  async register(_host) {},
};
