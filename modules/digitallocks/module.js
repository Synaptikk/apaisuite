// modules/digitallocks/module.js
//
// DigitalLocks — daily AP review tool for digital lock unlock events.
//
// V1 workflow is fully local: the user exports a Power BI report to CSV/XLSX,
// imports the file via the module UI, and the analysis (parsing, risk
// scoring, persistence, status overlay, daily-checklist export) runs
// entirely client-side in the shell page context. No SW work, no network
// calls, no host permissions added beyond what the suite already declares.
//
// Triage framing: the module never labels users as guilty. All language is
// "needs review", "unusual", "high-risk event", "role/zone mismatch",
// "after-hours activity". The risk score is a prioritization hint with
// every contributing rule shown, never a verdict. See
// docs/DIGITAL_LOCKS_MODULE.md::Disposition language.
//
// Storage split (per audit decision 2026-06-01):
//   - IndexedDB ("apaisuite-digitallocks") holds immutable per-import
//     record sets keyed by importId. One putImport per file import.
//   - host.storage.local ("digitallocks.status.<eventId>") holds the
//     mutable review-status overlay. Status edits don't rewrite the
//     entire import blob; the table merges import + overlay at render.

import { IS_SERVICE_WORKER } from "../../shared/alarms.js";
import { handlers as serviceHandlers, installDailyRefreshAlarm, onAlarm } from "./service.js";

// Alarm wiring is service-worker-only, and lives at top level rather than in
// register(). Both halves matter — see shared/alarms.js:
//   · top level, because register() is called from app.js when the shell
//     mounts a module and never runs in the SW at all;
//   · gated, because this file is imported by the shell page too, and
//     extension pages receive chrome.alarms events — an ungated listener
//     would run onAlarm once in the SW and once in every open suite tab.
if (IS_SERVICE_WORKER) {
  chrome.alarms.onAlarm.addListener(onAlarm);
  installDailyRefreshAlarm().catch((e) =>
    console.warn("[digitallocks] installDailyRefreshAlarm failed:", e?.message ?? e));
}

export default {
  manifest: {
    id:          "digitallocks",
    name:        "Digital Locks",
    description: "Triage digital lock unlock events for daily AP review. Imports Power BI CSV/XLSX exports, scores events against configurable risk rules, and tracks per-event review status locally.",
    version:     "0.1.0",
    status:      "beta",

    ui: {
      kind: "fullpage",
      // Sidebar + home-card glyph: the INNER markup of a 20x20 stroke icon.
      // The shell wraps it (app.js::iconSvgString) so every module shares one
      // viewBox, stroke width and currentColor. Omit it and the shell falls
      // back to the generic grid glyph.
      icon: `
        <rect x="4" y="8.8" width="12" height="8" rx="2"/>
        <path d="M7.1 8.8V6.4a2.9 2.9 0 0 1 5.8 0v2.4"/>
        <circle cx="10" cy="12.4" r="1.15" fill="currentColor" stroke="none"/>
        <path d="M10 13.5v1.3" stroke-linecap="round"/>
      `,
      view: () => import("./view.js"),
    },
    service: {
      handlers: serviceHandlers,
    },

    // V1 UI runs locally; the SW handler `searchByStore` opens (or finds)
    // a background tab on the Power BI report, then chrome.scripting injects
    // content/powerbi_driver.js to drive the per-visual Export-to-Excel
    // flow. chrome.downloads.onCreated captures the resulting .xlsx and
    // hands the bytes back to the view's existing parser. Same pattern as
    // claimsdisposition's tab-driven Looker pull.
    // wd504.myworkday.com is the tenure lookup (lookupAssociate): the SW
    // drives its OWN background Workday tab to a directory search and reads
    // "Length of Service" out of the rendered page. It is read-only — nothing
    // is submitted, and the tab is never one the user opened.
    // liveaccess.invue.walmart.com backs the Users-audit tab's InVue fetch;
    // it was already granted in the top-level manifest but missing from this
    // informational list.
    permissions: {
      needs: ["storage", "tabs", "scripting", "downloads", "cookies", "alarms"],
      hosts: [
        "https://app.powerbi.com/*",
        "https://prod.liveaccess.invue.walmart.com/*",
        "https://wd504.myworkday.com/*",
      ],
    },

    contentScripts: [],
    webRequestFilters: [],
  },

  // The daily auto-refresh alarm is installed at top level above, in the
  // service worker. Kept as a no-op: register() is part of the module
  // contract and shell-side setup belongs here, not the alarm.
  async register(_host) {},
};
