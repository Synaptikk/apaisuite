// modules/licenseintake/lib/auror_person_draft_adapter.js
//
// Prepare a draft person record for Auror but NEVER auto-submit.
//
// Three handoff modes (all confirmation-gated):
//   1. clipboard           — copies a formatted block the operator pastes
//                            into Auror manually. Always safe.
//   2. aurorbuddy_create   — sends a cross-module message to AurorBuddy
//                            asking it to open /event/new and pre-fill
//                            the form (no submit click). Operator finishes
//                            and submits manually in the opened tab.
//   3. live_fill           — direct chrome.scripting.executeScript fill
//                            into an existing Auror tab. NOT IMPLEMENTED
//                            in V1; would require a dedicated content
//                            pattern. Documented for future work.
//
// Hard rule: every entry point requires `confirmed: true` in the options
// object. Calls without confirmation throw an Error before any side
// effect.

// Runs INSIDE the service worker — call sibling-module handlers via
// direct static import (chrome.runtime.sendMessage from SW doesn't
// deliver to the SW's own listener).
import { handlers as _aurorbuddy } from "../../aurorbuddy/service.js";

async function callAurorBuddy(type, payload = {}) {
  const handler = _aurorbuddy?.[type];
  if (typeof handler !== "function") {
    throw new Error(`aurorbuddy::${type} handler not found`);
  }
  const msg = { module: "aurorbuddy", type, ...payload };
  const result = await handler(msg, /* sender */ null);
  if (result && typeof result === "object" && "ok" in result) return result;
  return { ok: true, data: result };
}

/**
 * @typedef {import("./auror_search_adapter.js").createPersonDraft extends (p: infer P) => infer R ? R : never} PersonDraft
 */

const HANDOFF_MODES = Object.freeze({
  Clipboard: "clipboard",
  AurorBuddyCreate: "aurorbuddy_create",
  LiveFill: "live_fill",
});

export { HANDOFF_MODES };

/**
 * Format a person draft for clipboard / human review. Multi-line,
 * field-per-line. Returns the formatted string; caller writes to
 * navigator.clipboard.
 *
 * @param {PersonDraft} draft
 */
export function formatDraftForClipboard(draft) {
  const lines = [];
  lines.push("=== License Intake — draft person ===");
  if (draft.firstName) lines.push(`First name:   ${draft.firstName}`);
  if (draft.middleName) lines.push(`Middle name:  ${draft.middleName}`);
  if (draft.lastName)  lines.push(`Last name:    ${draft.lastName}`);
  if (draft.dob)       lines.push(`DOB:          ${draft.dob}`);
  if (draft.sex)       lines.push(`Sex:          ${draft.sex}`);
  if (draft.heightInches) {
    const ft = Math.floor(draft.heightInches / 12), inch = draft.heightInches % 12;
    lines.push(`Height:       ${ft}'${inch}" (${draft.heightInches} in)`);
  }
  if (draft.weightPounds) lines.push(`Weight:       ${draft.weightPounds} lb`);
  if (draft.licenseNumber) lines.push(`License #:    ${draft.licenseNumber}`);
  if (draft.expirationDate) lines.push(`Expires:      ${draft.expirationDate}`);
  const a = draft.address || {};
  if (a.street)        lines.push(`Street:       ${a.street}`);
  if (a.city)          lines.push(`City:         ${a.city}`);
  if (a.state)         lines.push(`State:        ${a.state}`);
  if (a.postal)        lines.push(`Postal:       ${a.postal}`);
  lines.push(`Source:       ${draft.source}`);
  lines.push("(Review and paste into Auror manually. Do not auto-submit.)");
  return lines.join("\n");
}

/**
 * Copy the draft to clipboard. Requires confirmation. Returns a
 * structured result; never throws on user denial (we report it).
 *
 * @param {PersonDraft} draft
 * @param {{ confirmed: boolean }} opts
 */
export async function copyDraftToClipboard(draft, opts) {
  requireConfirmation(opts);
  const text = formatDraftForClipboard(draft);
  try {
    await navigator.clipboard.writeText(text);
    console.info("[licenseintake/draft] clipboard write: ok");
    return { status: "ok", mode: HANDOFF_MODES.Clipboard, charsCopied: text.length };
  } catch (err) {
    const msg = err?.message || String(err);
    console.warn("[licenseintake/draft] clipboard write failed:", msg);
    return { status: "error", mode: HANDOFF_MODES.Clipboard, error: msg };
  }
}

/**
 * Ask AurorBuddy to open `/event/new` and pre-fill. AurorBuddy's
 * `create_event` handler expects a transaction-shaped payload; we
 * approximate from the license draft (no real transaction). Operator
 * sees the form in a new tab and decides whether to submit.
 *
 * Requires:
 *   - confirmed: true
 *   - The captured Auror JWT (AurorBuddy will fail gracefully if missing)
 *
 * @param {PersonDraft} draft
 * @param {{ confirmed: boolean, suspectName?: string, store?: string, dryRun?: boolean }} opts
 */
export async function handoffToAurorBuddyCreate(draft, opts) {
  requireConfirmation(opts);
  if (opts.dryRun) {
    console.info("[licenseintake/draft] dry_run: would handoff to aurorbuddy::create_event");
    return {
      status: "dry_run",
      mode: HANDOFF_MODES.AurorBuddyCreate,
      payloadShape: describePayloadShape(draft, opts),
    };
  }

  const suspectName = opts.suspectName ||
    [draft.firstName, draft.lastName].filter(Boolean).join(" ");

  // licensePersonInfo is the structured payload AurorBuddy's driveForm
  // reads to fill the Person 1 sub-form directly (no person-lookup search).
  // Kept in its own field (vs. the synthetic transaction shim) so the
  // event-flow code paths and the person-flow code paths stay decoupled.
  // scannedAt is included so AurorBuddy can set the event time to
  // (scan time − 10 minutes) per the license-intake spec.
  const licensePersonInfo = {
    firstName:     draft.firstName     || "",
    middleName:    draft.middleName    || "",
    lastName:      draft.lastName      || "",
    fullName:      suspectName,
    dob:           draft.dob           || "",   // ISO YYYY-MM-DD
    sex:           draft.sex           || "",
    heightInches:  draft.heightInches  || null, // total inches
    weightPounds:  draft.weightPounds  || null, // pounds (drives build bucket)
    licenseNumber: draft.licenseNumber || "",
    licenseState:  draft.address?.state || "",  // DL issuing state ≈ residence state
    expirationDate:draft.expirationDate || "",  // ISO YYYY-MM-DD
    street:        draft.address?.street || "",
    city:          draft.address?.city   || "",
    state:         draft.address?.state  || "",
    postal:        draft.address?.postal || "",
    source:        draft.source || "license_intake",
    scannedAt:     typeof opts.scannedAt === "number" ? opts.scannedAt : Date.now(),
  };

  // AurorBuddy::create_event expects roughly { store, transaction,
  // suspectName, personId, storeDetails }. We pass what we have; the
  // form will leave unknown fields blank. License-derived address goes
  // in the notes/extra-info field if AurorBuddy's driveForm supports it.
  const payload = {
    store: opts.store || null,
    transaction: {
      // Synthetic — license intake doesn't have a real transaction yet.
      // Populated values are surface-level; AurorBuddy treats missing
      // fields as "leave blank".
      id: null,
      date: new Date().toISOString().slice(0, 10),
      amount: null,
      lineItems: [],
      // License-derived person info for the form pre-fill (legacy keys
      // kept for backwards compat with older driveForm if rolled back).
      personDob: draft.dob,
      personLicenseNumber: draft.licenseNumber,
      personAddress: draft.address?.street,
      personCity: draft.address?.city,
      personState: draft.address?.state,
      personPostal: draft.address?.postal,
    },
    suspectName,
    personId: null,             // unknown — license-first flow
    storeDetails: null,
    licensePersonInfo,          // primary structured payload for new-person sub-form
    _source: "licenseintake",
  };

  try {
    // Direct in-SW call to aurorbuddy::create_event.
    const resp = await callAurorBuddy("create_event", payload);
    if (resp?.ok) {
      console.info("[licenseintake/draft] aurorbuddy create_event handoff: ok");
      return { status: "ok", mode: HANDOFF_MODES.AurorBuddyCreate, data: resp.data };
    }
    return {
      status: "error",
      mode: HANDOFF_MODES.AurorBuddyCreate,
      error: resp?.error || "unknown error from aurorbuddy",
    };
  } catch (err) {
    const msg = err?.message || String(err);
    console.warn("[licenseintake/draft] aurorbuddy handoff failed:", msg);
    return { status: "error", mode: HANDOFF_MODES.AurorBuddyCreate, error: msg };
  }
}

/**
 * NOT IMPLEMENTED — placeholder for future direct page-fill into an
 * existing Auror tab. Throws so accidental calls are visible.
 */
export async function fillLiveAurorTab(_draft, _opts) {
  throw new Error(
    "fillLiveAurorTab: not implemented in V1. Use copyDraftToClipboard " +
    "or handoffToAurorBuddyCreate instead. See " +
    "docs/LICENSE_INTAKE_AUROR_PAGE_INTEGRATION.md for the planned design."
  );
}

// ---------------------------------------------------------------------

function requireConfirmation(opts) {
  if (!opts || opts.confirmed !== true) {
    throw new Error(
      "Auror person draft handoff requires `confirmed: true`. " +
      "This call site is missing the explicit operator confirmation gate."
    );
  }
}

function describePayloadShape(draft, opts) {
  // Safe-to-log shape description — no field VALUES.
  return {
    hasFirstName: !!draft.firstName,
    hasLastName: !!draft.lastName,
    hasDob: !!draft.dob,
    hasLicenseNumber: !!draft.licenseNumber,
    hasAddress: !!(draft.address?.street),
    suspectNameProvided: !!opts.suspectName,
    storeProvided: !!opts.store,
  };
}
