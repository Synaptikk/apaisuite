// modules/licenseintake/module.js
//
// LicenseIntake — barcode-scanner-driven driver's license capture +
// Auror person search + APPRISS card cross-reference. Dry-run by
// default; all live actions confirmation-gated.

import { handlers as serviceHandlers } from "./service.js";

export default {
  manifest: {
    id:          "licenseintake",
    name:        "License Intake",
    description: "Scan a driver's license, search Auror for the person, cross-reference APPRISS for card / transaction activity, and stage a draft for operator review. Dry-run default; live actions confirmation-gated.",
    version:     "0.1.0",
    status:      "active",
    accent:      "#1e7f3a",   // muted green — distinct from AurorBuddy yellow

    ui: {
      kind: "fullpage",
      view: () => import("./view.js"),
    },
    service: {
      handlers: serviceHandlers,
    },

    permissions: {
      // `storage` for session persistence; `tabs` + `scripting` for the
      // future page-fill helper (not used in V1 — see
      // docs/LICENSE_INTAKE_AUROR_PAGE_INTEGRATION.md). `clipboardWrite`
      // for the clipboard handoff in auror_person_draft_adapter.js.
      needs: ["storage", "tabs", "scripting", "clipboardWrite"],
      hosts: [
        "https://app.us.auror.co/*",
        "https://*.auror.co/*",
        // APPRISS access goes through AurorBuddy via cross-module
        // messaging; no host_permission added here.
      ],
    },

    // Inline "Scan License" button on the Auror header. The actual
    // Chrome-recognized content_scripts declaration lives in the
    // top-level manifest.json (Chrome reads only that). This entry is
    // documentation so future maintainers see the dependency here.
    contentScripts: [
      {
        matches: ["https://app.us.auror.co/*", "https://*.auror.co/*"],
        js: ["modules/licenseintake/content/auror_inline.js"],
        runAt: "document_idle",
        allFrames: false,
      },
    ],

    // No webRequestFilters declared here — we share AurorBuddy's
    // captured `auror.jwt`. If AurorBuddy is ever removed from the
    // registry, this module will need to add its own filter to keep
    // live Auror search working. See docs/LICENSE_INTAKE_NEXT_STEPS.md.
    webRequestFilters: [],
  },

  async register(host) {
    // Extend the shared logger's forbidden-keys regex with our
    // module-specific PII fields so any payload that accidentally
    // includes licenseNumber / DOB / address gets auto-redacted in
    // structured-log lines.
    try {
      const { LOG_FORBIDDEN_KEYS_RE } = await import("./lib/redaction.js");
      host.logging?.extendForbiddenKeys?.(LOG_FORBIDDEN_KEYS_RE);
    } catch (e) {
      console.warn("[licenseintake] failed to extend forbidden keys:", e?.message || e);
    }
  },
};
