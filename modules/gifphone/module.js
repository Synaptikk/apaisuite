// modules/gifphone/module.js
//
// Phone Setup — turns a spare, enrolled Android phone into the GIF Companion
// reader that feeds the Digital Dashboard. The user plugs the phone into this
// PC and presses one button; the page talks adb over WebUSB (lib/adb.js) to
// keep the phone awake, install the bundled APK, switch its accessibility
// service on, pair it with QRCallBox and start it (lib/setup.js).
//
// Nothing here runs in the background: no alarms, no content scripts. The
// service only proxies the Digital Dashboard's pairing + health handlers so
// the page shows the same phone the dashboard does.

import { handlers } from "./service.js";

export default {
  manifest: {
    id:          "gifphone",
    group:       "digital",
    name:        "GIF Phone Setup",
    description: "Plug in a spare phone and set it up as the GIF Companion reader for the Digital Dashboard: keeps it awake, installs the app, turns it on and pairs it — one button.",
    version:     "0.1.0",
    status:      "beta",

    ui: {
      kind: "fullpage",
      icon: `
        <rect x="6" y="2.5" width="8" height="15" rx="1.6"/>
        <path d="M9 15h2" stroke-linecap="round"/>
        <path d="M10 6.5v4M8.2 8.8 10 10.6l1.8-1.8" stroke-linecap="round" stroke-linejoin="round"/>
      `,
      view: () => import("./view.js"),
    },

    service: { handlers },

    permissions: {
      // WebUSB (navigator.usb) needs no manifest permission on an extension page.
      needs: ["storage"],
      hosts: ["https://qrcallbox.com/*"],
    },

    contentScripts: [],
    webRequestFilters: [],
  },

  async register(_host) {},
};
