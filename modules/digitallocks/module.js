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

import { handlers as serviceHandlers, installDailyRefreshAlarm, onAlarm } from "./service.js";

// Alarm listener MUST be registered at top-level (SW initial execution) so
// Chrome can wake the SW on a matching alarm event. Same constraint as
// webRequest listeners — see service_worker.js for the full rationale.
chrome.alarms.onAlarm.addListener(onAlarm);

export default {
  manifest: {
    id:          "digitallocks",
    name:        "Digital Locks",
    description: "Triage digital lock unlock events for daily AP review. Imports Power BI CSV/XLSX exports, scores events against configurable risk rules, and tracks per-event review status locally.",
    version:     "0.1.0",
    status:      "beta",

    ui: {
      kind: "fullpage",
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
    permissions: {
      needs: ["storage", "tabs", "scripting", "downloads", "cookies", "alarms"],
      hosts: ["https://app.powerbi.com/*"],
    },

    contentScripts: [],
    webRequestFilters: [],
  },

  async register(_host) {
    // Install/refresh the daily auto-refresh alarm. Idempotent — chrome.alarms.create
    // replaces any prior entry with the same name.
    await installDailyRefreshAlarm();
  },
};
