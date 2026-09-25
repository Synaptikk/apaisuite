// modules/costinventory/module.js
//
// Cost Inventory — the monthly Fresh cost inventory worksheet, filled from the
// systems that already hold the numbers.
//
// The worksheet (Cost-Inventory-Calculator-Worksheet.xlsx) has 25 typed-in
// cells across four departments. Exactly one of them still has to be typed:
// the Cost Inventory App total, which lives on a phone and only exists on the
// day. Everything else is pulled; Claims and Fuel Station are retired rows the
// app now handles, carried as zeros so the workbook's formulas stay intact.
//
// No alarms: this is a monthly, deliberate act, not a background poll.

// STATIC import — an MV3 service worker cannot dynamic-import, so the handlers
// object must already exist by the time the SW boots. Only view.js is lazy.
import { handlers } from "./service.js";

export default {
  manifest: {
    id:          "costinventory",
    name:        "Cost Inventory",
    description: "Fills the monthly Fresh cost inventory worksheet from OneWalmart, the Ops Portal ITR, CaseVisibility and GDP Connect — and exports it as the store's own xlsx.",
    version:     "0.1.0",
    status:      "alpha",
    accent:      "#0071CE",

    ui: {
      kind: "fullpage",
      // Inner markup of a 20x20 stroke glyph; the shell supplies the viewBox,
      // stroke width and currentColor (app.js::iconSvgString). A clipboard
      // with a rule across it — a count sheet.
      icon: `
        <rect x="4.5" y="3.5" width="11" height="13" rx="1.6"/>
        <path d="M7.8 3.5V2.6h4.4v0.9"/>
        <path d="M7.2 8.2h5.6M7.2 11h5.6M7.2 13.6h3.2"/>
      `,
      view: () => import("./view.js"),
    },

    service: { handlers },

    // The Authorization header GDP Connect's dashboard sends to its query API.
    // Captured declaratively by the shell SW (background/service_worker.js
    // walks this array at boot) and replayed from service.js — the same shape
    // safetyagent uses for its SafePass token. Nothing else can call that API:
    // it is bearer-only, cookies are not accepted.
    webRequestFilters: [
      {
        urls: ["https://api-manager-next.gdp.api.walmart.com/*"],
        headerName: "authorization",
        storageKey: "gdp.bearer",
        ttlMs: 30 * 60 * 1000,
      },
    ],

    // Informational only — the real grant is the top-level manifest.json.
    permissions: {
      needs: ["storage", "tabs", "scripting", "webRequest"],
      hosts: [
        "https://one.walmart.com/*",
        "https://hoops.wal-mart.com/*",
        "https://radapps3.wal-mart.com/Protected/CaseVisibility/*",
        "https://gdp-connect.walmart.com/*",
        "https://api-manager-next.gdp.api.walmart.com/*",
      ],
    },
  },

  async register(_host) {},
};
