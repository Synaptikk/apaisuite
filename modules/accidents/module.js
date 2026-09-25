// modules/accidents/module.js
//
// Accident Details — the Live Dashboard "Accident Evidence" card grown into
// a full module. One pull merges:
//   - the CAS evidence file (storage.googleapis.com/cas_storage) — the two
//     evidence reports plus the FY PNL charge tables (credits = charge
//     reversed / dispute won)
//   - Clearsight PROD (read-only GETs): claim description, cause/injury/
//     location decodes, Evidence Collection checklist, customer + witness
//     statements, attachment count — composed into one plain-text summary
//     per claim.
// Discovery record: dev/CLEARSIGHT_INTAKE_FINDINGS.md (intake) and the
// claim-read endpoints in dev/.claim-probe/ (2026-09-22).

import { handlers } from "./service.js";

export default {
  manifest: {
    id:          "accidents",
    name:        "Accident Details",
    description: "Every claim and charge for the store: what happened (from Clearsight), what evidence is still missing, and what the P&L was charged — credits flagged as reversed charges.",
    version:     "0.1.0",
    accent:      "#B45309",
    status:      "alpha",
    ui: {
      kind: "fullpage",
      icon: `
        <path d="M10 3 3.5 15.5h13L10 3z" stroke-linejoin="round"/>
        <line x1="10" y1="8" x2="10" y2="11.5"/>
        <circle cx="10" cy="13.8" r="0.4"/>
      `,
      view: () => import("./view.js"),
    },
    service: { handlers },
    permissions: {
      needs: ["storage", "tabs", "scripting"],
      hosts: ["https://storage.googleapis.com/cas_storage/*", "https://www.riskonnectclearsight.com/*"],
    },
    contentScripts: [],
  },
  async register(_host) {},
};
